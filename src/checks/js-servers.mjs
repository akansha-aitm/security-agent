// Finds the HTTP endpoints of JavaScript/TypeScript servers whose routes are declared in code:
// Express, Fastify, Hono, Koa (app.get("/x", ...)), NestJS (@Controller + @Get) and Azure
// Functions (v4 app.http(...), v3 function.json). Like the Python finder, each endpoint gets the
// code it runs (own: the route call, the middleware applied before it and the same-file functions
// it uses), the local modules it imports (helpers, two levels) and the packages they use.
// Reads files through git only: nothing is installed, built or run.
import { posix } from "node:path";
import { git } from "../util.mjs";
import { checksMicrosoftLogin } from "./sso.mjs";

const CODE_RE = /\.[cm]?[jt]sx?$/;
const SKIP_RE = /(^|\/)(node_modules|\.next|dist|build|out|coverage|\.vercel|__tests__|__mocks__|tests?|e2e)\//;
const TEST_RE = /\.(?:test|spec)\.[cm]?[jt]sx?$|\.d\.ts$/;
const FRAMEWORK_RE =
  /(?:\bfrom\s*|\brequire\(\s*)["'](express|fastify|hono|hono\/[\w-]+|@hono\/[\w-]+|koa-router|@koa\/router|@nestjs\/common|@azure\/functions)["']/;
const ROUTE_METHODS = "get|post|put|patch|delete|all|options|head";
const CTOR_KIND = { express: "express", Router: "express", Hono: "hono", OpenAPIHono: "hono", Fastify: "fastify", fastify: "fastify", KoaRouter: "koa" };
const FALLBACK_OBJECTS = ["app", "router", "server", "fastify", "routes"];
// Guards whose name says they check the user (not ThrottlerGuard and the like).
const AUTH_GUARD_RE = /auth|jwt|session|clerk|supabase|entra|azure|login|bearer|api_?key|user/i;
const PUBLIC_DECORATOR_RE = /@(?:Public|SkipAuth|AllowAnonymous|IsPublic)\s*\(/;
// Middleware whose name says it checks the user: authMiddleware, isAuthenticated, verifyToken, passport...
// (express-session's session() only stores a session, it checks nothing.)
const AUTH_MIDDLEWARE_RE = /(?<![\w$])[\w$.]*(?:[Aa]uth|[Jj]wt|JWT|[Ll]ogin|[Pp]rotect|[Pp]assport|[Cc]lerk|[Gg]uard|[Vv]erify(?:Token|User|Jwt|Session))[\w$]*/;
const HOOK_PROPS = ["preHandler", "onRequest", "preValidation", "beforeHandler"];

/** Fastify route options: only the hooks run before the handler say anything about the login. */
const hooksOf = (optsText) => HOOK_PROPS.map((p) => prop(optsText, p)).filter(Boolean).join(", ");

// ---------------------------------------------------------------- text helpers

export function stripJsComments(text) {
  return text.replace(/\r\n?/g, "\n").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

/** Text between the bracket at `open` and its match, skipping strings. */
function balanced(text, open) {
  let depth = 0;
  let quote = null;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'" || c === "`") quote = c;
    else if ("([{".includes(c)) depth++;
    else if (")]}".includes(c) && --depth === 0) return text.slice(open + 1, i);
  }
  return text.slice(open + 1);
}

/** Call arguments split at top-level commas. */
function splitArgs(text) {
  const out = [];
  let depth = 0;
  let quote = null;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'" || c === "`") quote = c;
    else if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if (c === "," && depth === 0) {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  out.push(text.slice(start));
  return out.map((s) => s.trim()).filter(Boolean);
}

/** The value of a plain string literal ('x', "x", `x` without ${}), or null. */
function literal(expr) {
  const m = expr?.trim().match(/^(["'`])((?:\\.|(?!\1).)*)\1$/);
  return m && !(m[1] === "`" && m[2].includes("${")) ? m[2] : null;
}

/** A property of an object literal written as text: { route: "x", authLevel: "anonymous" }. */
function prop(objText, name) {
  const m = objText.match(new RegExp(`(?:^|[{,\\s])${name}\\s*:\\s*`));
  if (!m) return null;
  const rest = objText.slice(m.index + m[0].length);
  return splitArgs(`${rest}`)[0] ?? null;
}

const lineAt = (text, idx) => text.slice(0, idx).split("\n").length;
const refRe = (name) => new RegExp(`(?<![\\w$.])${name.replace(/\$/g, "\\$")}\\b`);
const httpMethods = (text) => [...new Set([...(text ?? "").matchAll(/\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/gi)].map((m) => m[1].toUpperCase()))];

function joinRoute(...parts) {
  const joined = `/${parts.filter(Boolean).join("/")}`.replace(/\/{2,}/g, "/");
  return joined.length > 1 ? joined.replace(/\/$/, "") : "/";
}

/** Local names a file imports: name -> module spec (ESM and require). */
function importsOf(text) {
  const out = new Map();
  for (const m of text.matchAll(/\bimport\s+(?:type\s+)?([^;'"]*?)\s+from\s*["']([^"']+)["']/g)) {
    const [clause, spec] = [m[1], m[2]];
    const ns = clause.match(/\*\s+as\s+([\w$]+)/);
    if (ns) out.set(ns[1], spec);
    const braces = clause.match(/\{([^}]*)\}/);
    if (braces)
      for (const part of braces[1].split(",")) {
        const n = part.trim().replace(/^type\s+/, "").split(/\s+as\s+/).pop();
        if (/^[\w$]+$/.test(n ?? "")) out.set(n, spec);
      }
    const def = clause.replace(/\{[^}]*\}|\*\s+as\s+[\w$]+/g, "").split(",")[0].trim();
    if (/^[\w$]+$/.test(def)) out.set(def, spec);
  }
  for (const m of text.matchAll(/\b(?:const|let|var)\s+(\{[^}]*\}|[\w$]+)\s*=\s*require\(\s*["']([^"']+)["']\s*\)/g)) {
    if (m[1].startsWith("{"))
      for (const part of m[1].slice(1, -1).split(",")) {
        const n = part.trim().split(/\s*:\s*/).pop();
        if (/^[\w$]+$/.test(n ?? "")) out.set(n, m[2]);
      }
    else out.set(m[1], m[2]);
  }
  return out;
}

/** Local file for a relative or @/ ~/ import; undefined for a package; null when not found. */
function resolveLocal(spec, from, files) {
  let base;
  if (spec.startsWith(".")) base = posix.join(posix.dirname(from), spec);
  else if (spec.startsWith("@/") || spec.startsWith("~/")) {
    const rest = spec.slice(2);
    base = [...files].some((f) => f.startsWith(`src/${rest}`)) ? `src/${rest}` : rest;
  } else return undefined;
  const exts = ["ts", "tsx", "js", "jsx", "mjs", "cjs"];
  const candidates = [base, ...exts.map((e) => `${base}.${e}`), ...exts.map((e) => `${base}/index.${e}`)];
  if (/\.js$/.test(base)) candidates.push(base.replace(/\.js$/, ".ts"));
  return candidates.find((c) => files.has(c)) ?? null;
}

const normalizePackage = (spec) => spec.replace(/^(npm|jsr|node):/, "");

/** Text of the function, arrow function or method called `name` in a file, or "". */
function functionText(text, name) {
  const esc = name.replace(/\$/g, "\\$");
  const re = new RegExp(
    `(?:function\\s*\\*?\\s*${esc}\\s*\\(|(?:const|let|var)\\s+${esc}\\s*(?::[^=]+)?=\\s*(?:async\\s+)?(?:function\\b|\\(|[\\w$]+\\s*=>)|^\\s*(?:public\\s+|private\\s+|static\\s+)*(?:async\\s+)?${esc}\\s*\\()`,
    "m",
  );
  const m = re.exec(text);
  if (!m) return "";
  const brace = text.indexOf("{", m.index + m[0].length);
  const arrow = text.indexOf("=>", m.index);
  // Arrow function with an expression body: up to the end of the statement.
  if (arrow > 0 && (brace < 0 || text.slice(arrow + 2, brace).trim() !== "") && text.slice(m.index, arrow).length < 400) {
    const end = text.indexOf("\n\n", arrow);
    return text.slice(m.index, end < 0 ? undefined : end);
  }
  if (brace < 0) return "";
  return text.slice(m.index, brace + balanced(text, brace).length + 2);
}

/** Top-level const/let/var statements of a file that are not functions: name -> statement text. */
function topLevelDeclarations(text) {
  const out = new Map();
  for (const m of text.matchAll(/^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=\s*/gm)) {
    const rest = text.slice(m.index + m[0].length);
    if (/^(?:async\s+)?(?:function\b|\([^)]*\)\s*=>|[\w$]+\s*=>)/.test(rest)) continue; // functions: functionText()
    // The statement runs to the first ; or line break outside brackets.
    let depth = 0;
    let quote = null;
    let end = rest.length;
    for (let i = 0; i < rest.length; i++) {
      const c = rest[i];
      if (quote) {
        if (c === "\\") i++;
        else if (c === quote) quote = null;
      } else if (c === '"' || c === "'" || c === "`") quote = c;
      else if ("([{".includes(c)) depth++;
      else if (")]}".includes(c)) depth--;
      else if ((c === ";" || c === "\n") && depth <= 0) {
        end = i;
        break;
      }
    }
    out.set(m[1], text.slice(m.index, m.index + m[0].length + end));
  }
  return out;
}

// ---------------------------------------------------------------- discovery

/**
 * All endpoints of JS/TS servers on a commit. Each: kind (framework), route, methods, path, line,
 * own, helpers, packages, hasAuth / authLabel, and the access the platform provides
 * (platformAuth: Azure function key) or anonymousFunction (Azure authLevel "anonymous").
 */
export function findJsServerEndpoints(dir, sha, files, { authNames = [] } = {}) {
  const fileSet = new Set(files);
  const cache = new Map();
  const read = (p) => {
    if (!cache.has(p)) cache.set(p, stripJsComments(git(dir, ["cat-file", "blob", `${sha}:${p}`], { allowFail: true }) ?? ""));
    return cache.get(p);
  };
  const words = authNames.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") || "$^";
  const callAuthRe = new RegExp(`\\b(?:${words})\\s*\\(`); // requireUser(...) in the handler
  const refAuthRe = new RegExp(`(?<![\\w$])(?:[\\w$]+\\.)?(?:${words})\\b`); // requireAuth passed as middleware

  const codeFiles = files.filter((f) => CODE_RE.test(f) && !SKIP_RE.test(f) && !TEST_RE.test(f));
  const candidates = codeFiles.filter((f) => FRAMEWORK_RE.test(read(f)));
  const endpoints = [];

  // NestJS: a global guard (APP_GUARD) that checks the login protects every controller.
  let nestGlobalAuth = false;
  for (const f of candidates)
    for (const m of read(f).matchAll(/provide\s*:\s*APP_GUARD\s*,\s*useClass\s*:\s*([\w$]+)/g)) if (AUTH_GUARD_RE.test(m[1])) nestGlobalAuth = true;

  /** The code an endpoint runs, its local helpers (two levels) and the packages they use. */
  const sourceFor = (path, ownText) => {
    const text = read(path);
    let own = ownText;
    const included = new Set();
    const declared = topLevelDeclarations(text);
    for (let round = 0; round < 2; round++) {
      // Functions the handler calls or passes on
      for (const m of [...own.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*(?:\(|[,)\]])/g)]) {
        const name = m[1];
        if (included.has(name) || /^(?:if|for|while|switch|return|await|async|function|new|typeof|catch)$/.test(name)) continue;
        included.add(name);
        const fn = functionText(text, name);
        if (fn && !own.includes(fn)) own += `\n${fn}`;
      }
      // Top-level objects it reads (const openai = new OpenAI())
      for (const [name, stmt] of declared)
        if (!included.has(name) && refRe(name).test(own)) {
          included.add(name);
          if (!own.includes(stmt)) own += `\n${stmt}`;
        }
    }
    const imports = importsOf(text);
    const packages = new Set();
    const helperTexts = [];
    let ssoHelper = false;
    const seen = new Set([path]);
    let frontier = [];
    for (const [name, spec] of imports) {
      if (!refRe(name).test(own)) continue;
      const local = resolveLocal(spec, path, fileSet);
      if (local === undefined) packages.add(normalizePackage(spec));
      else if (local && !seen.has(local)) {
        seen.add(local);
        const t = read(local);
        helperTexts.push(t);
        frontier.push({ path: local, text: t });
        if (checksMicrosoftLogin(t) && new RegExp(`(?<![\\w$.])${name.replace(/\$/g, "\\$")}\\s*\\(`).test(own)) ssoHelper = true;
      }
    }
    for (const { path: from, text: t } of frontier)
      for (const spec of importsOf(t).values()) {
        const local = resolveLocal(spec, from, fileSet);
        if (local === undefined) packages.add(normalizePackage(spec));
        else if (local && !seen.has(local) && seen.size < 25) {
          seen.add(local);
          helperTexts.push(read(local));
        }
      }
    return { own, helpers: helperTexts.join("\n"), packages, ssoHelper };
  };

  /** A handler written inline, or named: its text from this file or from the local file it is imported from. */
  const handlerText = (path, expr) => {
    const e = expr?.trim() ?? "";
    if (!/^[\w$.]+$/.test(e)) return e;
    const name = e.split(".").pop();
    const here = functionText(read(path), name);
    if (here) return here;
    const spec = importsOf(read(path)).get(e.split(".")[0]);
    const local = spec ? resolveLocal(spec, path, fileSet) : null;
    if (local) return `${e}\n${functionText(read(local), name) || ""}`;
    return e;
  };

  const add = (path, ep, ownText, extraAuth = null) => {
    const src = sourceFor(path, ownText);
    const known = callAuthRe.test(src.own) || Boolean(extraAuth);
    const sso = !known && (checksMicrosoftLogin(src.own) || src.ssoHelper);
    endpoints.push({
      ...ep,
      path,
      own: src.own,
      helpers: src.helpers,
      packages: src.packages,
      hasAuth: known || sso,
      authLabel: sso ? "login check (Microsoft SSO)" : extraAuth,
    });
  };

  // Azure Functions v3: <name>/function.json with an httpTrigger binding.
  for (const cfg of files.filter((f) => /(^|\/)[^/]+\/function\.json$/.test(f) && !SKIP_RE.test(f))) {
    let json;
    try {
      json = JSON.parse(git(dir, ["cat-file", "blob", `${sha}:${cfg}`], { allowFail: true }) ?? "");
    } catch {
      continue;
    }
    const trigger = (json.bindings ?? []).find((b) => b.type === "httpTrigger");
    if (!trigger) continue;
    const folder = posix.dirname(cfg);
    const script = [json.scriptFile && posix.join(folder, json.scriptFile), ...["index.js", "index.ts", "index.mjs"].map((n) => `${folder}/${n}`)].find(
      (p) => p && fileSet.has(p),
    );
    const level = String(trigger.authLevel ?? "function").toLowerCase();
    const route = joinRoute("api", trigger.route ?? posix.basename(folder));
    add(
      script ?? cfg,
      {
        kind: "azure-function",
        route,
        methods: trigger.methods?.length ? trigger.methods.map((m) => m.toUpperCase()) : ["ANY"],
        line: 1,
        ...(level === "anonymous" ? { anonymousFunction: true } : { platformAuth: "Azure function key" }),
      },
      script ? read(script) : "",
    );
  }

  for (const path of candidates) {
    const text = read(path);

    // Azure Functions v4: app.http("name", { methods, authLevel, route, handler }) and app.get(...)
    if (/["']@azure\/functions["']/.test(text)) {
      for (const m of text.matchAll(/(?<![\w$.])app\.(http|get|post|put|patch|deleteRequest)\s*\(/g)) {
        const args = splitArgs(balanced(text, m.index + m[0].length - 1));
        const name = literal(args[0]);
        if (!name) continue;
        const opts = args[1] ?? "";
        const isObj = opts.startsWith("{");
        const level = (isObj ? literal(prop(opts, "authLevel")) : null) ?? "anonymous"; // v4 default
        const methods = m[1] === "http" ? httpMethods(isObj ? prop(opts, "methods") : "") : [m[1] === "deleteRequest" ? "DELETE" : m[1].toUpperCase()];
        const route = joinRoute("api", (isObj ? literal(prop(opts, "route")) : null) ?? name);
        const handler = isObj ? prop(opts, "handler") : opts;
        add(
          path,
          {
            kind: "azure-function",
            route,
            methods: methods.length ? methods : ["ANY"],
            line: lineAt(text, m.index),
            ...(level.toLowerCase() === "anonymous" ? { anonymousFunction: true } : { platformAuth: "Azure function key" }),
          },
          `${handlerText(path, handler)}\n${isObj ? opts : ""}`,
        );
      }
      continue;
    }

    // NestJS: @Controller("prefix") classes with @Get/@Post... methods.
    if (/@Controller\s*\(/.test(text)) {
      for (const c of text.matchAll(/@Controller\s*\(/g)) {
        const cargs = balanced(text, c.index + c[0].length - 1);
        const prefix = literal(cargs) ?? literal(prop(cargs, "path")) ?? "";
        const classMatch = /\bclass\s+[\w$]+[^{]*\{/.exec(text.slice(c.index));
        if (!classMatch) continue;
        const bodyStart = c.index + classMatch.index + classMatch[0].length - 1;
        const body = balanced(text, bodyStart);
        const classDecorators = text.slice(Math.max(0, text.lastIndexOf("}", c.index)), bodyStart); // not the previous class
        const classGuard = [...classDecorators.matchAll(/@UseGuards\s*\(([^)]*)\)/g)].some((g) => AUTH_GUARD_RE.test(g[1]));
        for (const d of body.matchAll(/@(Get|Post|Put|Patch|Delete|All|Options|Head)\s*\(/g)) {
          const sub = literal(balanced(body, d.index + d[0].length - 1)) ?? "";
          const runStart = Math.max(body.lastIndexOf("}", d.index), body.lastIndexOf(";", d.index), 0);
          const after = body.slice(d.index);
          const sig = /\n\s*(?:public\s+|private\s+|protected\s+|static\s+)*(?:async\s+)?([\w$]+)\s*\(/.exec(after);
          if (!sig) continue;
          const open = body.indexOf("{", d.index + sig.index + sig[0].length + balanced(after, sig.index + sig[0].length - 1).length);
          const methodText = body.slice(runStart, open + balanced(body, open).length + 2);
          const decorators = body.slice(runStart, d.index + sig.index);
          const guard = [...decorators.matchAll(/@UseGuards\s*\(([^)]*)\)/g)].some((g) => AUTH_GUARD_RE.test(g[1]));
          const isPublic = PUBLIC_DECORATOR_RE.test(decorators);
          const auth = guard || classGuard ? "login check (guard)" : nestGlobalAuth && !isPublic ? "login check (global guard)" : null;
          add(
            path,
            {
              kind: "nestjs",
              route: joinRoute(prefix, sub),
              methods: [d[1] === "All" ? "ANY" : d[1].toUpperCase()],
              line: lineAt(text, bodyStart + 1 + d.index),
            },
            methodText,
            auth,
          );
        }
      }
      continue;
    }

    // Express, Fastify, Hono, Koa.
    const objects = new Map(); // name -> kind
    for (const m of text.matchAll(/\b(?:const|let|var)\s+([\w$]+)\s*(?::[^=\n]+)?=\s*(?:new\s+)?(?:[\w$]+\.)?(express|Router|Hono|OpenAPIHono|Fastify|fastify)\s*[(<]/g))
      objects.set(m[1], CTOR_KIND[m[2]]);
    for (const m of text.matchAll(/\b(?:const|let|var)\s+([\w$]+)\s*=\s*require\(\s*["']express["']\s*\)\s*\(\)/g)) objects.set(m[1], "express");
    for (const m of text.matchAll(/\b(?:const|let|var)\s+([\w$]+)\s*=\s*new\s+([\w$]+)\s*\(/g)) {
      const spec = importsOf(text).get(m[2]);
      if (spec === "koa-router" || spec === "@koa/router") objects.set(m[1], "koa");
    }
    const fileKind = { express: "express", fastify: "fastify", hono: "hono", "koa-router": "koa", "@koa/router": "koa" }[text.match(FRAMEWORK_RE)?.[1]?.split("/")[0] ?? ""] ?? "express";
    const isObject = (name) => objects.has(name) || (!objects.size && FALLBACK_OBJECTS.includes(name));
    const kindOf = (name) => objects.get(name) ?? fileKind;

    // Sub-routers mounted in this file: app.use("/api", users) or app.route("/api", users).
    const prefixes = new Map();
    for (const m of text.matchAll(/(?<![\w$.])([\w$]+)\.(?:use|route|register)\s*\(\s*(["'`])(\/[^"'`]*)\2\s*,\s*([\w$]+)\s*[,)]/g))
      if (objects.has(m[4])) prefixes.set(m[4], m[3]);
    // Hono: const app = new Hono().basePath("/api")
    for (const m of text.matchAll(/\b(?:const|let|var)\s+([\w$]+)\s*=\s*new\s+(?:OpenAPI)?Hono\s*\([^)]*\)\s*\.basePath\(\s*["'`](\/[^"'`]*)["'`]/g))
      prefixes.set(m[1], m[2]);

    // Middleware that applies to the routes registered after it: app.use(auth), app.use("/api/*", jwt(...)),
    // fastify.addHook("onRequest", authenticate).
    const middleware = [];
    for (const m of text.matchAll(/(?<![\w$.])([\w$]+)\.(use|addHook)\s*\(/g)) {
      if (!isObject(m[1])) continue;
      const args = splitArgs(balanced(text, m.index + m[0].length - 1));
      let prefix = "";
      let rest = args;
      if (m[2] === "addHook") {
        if (!/^["'](?:onRequest|preHandler|preValidation|preParsing)["']$/.test(args[0] ?? "")) continue;
        rest = args.slice(1);
      } else if (literal(args[0])?.startsWith("/")) {
        prefix = literal(args[0]);
        rest = args.slice(1);
      }
      if (rest.length === 1 && objects.has(rest[0])) continue; // a mounted sub-router, not middleware
      // Paths are relative to the object's own prefix (Hono basePath, a mounted router).
      const scope = prefix ? joinRoute(prefixes.get(m[1]) ?? "", prefix.replace(/\*+$/, "")) : "";
      middleware.push({ object: m[1], index: m.index, prefix: scope === "/" ? "" : scope, text: rest.join(", ") });
    }
    const middlewareFor = (object, index, route) =>
      middleware.filter((w) => w.object === object && w.index < index && (!w.prefix || route === w.prefix || route.startsWith(`${w.prefix}/`)));

    const routes = [];
    for (const m of text.matchAll(new RegExp(`(?<![\\w$.])([\\w$]+)\\.(${ROUTE_METHODS})\\s*\\(`, "g"))) {
      if (!isObject(m[1])) continue;
      const args = splitArgs(balanced(text, m.index + m[0].length - 1));
      const path0 = literal(args[0]);
      if (path0 === null || !(path0.startsWith("/") || path0 === "*")) continue;
      const middles = args.slice(1, -1).map((a) => (a.startsWith("{") ? hooksOf(a) : a)).filter(Boolean);
      routes.push({ object: m[1], index: m.index, path: path0, method: m[2], middles, handler: args.at(-1) ?? "" });
    }
    // Fastify: fastify.route({ method, url, preHandler, handler })
    for (const m of text.matchAll(/(?<![\w$.])([\w$]+)\.route\s*\(\s*\{/g)) {
      if (!isObject(m[1])) continue;
      const opts = `{${balanced(text, m.index + m[0].length - 1)}}`;
      const url = literal(prop(opts, "url") ?? prop(opts, "path"));
      if (!url) continue;
      const hooks = hooksOf(opts);
      routes.push({ object: m[1], index: m.index, path: url, method: httpMethods(prop(opts, "method")).join(",") || "all", middles: hooks ? [hooks] : [], handler: prop(opts, "handler") ?? "" });
    }

    for (const r of routes) {
      const route = joinRoute(prefixes.get(r.object) ?? "", r.path === "*" ? "*" : r.path);
      const applied = middlewareFor(r.object, r.index, route);
      const middleText = [...r.middles, ...applied.map((w) => w.text)].join(", ");
      const auth = refAuthRe.test(middleText) || AUTH_MIDDLEWARE_RE.test(middleText) || checksMicrosoftLogin(middleText) ? "login check (middleware)" : null;
      const methods = r.method === "all" ? ["ANY"] : r.method.split(",").map((x) => x.toUpperCase());
      add(path, { kind: kindOf(r.object), route, methods, line: lineAt(text, r.index) }, `${middleText}\n${handlerText(path, r.handler)}`, auth);
    }
  }
  return endpoints;
}
