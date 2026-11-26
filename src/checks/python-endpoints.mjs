// Finds the HTTP endpoints of Python projects: Flask (and Quart, Sanic), FastAPI, Starlette, aiohttp
// (Teams bots included) and Azure Functions. Unlike Next.js, Python routes are declared in the code
// (@app.post("/x"), app.router.add_post("/x", handler)...), so each file is parsed as text.
// Reads files through git only: nothing is imported, installed or run.
import { posix } from "node:path";
import { git } from "../util.mjs";
import { checksMicrosoftLogin } from "./sso.mjs";

const SKIP_DIR_RE = /(^|\/)(\.?venv|env|site-packages|__pycache__|node_modules|tests?|\.tox|build|dist)\//;
const TEST_FILE_RE = /(^|\/)(test_[^/]*|[^/]*_test|conftest)\.py$/;
const FRAMEWORK_RE = /^[ \t]*(?:from|import)[ \t]+(flask|fastapi|starlette|aiohttp|quart|sanic|azure\.functions|azure[ \t]+import[ \t]+functions)\b/m;
const MAX_HELPER_FILES = 25;
const HELPER_DEPTH = 2;
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

/** Framework of an object created in the file (app = Flask(...), router = APIRouter(...)). */
const CTOR_KIND = {
  Flask: "flask", Quart: "quart", Sanic: "sanic",
  FastAPI: "fastapi", APIRouter: "fastapi",
  Starlette: "starlette",
  RouteTableDef: "aiohttp", Application: "aiohttp",
  FunctionApp: "azure-function", AsgiFunctionApp: "azure-function", WsgiFunctionApp: "azure-function",
};
const SECURITY_SCHEMES = "OAuth2PasswordBearer|OAuth2AuthorizationCodeBearer|HTTPBearer|HTTPBasic|HTTPDigest|APIKeyHeader|APIKeyQuery|APIKeyCookie|OpenIdConnect";

// ---------------------------------------------------------------- text helpers

/** Removes # comments outside strings (single-line strings only; good enough for route detection). */
export function stripPyComments(text) {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => {
      let quote = null;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (quote) {
          if (c === "\\") i++;
          else if (c === quote) quote = null;
        } else if (c === '"' || c === "'") quote = c;
        else if (c === "#") return line.slice(0, i).trimEnd();
      }
      return line;
    })
    .join("\n");
}

const withoutStrings = (s) => s.replace(/(["'])(?:\\.|(?!\1).)*\1/g, '""');
const indentOf = (line) => line.match(/^[ \t]*/)[0].length;

/** Text between the parenthesis at `open` and its match. */
function balanced(text, open) {
  let depth = 0;
  let quote = null;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if ("([{".includes(c)) depth++;
    else if (")]}".includes(c) && --depth === 0) return text.slice(open + 1, i);
  }
  return text.slice(open + 1);
}

/** Splits call arguments at top-level commas: { positional: [...], keywords: {name: text} }. */
function parseArgs(argText) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let start = 0;
  for (let i = 0; i < argText.length; i++) {
    const c = argText[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if (c === "," && depth === 0) {
      parts.push(argText.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(argText.slice(start));
  const positional = [];
  const keywords = {};
  for (const p of parts.map((s) => s.trim()).filter(Boolean)) {
    const kw = p.match(/^([A-Za-z_]\w*)\s*=(?!=)\s*([\s\S]*)$/);
    if (kw) keywords[kw[1]] = kw[2];
    else positional.push(p);
  }
  return { positional, keywords };
}

/** The value of a Python string literal, or null if it is not one. */
function literal(expr) {
  const m = expr?.trim().match(/^[rRbBuUfF]{0,2}(["'])((?:\\.|(?!\1).)*)\1$/);
  return m ? m[2] : null;
}

function methodsIn(expr) {
  if (!expr) return [];
  return [...new Set([...expr.matchAll(new RegExp(`\\b(${METHODS.join("|")})\\b`, "gi"))].map((m) => m[1].toUpperCase()))];
}

const lineAt = (text, idx) => text.slice(0, idx).split("\n").length;

// ---------------------------------------------------------------- file structure

/** Lines that start inside a triple-quoted string (prompts, docstrings): their indentation means nothing. */
function insideStrings(lines) {
  const inside = new Array(lines.length).fill(false);
  let open = null;
  lines.forEach((line, i) => {
    inside[i] = open !== null;
    let pos = 0;
    for (;;) {
      if (open) {
        const close = line.indexOf(open, pos);
        if (close < 0) break;
        pos = close + 3;
        open = null;
      } else {
        const m = line.slice(pos).match(/"""|'''/);
        if (!m) break;
        open = m[0];
        pos += m.index + 3;
      }
    }
  });
  return inside;
}

/** Functions and classes (any depth), plus top-level statements, with their text. */
function structure(text) {
  const lines = text.split("\n");
  const inString = insideStrings(lines);
  const defs = []; // { name, indent, start, end, text, kind }
  const topLevel = []; // { names, text }
  for (let i = 0; i < lines.length; i++) {
    if (inString[i]) continue;
    const m = lines[i].match(/^([ \t]*)(?:async[ \t]+)?(def|class)[ \t]+([A-Za-z_]\w*)/);
    if (!m) continue;
    const indent = m[1].length;
    // Decorators directly above belong to the function.
    let first = i;
    while (first > 0 && /^[ \t]*@/.test(lines[first - 1])) first--;
    // The signature may span several lines (black puts the closing parenthesis at the def's indent).
    let j = i;
    let depth = 0;
    for (; j < lines.length; j++) {
      const s = withoutStrings(lines[j]);
      depth += (s.match(/[([{]/g) ?? []).length - (s.match(/[)\]}]/g) ?? []).length;
      if (depth <= 0 && /:\s*$/.test(s)) break;
    }
    let end = j + 1;
    while (end < lines.length && (lines[end].trim() === "" || inString[end] || indentOf(lines[end]) > indent)) end++;
    defs.push({ name: m[3], kind: m[2], indent, start: first, defLine: i, end, text: lines.slice(first, end).join("\n") });
  }
  // Top-level statements other than def/class/import: assignments the handler may use (ADAPTER = ...).
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || inString[i] || indentOf(line) > 0 || /^(?:@|def\b|async\b|class\b|import\b|from\b)/.test(line)) continue;
    let end = i + 1;
    let depth = (withoutStrings(line).match(/[([{]/g) ?? []).length - (withoutStrings(line).match(/[)\]}]/g) ?? []).length;
    while (end < lines.length && (depth > 0 || inString[end] || (lines[end].trim() !== "" && indentOf(lines[end]) > 0))) {
      const s = withoutStrings(lines[end]);
      depth += (s.match(/[([{]/g) ?? []).length - (s.match(/[)\]}]/g) ?? []).length;
      end++;
    }
    const names = [...line.matchAll(/^([A-Za-z_]\w*)(?:\s*,\s*([A-Za-z_]\w*))*\s*(?::[^=\n]*)?=(?!=)/g)].flatMap((m) => [m[1], m[2]].filter(Boolean));
    topLevel.push({ names, text: lines.slice(i, end).join("\n") });
    i = end - 1;
  }
  return { lines, defs, topLevel };
}

/** Imports of a file: alias -> { module, name, level }. */
function importsOf(text) {
  const out = new Map();
  for (const m of text.matchAll(/^[ \t]*import[ \t]+([^\n]+)/gm))
    for (const part of m[1].split(",")) {
      const [mod, alias] = part.trim().split(/\s+as\s+/);
      if (!mod || !/^[\w.]+$/.test(mod)) continue;
      out.set(alias ?? mod.split(".")[0], { module: mod, name: null, level: 0 });
    }
  for (const m of text.matchAll(/^[ \t]*from[ \t]+(\.*)([\w.]*)[ \t]+import[ \t]+(\([^)]*\)|[^\n]+)/gm)) {
    const names = m[3].replace(/[()\\]/g, " ");
    for (const part of names.split(",")) {
      const [name, alias] = part.trim().split(/\s+as\s+/);
      if (!name || name === "*" || !/^\w+$/.test(name)) continue;
      out.set(alias ?? name, { module: m[2], name, level: m[1].length });
    }
  }
  return out;
}

/** Local file for an import, or null when it is a package. */
function resolveModule(imp, from, files) {
  const tryBase = (base) => {
    for (const c of [`${base}.py`, `${base}/__init__.py`]) if (files.has(c)) return c;
    return null;
  };
  const withName = (base) => (imp.name && tryBase(base ? `${base}/${imp.name}` : imp.name)) || (base && tryBase(base));
  if (imp.level > 0) {
    let dir = posix.dirname(from);
    for (let i = 1; i < imp.level; i++) dir = posix.dirname(dir);
    if (dir === ".") dir = "";
    const rel = imp.module.replace(/\./g, "/");
    return withName([dir, rel].filter(Boolean).join("/")) ?? null;
  }
  const rel = imp.module.replace(/\./g, "/");
  // Repo root, then the importing file's ancestors (src layouts, apps in subfolders).
  const roots = [""];
  for (let d = posix.dirname(from); d && d !== "."; d = posix.dirname(d)) roots.push(d);
  roots.push("src");
  for (const root of roots) {
    const hit = withName(root ? `${root}/${rel}` : rel);
    if (hit) return hit;
  }
  return null;
}

// ---------------------------------------------------------------- discovery

/**
 * All Python endpoints on a commit. Returns, per endpoint: kind (framework), route, label
 * (methods + route), methods, path, line, own (the handler and the same-file code it uses),
 * helpers (local modules it uses, a few levels deep), packages (Python modules), and the
 * access the framework itself provides (router-level dependency, middleware, function key, Bot Framework adapter).
 */
export function findPythonEndpoints(dir, sha, files, { authNames = [] } = {}) {
  const fileSet = new Set(files);
  const cache = new Map();
  const read = (p) => {
    if (!cache.has(p)) cache.set(p, stripPyComments(git(dir, ["cat-file", "blob", `${sha}:${p}`], { allowFail: true }) ?? ""));
    return cache.get(p);
  };
  const pyFiles = files.filter((f) => f.endsWith(".py") && !SKIP_DIR_RE.test(f) && !TEST_FILE_RE.test(f));
  const candidates = pyFiles.filter((f) => FRAMEWORK_RE.test(read(f)) || /\bFastMCP\s*\(/.test(read(f)));
  if (!candidates.length) return [];

  const words = authNames.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") || "$^";

  // Routers whose include_router(..., dependencies=[Depends(auth)]) adds a login check, by module name.
  const authedModules = new Set();
  for (const f of pyFiles) {
    const t = read(f);
    for (const m of t.matchAll(/\binclude_router\s*\(/g)) {
      const args = parseArgs(balanced(t, m.index + m[0].length - 1));
      if (!args.keywords.dependencies || !new RegExp(`\\b(?:${words}|${SECURITY_SCHEMES})\\b`).test(args.keywords.dependencies)) continue;
      const target = args.positional[0]?.split(".");
      if (target) authedModules.add(target.length > 1 ? target.at(-2) : target[0]);
    }
  }

  // aiohttp middlewares and Flask before_request handlers that check the login, for the whole app.
  let appWideAuth = null;
  for (const f of candidates) {
    const t = read(f);
    for (const m of t.matchAll(/\bApplication\s*\(/g)) {
      const mw = parseArgs(balanced(t, m.index + m[0].length - 1)).keywords.middlewares ?? "";
      if (new RegExp(`\\b(?:${words})\\b|auth`, "i").test(mw)) appWideAuth = "login check (middleware)";
    }
  }

  const endpoints = [];
  for (const path of candidates) {
    const text = read(path);
    const { lines, defs, topLevel } = structure(text);
    const imports = importsOf(text);
    const fileFramework = (text.match(FRAMEWORK_RE)?.[1] ?? "").replace(/^azure.*/, "azure-function");

    // Objects created in this file: framework, URL prefix, login checks applied to all their routes.
    const objects = new Map();
    for (const m of text.matchAll(/^[ \t]*([A-Za-z_]\w*)\s*(?::[^=\n]*)?=\s*([\w.]+)\s*\(/gm)) {
      const ctor = m[2].split(".").at(-1);
      let kind = CTOR_KIND[ctor];
      if (ctor === "Blueprint") kind = /^func\b|azure/.test(m[2]) || fileFramework === "azure-function" ? "azure-function" : fileFramework || "flask";
      if (!kind) continue;
      const args = parseArgs(balanced(text, m.index + m[0].length - 1));
      const prefix = literal(args.keywords.url_prefix ?? args.keywords.prefix) ?? "";
      const deps = args.keywords.dependencies ?? "";
      const authLevel = args.keywords.http_auth_level?.match(/AuthLevel\.(\w+)/)?.[1]?.toUpperCase();
      objects.set(m[1], { kind, prefix, deps, authLevel });
    }
    // FastAPI security schemes declared in the file (oauth2_scheme = OAuth2PasswordBearer(...)).
    const schemeVars = [...text.matchAll(new RegExp(`^[ \\t]*([A-Za-z_]\\w*)\\s*=\\s*(?:[\\w.]+\\.)?(?:${SECURITY_SCHEMES})\\s*\\(`, "gm"))].map((m) => m[1]);
    const authAlt = [words, SECURITY_SCHEMES, ...schemeVars].filter(Boolean).join("|");
    const authRe = new RegExp(`@\\s*(?:[\\w.]+\\.)?(?:${authAlt})\\b|\\b(?:Depends|Security)\\(\\s*(?:[\\w.]+\\.)?(?:${authAlt})\\b|\\b(?:${words})\\s*\\(`);
    // Flask: @bp.before_request that checks the login covers every route of that blueprint (or app).
    const beforeAuth = new Set();
    for (const d of defs)
      for (const m of d.text.matchAll(/@\s*([A-Za-z_]\w*)\.before_(?:app_)?request\b/g))
        if (authRe.test(d.text.replace(/@[^\n]*\n/g, "")) || /\babort\(\s*40[13]\b/.test(d.text)) beforeAuth.add(m[1]);

    // Microsoft SSO helpers: names imported from a local module, or defined here, whose code checks the
    // caller's Microsoft token (or the App Service sign-in headers). Using one counts as a login check.
    const ssoNames = [];
    for (const [alias, imp] of imports) {
      const local = resolveModule(imp, path, fileSet);
      if (local && checksMicrosoftLogin(read(local))) ssoNames.push(alias);
    }
    for (const d of defs) if (d.indent === 0 && checksMicrosoftLogin(d.text)) ssoNames.push(d.name);
    const ssoRe = ssoNames.length
      ? new RegExp(`@\\s*(?:${ssoNames.join("|")})\\b|\\b(?:Depends|Security)\\(\\s*(?:${ssoNames.join("|")})\\b|(?<![.\\w])(?:${ssoNames.join("|")})(?:\\.\\w+)*\\s*\\(`)
      : null;

    const fileAuthed = authedModules.has(posix.basename(path, ".py"));
    const add = (ep) => {
      const src = sourceFor(ep.handlerText ?? "", ep.handlerName);
      const known = authRe.test(src.own);
      const sso = !known && (checksMicrosoftLogin(src.own) || Boolean(ssoRe?.test(src.own)));
      endpoints.push({ ...ep, path, ...src, hasAuth: known || sso, authLabel: sso ? "login check (Microsoft SSO)" : null });
    };

    // What the handler runs, like the JavaScript check reads a route file and its imports: the
    // handler, the same-file functions it calls and objects it reads (own), then the local modules
    // behind the names it uses, two levels deep (helpers), and the packages they import.
    const sourceFor = (handlerText, handlerName) => {
      let own = handlerText;
      const included = new Set(handlerName ? [handlerName] : []);
      for (let round = 0; round < 3; round++) {
        let grew = false;
        // Functions are followed when called (not obj.chat...), classes and objects when named.
        for (const d of defs.filter((x) => x.indent === 0 && !included.has(x.name)))
          if (new RegExp(d.kind === "def" ? `(?<![.\\w])${d.name}\\s*\\(` : `(?<![.\\w])${d.name}\\b`).test(own)) {
            included.add(d.name);
            own += `\n${d.text}`;
            grew = true;
          }
        for (const s of topLevel)
          if (s.names.length && !s.names.every((n) => included.has(n)) && s.names.some((n) => new RegExp(`(?<![.\\w])${n}\\b`).test(own))) {
            s.names.forEach((n) => included.add(n));
            own += `\n${s.text}`;
            grew = true;
          }
        if (!grew) break;
      }
      const packages = new Set();
      const helperTexts = [];
      const seen = new Set([path]);
      let frontier = [];
      const visit = (imp, from, next) => {
        const local = resolveModule(imp, from, fileSet);
        if (local === null) {
          if (imp.level === 0) packages.add(imp.name ? `${imp.module}.${imp.name}` : imp.module);
        } else if (!seen.has(local) && seen.size < MAX_HELPER_FILES) {
          seen.add(local);
          next.push(local);
        }
      };
      for (const [alias, imp] of imports) if (new RegExp(`(?<![.\\w])${alias}\\b`).test(own)) visit(imp, path, frontier);
      for (let depth = 0; depth < HELPER_DEPTH && frontier.length; depth++) {
        const next = [];
        for (const f of frontier) {
          const t = read(f);
          helperTexts.push(t);
          if (depth < HELPER_DEPTH - 1) for (const imp of importsOf(t).values()) visit(imp, f, next);
        }
        frontier = next;
      }
      return { own, helpers: helperTexts.join("\n"), packages };
    };

    const handlerByName = (expr) => {
      const name = expr?.trim().split(".").at(-1)?.replace(/\(.*$/, "");
      if (!name || !/^\w+$/.test(name)) return { handlerText: "", handlerName: null };
      const d = defs.find((x) => x.name === name && x.indent === 0) ?? defs.find((x) => x.name === name);
      return { handlerText: d?.text ?? "", handlerName: d ? name : null };
    };

    const accessFor = (obj, decoratorArgs) => {
      if (obj?.kind === "azure-function") {
        const level = (decoratorArgs?.keywords.auth_level?.match(/AuthLevel\.(\w+)/)?.[1] ?? obj.authLevel ?? "FUNCTION").toUpperCase();
        return level === "ANONYMOUS" ? { anonymousFunction: true } : { platformAuth: "Azure function key" };
      }
      if (obj?.deps && authRe.test(obj.deps)) return { routerAuth: "login check (router)" };
      if (fileAuthed) return { routerAuth: "login check (router)" };
      return {};
    };

    // 1. Decorators: @app.route("/x"), @router.post("/x"), @routes.get("/x"), @app.route(route="x")
    for (const m of text.matchAll(/^[ \t]*@\s*([A-Za-z_][\w.]*)\.(route|api_route|get|post|put|patch|delete|head|options|websocket)\s*\(/gm)) {
      const objName = m[1].split(".").at(-1);
      const obj = objects.get(objName) ?? (fileFramework ? { kind: fileFramework, prefix: "", deps: "" } : null);
      if (!obj) continue;
      const args = parseArgs(balanced(text, m.index + m[0].length - 1));
      const member = m[2];
      const line = lineAt(text, m.index);
      const d = defs.find((x) => x.start <= line - 1 && x.defLine >= line - 1);
      if (!d) continue;
      let route;
      let methods;
      if (obj.kind === "azure-function") {
        route = `/api/${(literal(args.keywords.route ?? args.positional[0]) ?? d.name).replace(/^\//, "")}`;
        methods = methodsIn(args.keywords.methods);
        if (!methods.length) methods = ["ANY"];
      } else if (obj.kind === "aiohttp" && member === "route") {
        methods = [literal(args.positional[0])?.toUpperCase() ?? "ANY"].map((x) => (x === "*" ? "ANY" : x));
        route = literal(args.positional[1] ?? args.keywords.path);
      } else {
        route = literal(args.positional[0] ?? args.keywords.path ?? args.keywords.rule);
        if (member === "websocket") methods = ["WS"];
        else if (member === "route" || member === "api_route") {
          methods = methodsIn(args.keywords.methods);
          if (!methods.length) methods = ["GET"];
        } else methods = [member.toUpperCase()];
      }
      if (route === null || route === undefined) continue;
      if (obj.kind !== "azure-function") route = joinRoute(obj.prefix, route);
      const access = accessFor(obj, args);
      if (beforeAuth.has(objName)) access.routerAuth = "login check (before_request)";
      add({ kind: obj.kind, route, methods, line, handlerText: d.text, handlerName: d.name, ...access });
    }

    // 2. Registrations: app.router.add_post("/x", handler), web.post("/x", handler),
    //    app.add_url_rule("/x", view_func=f), app.add_api_route("/x", f), Route("/x", f)
    const registrations = [
      { re: /\b([A-Za-z_][\w.]*)\.router\.add_(get|post|put|patch|delete|head|route|view)\s*\(/g, kind: "aiohttp" },
      { re: /\bweb\.(get|post|put|patch|delete|head|route|view)\s*\(/g, kind: "aiohttp", noObj: true },
      { re: /\b([A-Za-z_][\w.]*)\.add_url_rule\s*\(/g, kind: "flask", member: "url_rule" },
      { re: /\b([A-Za-z_][\w.]*)\.add_api_route\s*\(/g, kind: "fastapi", member: "api_route" },
      { re: /\b(?:Route|Mount)\s*\(/g, kind: "starlette", member: "starlette" },
    ];
    for (const { re, kind, noObj, member: fixed } of registrations) {
      for (const m of text.matchAll(re)) {
        const member = fixed ?? (noObj ? m[1] : m[2]);
        if (member === "starlette" && !/^[ \t]*(?:from|import)[ \t]+starlette/m.test(text)) continue;
        if (member === "starlette" && m[0].startsWith("Mount")) continue;
        const args = parseArgs(balanced(text, m.index + m[0].length - 1));
        let route;
        let methods;
        let handlerExpr;
        if (member === "route") {
          methods = [literal(args.positional[0]) ?? "ANY"].map((x) => (x === "*" ? "ANY" : x.toUpperCase()));
          route = literal(args.positional[1]);
          handlerExpr = args.positional[2] ?? args.keywords.handler;
        } else if (member === "view") {
          methods = ["ANY"];
          route = literal(args.positional[0]);
          handlerExpr = args.positional[1] ?? args.keywords.handler;
        } else if (member === "url_rule") {
          route = literal(args.positional[0] ?? args.keywords.rule);
          handlerExpr = args.keywords.view_func ?? args.positional[2];
          methods = methodsIn(args.keywords.methods);
          if (!methods.length) methods = ["GET"];
        } else if (member === "api_route" || member === "starlette") {
          route = literal(args.positional[0] ?? args.keywords.path);
          handlerExpr = args.keywords.endpoint ?? args.positional[1];
          methods = methodsIn(args.keywords.methods);
          if (!methods.length) methods = ["GET"];
        } else {
          route = literal(args.positional[0] ?? args.keywords.path);
          handlerExpr = args.positional[1] ?? args.keywords.handler;
          methods = [member.toUpperCase()];
        }
        if (route === null || route === undefined) continue;
        const objName = noObj || member === "starlette" ? null : m[1].split(".").at(-1);
        const obj = objName ? objects.get(objName) : null;
        route = joinRoute(obj?.prefix ?? "", route);
        const access = accessFor(obj, null);
        if (objName && beforeAuth.has(objName)) access.routerAuth = "login check (before_request)";
        add({ kind: obj?.kind ?? kind, route, methods, line: lineAt(text, m.index), ...handlerByName(handlerExpr), ...access });
      }
    }

    // 3. MCP servers over HTTP (FastMCP): one endpoint reaches every tool in the file. A server run
    //    over stdio is local only and is not an endpoint.
    for (const m of text.matchAll(/^[ \t]*([A-Za-z_]\w*)\s*=\s*(?:[\w.]+\.)?FastMCP\s*\(/gm)) {
      const name = m[1];
      const ctorArgs = balanced(text, m.index + m[0].length - 1);
      const transport = new RegExp(`\\b${name}\\.run\\s*\\(([^)]*)\\)`).exec(text)?.[1].match(/transport\s*=\s*["']([\w-]+)["']/)?.[1];
      const appCall = new RegExp(`\\b${name}\\.(streamable_http_app|http_app|sse_app)\\s*\\(`).exec(text);
      if (!appCall && !/http|sse/.test(transport ?? "")) continue;
      const sse = appCall ? appCall[1] === "sse_app" : transport === "sse";
      const mount = appCall ? new RegExp(`\\.mount\\(\\s*["']([^"']*)["']\\s*,\\s*${name}\\.`).exec(text)?.[1] : null;
      const auth = /\b(?:auth|token_verifier|auth_server_provider)\s*=\s*(?!None\b)\w/.test(ctorArgs);
      endpoints.push({
        kind: "mcp",
        route: joinRoute(mount ?? "", sse ? "sse" : "mcp"),
        methods: ["ANY"],
        line: lineAt(text, m.index),
        path,
        ...sourceFor(text, null),
        hasAuth: auth,
        authLabel: auth ? "login check (MCP auth)" : null,
      });
    }

    // Flask/Quart: an app-level before_request check covers the blueprints too.
    if ([...beforeAuth].some((n) => ["flask", "quart", "sanic"].includes(objects.get(n)?.kind) && /^(?:Flask|Quart|Sanic)$/.test(ctorOf(text, n))))
      appWideAuth ??= "login check (before_request)";
  }
  if (appWideAuth)
    for (const ep of endpoints)
      if (!ep.routerAuth && !ep.platformAuth && ["aiohttp", "flask", "quart", "sanic"].includes(ep.kind)) ep.routerAuth = appWideAuth;

  // Teams / Bot Framework: the adapter checks that requests really come from Microsoft.
  for (const ep of endpoints) {
    const all = `${ep.own}\n${ep.helpers}`;
    if (/\.process_activity\s*\(|\badapter\.process\s*\(|\bADAPTER\.process\s*\(/i.test(ep.own) && /BotFrameworkAdapter|CloudAdapter|BotFrameworkHttpAdapter|botbuilder/.test(all))
      ep.botAuth = true;
  }
  return endpoints.map(({ handlerText, handlerName, ...ep }) => ep);
}


function ctorOf(text, name) {
  return text.match(new RegExp(`^[ \\t]*${name}\\s*(?::[^=\\n]*)?=\\s*(?:[\\w.]+\\.)?(\\w+)\\s*\\(`, "m"))?.[1] ?? "";
}

function joinRoute(prefix, route) {
  const joined = `${prefix ?? ""}/${route}`.replace(/\/{2,}/g, "/");
  return joined.length > 1 ? joined.replace(/\/$/, "") || "/" : "/";
}
