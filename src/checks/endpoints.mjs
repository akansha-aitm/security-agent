// Endpoint checks: finds every API endpoint on a commit, sorts it by what it calls
// (LLM, third-party service, our own container, or other) and checks the rules for that kind.
// Reads files through git only: nothing is installed, built or run. The checks are heuristics on
// the source text: they say "no login check found", not "this route is open" — a person confirms.
import { readFileSync } from "node:fs";
import { posix } from "node:path";
import { fileURLToPath } from "node:url";
import { git } from "../util.mjs";

const DEFAULT_CONFIG = fileURLToPath(new URL("../../config/endpoints.json", import.meta.url));
const CODE_EXT = ["ts", "tsx", "js", "jsx", "mjs", "cjs"];
const CODE_RE = new RegExp(`\\.(${CODE_EXT.join("|")})$`);
const SKIP_DIR_RE = /(^|\/)(node_modules|\.next|dist|build|out|coverage|\.vercel|__tests__|__mocks__)\//;
const METHODS = "GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS";
const MAX_HELPER_FILES = 25;

export const CATEGORY_LABEL = { llm: "LLM", "third-party": "third-party", container: "container", other: "other" };

export function loadEndpointRules(path = process.env.ENDPOINTS_CONFIG_PATH ?? DEFAULT_CONFIG) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** Global rules merged with the per-repo additions for this repository. */
function rulesFor(config, repo) {
  const extra = config.repos?.[repo] ?? config.repos?.[repo?.toLowerCase()] ?? {};
  const words = (list) => list.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const authHelpers = [...(config.authHelpers ?? []), ...(extra.authHelpers ?? [])];
  const rateHelpers = [...(config.rateLimitHelpers ?? []), ...(extra.rateLimitHelpers ?? [])];
  return {
    publicRoutes: [...(config.publicRoutes ?? []), ...(extra.publicRoutes ?? [])].map(globToRegex),
    authRe: new RegExp(`\\b(?:${words(authHelpers)})\\s*\\(`),
    rateRe: new RegExp(`\\bRatelimit\\b|\\.limit\\(|\\b(?:${words(rateHelpers)})\\b`, "i"),
    llmPackages: config.llm?.packages ?? [],
    llmHosts: config.llm?.hosts ?? [],
    thirdPackages: config.thirdParty?.packages ?? [],
    ignoreHosts: new Set(config.thirdParty?.ignoreHosts ?? []),
    envNames: { ...(config.envUrls?.names ?? {}), ...(extra.envUrls?.names ?? {}) },
    containerRe: new RegExp(config.envUrls?.containerPattern || "$^"),
    thirdRe: new RegExp(config.envUrls?.thirdPartyPattern || "$^"),
  };
}

/** "/api/**" style patterns. * = one segment, ** = any depth. Brackets ([id]) are literal. */
function globToRegex(glob) {
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\0").replace(/\*/g, "[^/]*").replace(/\0/g, ".*");
  return new RegExp(`^${esc}$`);
}

/** Comments removed, so "// TODO: add auth" never counts as a check (URLs like https:// are kept). */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

/** Maps a file to the endpoint it defines, or null. */
export function endpointOfFile(path) {
  if (!CODE_RE.test(path) || SKIP_DIR_RE.test(path)) return null;
  const parts = path.split("/");
  const file = parts.at(-1);
  // App Router: .../app/<segments>/route.ts
  const appIdx = parts.indexOf("app");
  if (/^route\.[cm]?[jt]sx?$/.test(file) && appIdx >= 0) {
    const segs = parts.slice(appIdx + 1, -1);
    if (segs.some((s) => s.startsWith("_"))) return null; // private folders are not routed
    const route = "/" + segs.filter((s) => !/^\(.*\)$/.test(s) && !s.startsWith("@")).join("/");
    return { kind: "app", route, root: rootOf(parts, appIdx) };
  }
  // Pages Router: .../pages/api/<path>.ts
  const pagesIdx = parts.findIndex((p, i) => p === "pages" && parts[i + 1] === "api");
  if (pagesIdx >= 0) {
    const segs = parts.slice(pagesIdx + 1);
    if (segs.some((s) => s.startsWith("_"))) return null;
    segs[segs.length - 1] = file.replace(CODE_RE, "");
    if (segs.at(-1) === "index") segs.pop();
    return { kind: "pages", route: "/" + segs.join("/"), root: rootOf(parts, pagesIdx) };
  }
  // Supabase edge functions: supabase/functions/<name>/index.ts
  const fnIdx = parts.findIndex((p, i) => p === "functions" && parts[i - 1] === "supabase");
  if (fnIdx >= 0 && parts.length === fnIdx + 3 && /^index\.[jt]s$/.test(file) && !parts[fnIdx + 1].startsWith("_"))
    return { kind: "edge", route: `/functions/v1/${parts[fnIdx + 1]}`, root: parts.slice(0, fnIdx - 1).join("/") };
  return null;
}

function rootOf(parts, idx) {
  const before = parts.slice(0, idx);
  if (before.at(-1) === "src") before.pop();
  return before.join("/");
}

/** Reads a route file plus the local files it imports (two levels), and the packages they use. */
function readWithHelpers(dir, sha, files, path, root) {
  const read = (p) => git(dir, ["cat-file", "blob", `${sha}:${p}`], { allowFail: true }) ?? "";
  const own = read(path);
  const seen = new Set([path]);
  const packages = new Set();
  const helperTexts = [];
  let frontier = [{ path, text: own }];
  for (let depth = 0; depth < 2 && frontier.length; depth++) {
    const next = [];
    for (const { path: from, text } of frontier) {
      for (const spec of importsOf(text)) {
        const local = resolveLocal(spec, from, root, files);
        if (local === undefined) packages.add(normalizePackage(spec));
        else if (local && !seen.has(local) && seen.size < MAX_HELPER_FILES) {
          seen.add(local);
          const t = read(local);
          helperTexts.push(t);
          next.push({ path: local, text: t });
        }
      }
    }
    frontier = next;
  }
  return { own, helpers: helperTexts.join("\n"), packages };
}

function importsOf(text) {
  const out = [];
  const re = /\bfrom\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)|\brequire\(\s*["']([^"']+)["']\s*\)|^\s*import\s*["']([^"']+)["']/gm;
  for (const m of text.matchAll(re)) out.push(m[1] ?? m[2] ?? m[3] ?? m[4]);
  return out;
}

/** Deno/edge style specifiers (npm:openai@4, https://esm.sh/openai) -> package name. */
function normalizePackage(spec) {
  let s = spec.replace(/^(npm|jsr|node):/, "").replace(/^https?:\/\/(esm\.sh|cdn\.skypack\.dev|esm\.run)\//, "");
  s = s.replace(/^(@[^/@]+\/[^/@]+|[^/@]+)@[^/]*/, "$1"); // drop @version
  return s;
}

/** Local file for a relative or aliased import; undefined for packages; null when not found. */
function resolveLocal(spec, from, root, files) {
  let base;
  if (spec.startsWith(".")) base = posix.join(posix.dirname(from), spec);
  else if (spec.startsWith("@/") || spec.startsWith("~/")) {
    const prefix = root ? `${root}/` : "";
    const inSrc = `${prefix}src/${spec.slice(2)}`;
    base = [...files].some((f) => f.startsWith(inSrc)) ? inSrc : `${prefix}${spec.slice(2)}`;
  } else return undefined;
  const candidates = [base, ...CODE_EXT.map((e) => `${base}.${e}`), ...CODE_EXT.map((e) => `${base}/index.${e}`)];
  return candidates.find((c) => files.has(c)) ?? null;
}

const matchesPackage = (pkg, list) => list.some((p) => (p.endsWith("/") ? pkg.startsWith(p) : pkg === p || pkg.startsWith(`${p}/`)));

/** Sorts an endpoint into categories by what it (and its helpers) call. */
function categorize({ own, helpers, packages }, r) {
  const all = `${own}\n${helpers}`;
  const cats = new Set();
  let containerAssumed = false;
  const pkgs = [...packages];
  if (pkgs.some((p) => matchesPackage(p, r.llmPackages)) || r.llmHosts.some((h) => all.includes(h))) cats.add("llm");
  if (pkgs.some((p) => matchesPackage(p, r.thirdPackages))) cats.add("third-party");
  for (const m of all.matchAll(/https?:\/\/([a-z0-9.-]+\.[a-z]{2,})/gi)) {
    const host = m[1].toLowerCase();
    if (r.ignoreHosts.has(host) || r.llmHosts.includes(host) || host.endsWith(".supabase.co")) continue;
    cats.add("third-party");
  }
  for (const m of all.matchAll(/process\.env\.([A-Z0-9_]+)|Deno\.env\.get\(\s*["']([A-Z0-9_]+)["']/g)) {
    const name = m[1] ?? m[2];
    if (!/(_URL|_URI|_ENDPOINT|_HOST|_BASE|_BASE_URL)$/.test(name)) continue;
    const kind = r.envNames[name] ?? (r.thirdRe.test(name) ? "third-party" : r.containerRe.test(name) ? "container" : /SUPABASE/.test(name) ? "database" : name.startsWith("NEXT_PUBLIC_") ? "ignore" : "assumed");
    if (kind === "third-party") cats.add("third-party");
    else if (kind === "container") cats.add("container");
    else if (kind === "assumed") {
      cats.add("container");
      containerAssumed = true;
    }
  }
  if (!cats.size) cats.add("other");
  return { cats, containerAssumed };
}

function methodsOf(own, kind) {
  if (kind === "edge") return ["ANY"];
  if (kind === "pages") {
    const m = [...own.matchAll(new RegExp(`method\\s*[!=]==?\\s*["'](${METHODS})["']`, "g"))].map((x) => x[1]);
    return m.length ? [...new Set(m)] : ["ANY"];
  }
  const re = new RegExp(
    `export\\s+(?:async\\s+)?function\\s+(${METHODS})\\b|export\\s+(?:const|let|var)\\s+(${METHODS})\\b|\\bas\\s+(${METHODS})\\b`,
    "g",
  );
  return [...new Set([...own.matchAll(re)].map((m) => m[1] ?? m[2] ?? m[3]))];
}

function lineOf(text, re) {
  const idx = text.search(re);
  return idx < 0 ? 1 : text.slice(0, idx).split("\n").length;
}

// Patterns on the route's own code (what it reads from the request).
const FROM_REQUEST = "(?:body|input|data|json|payload|params|values|formData)";
const fromJson = (names) => new RegExp(`\\{[^}]*\\b(?:${names})\\b[^}]*\\}\\s*=\\s*(?:await\\s+)?\\w+\\.json\\(\\)`);
const URL_NAMES = "url|uri|link|href|target|endpoint|callback|webhook|imageUrl|image_url|src|path";
const RE = {
  userUrl: [
    new RegExp(`searchParams\\.get\\(\\s*["'](?:${URL_NAMES})["']\\s*\\)`),
    new RegExp(`\\b${FROM_REQUEST}\\.(?:${URL_NAMES})\\b`),
    fromJson(URL_NAMES),
  ],
  urlValidated: /ALLOWED_(?:HOSTS|DOMAINS|ORIGINS|PATHS)|allowedHosts|allowedPaths|\.hostname\s*[!=]==|\.hostname\)|\.startsWith\(\s*["'`]https:\/\//,
  outbound: /\bfetch\(|\baxios\b|\bgot\(|\bky\./,
  timeout: /AbortSignal\.timeout|AbortController|\bsignal\s*:|\btimeout\s*:/,
  identity: [
    new RegExp(`\\b${FROM_REQUEST}\\.(?:user_?id|userId|role|isAdmin|is_admin)\\b`),
    new RegExp(`searchParams\\.get\\(\\s*["'](?:user_?id|userId|role|email)["']`),
    fromJson("user_?id|userId|role|isAdmin|is_admin"),
    /cookies\(\)[^;\n]*\.get\(\s*["'](?:user_?id|userId|role)["']/,
  ],
  llmSettings: [
    new RegExp(`\\b${FROM_REQUEST}\\.(?:model|system|systemPrompt|system_prompt|temperature|max_tokens|maxTokens|tools|provider)\\b`),
    fromJson("model|system|systemPrompt|system_prompt|temperature|max_tokens|maxTokens|tools|provider"),
  ],
  inputLimit: /\.max\(\s*\d|\.length\s*>=?\s*\w|maxLength|MAX_[A-Z_]*(?:LENGTH|CHARS|TOKENS|SIZE|MESSAGES|ITEMS)|\.slice\(\s*0\s*,|\btruncate/,
  maxDuration: /export\s+const\s+maxDuration\b/,
  adminKey: /SUPABASE_SECRET_KEY|SERVICE_ROLE|service_role|createAdminClient|supabaseAdmin|adminClient/,
  writes: /\.(?:insert|upsert|update)\(|\.delete\(\s*\)|\.rpc\(/,
  logsSecret:
    /console\.(?:log|info|warn|error|debug)\([^;\n]*(?:process\.env\.[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)|\bapiKey\b|\bapi_key\b|headers\.get\(\s*["']authorization["']\s*\))/i,
  forwardsHeaders:
    /headers\s*:\s*(?:req|request)\.headers|fromEntries\(\s*(?:req|request)\.headers|\.\.\.\s*(?:req|request)\.headers|["']?authorization["']?\s*:\s*(?:req|request)\.headers\.get/i,
  serviceCredential:
    /(?:authorization|x-api-key|x-internal[\w-]*|x-service[\w-]*)["']?\s*:\s*[^\n]*(?:process\.env\.|Deno\.env\.get)|getIdTokenClient|GoogleAuth|fetchIdToken|idTokenProvider/i,
  cronSecret: /CRON_SECRET/,
  signature: /constructEvent|verifySignature|verifyWebhook|createHmac|timingSafeEqual|new\s+Webhook\(|\.verify\(/,
  useServer: /^\s*["']use server["']/,
};
const any = (res, text) => res.some((re) => re.test(text));

/**
 * Runs the endpoint checks on one commit. Returns finding items like runBranchChecks, and reports each
 * endpoint to onEndpoint (inventory). `files` is the list of paths on the commit.
 */
export function runEndpointChecks(dir, sha, files, config, { repo, onEndpoint } = {}) {
  if (!config) return [];
  const r = rulesFor(config, repo);
  const fileSet = new Set(files);
  const items = [];
  const read = (p) => git(dir, ["cat-file", "blob", `${sha}:${p}`], { allowFail: true }) ?? "";

  // Server actions: files starting with "use server". Each exported function is a callable endpoint.
  const actionFiles = new Set(
    (git(dir, ["grep", "-l", "-E", "^\\s*[\"']use server[\"']", sha, "--", ...CODE_EXT.map((e) => `*.${e}`)], { allowFail: true }) ?? "")
      .split("\n")
      .filter((l) => l.startsWith(`${sha}:`))
      .map((l) => l.slice(sha.length + 1))
      .filter((p) => !SKIP_DIR_RE.test(p)),
  );

  // Supabase functions that switched off the platform's token check.
  const noJwt = new Set();
  for (const cfg of files.filter((f) => /(^|\/)supabase\/config\.toml$/.test(f))) {
    let current = null;
    for (const line of read(cfg).split(/\r?\n/)) {
      const section = line.match(/^\s*\[functions\.([^\]]+)\]/);
      if (section) current = section[1].replace(/^["']|["']$/g, "");
      else if (/^\s*\[/.test(line)) current = null;
      else if (current && /^\s*verify_jwt\s*=\s*false/.test(line)) noJwt.add(current);
    }
  }
  const vercelJson = files.includes("vercel.json") ? read("vercel.json") : "";
  const cronPaths = new Set([...vercelJson.matchAll(/"path"\s*:\s*"([^"?]+)/g)].map((m) => m[1]));

  const endpoints = [];
  for (const path of files) {
    const ep = endpointOfFile(path);
    if (ep) endpoints.push({ ...ep, path });
    else if (actionFiles.has(path)) endpoints.push({ kind: "action", route: `server actions in ${path}`, root: rootGuess(path), path });
  }

  for (const ep of endpoints) {
    const src = readWithHelpers(dir, sha, fileSet, ep.path, ep.root);
    const own = stripComments(src.own);
    const helpers = stripComments(src.helpers);
    const all = `${own}\n${helpers}`;
    if (ep.kind === "action" && !RE.useServer.test(own)) continue;
    const { cats, containerAssumed } = categorize({ own, helpers, packages: src.packages }, r);
    const methods = ep.kind === "action" ? ["POST"] : methodsOf(own, ep.kind);
    if (ep.kind === "app" && !methods.length) continue; // route.ts without handlers
    const isPublic = r.publicRoutes.some((re) => re.test(ep.route));
    const isCron = /\/cron(\/|$)/.test(ep.route) || cronPaths.has(ep.route);
    const isWebhook = /webhook/i.test(ep.route);
    const fnName = ep.kind === "edge" ? ep.route.split("/").pop() : null;
    const platformAuth = ep.kind === "edge" && !noJwt.has(fnName);
    const hasAuth = r.authRe.test(own);
    const access = isPublic ? "public (approved)" : isCron ? "cron" : isWebhook ? "webhook" : hasAuth ? "login check" : platformAuth ? "Supabase token check" : "none found";
    const loc = `${ep.path}:${lineOf(src.own, new RegExp(`\\b(${METHODS})\\b|export\\s+default|serve\\(|Deno\\.serve`))}`;
    const label = ep.kind === "action" ? ep.route : `${ep.route}`;
    const catText = [...cats].map((c) => CATEGORY_LABEL[c]).join(" + ");
    const found = [];
    const add = (key, severity, title, advice) =>
      found.push({ fp: `endpoint|${key}|${ep.route}`, check: "endpoint", severity, location: loc, title: `${title}: ${label} (${catText})`, advice });

    // 1. Login check (cron routes and webhooks authenticate differently, checked below)
    if (!isPublic && !isCron && !isWebhook && !hasAuth && !platformAuth) {
      const critical = cats.has("llm") || RE.adminKey.test(all);
      add(
        "no-auth",
        critical ? "critical" : "high",
        ep.kind === "edge" ? "Supabase function with the token check switched off (verify_jwt = false) and no login check" : "No login check found in this endpoint",
        "Anyone on the internet can call it. Check the user on the first line of the handler (supabase.auth.getUser() or your project's helper), " +
          "and refuse with 401 when there is no user. The middleware/proxy alone is not enough. If this endpoint must be public, " +
          "add it to publicRoutes in the agent's config/endpoints.json (a written decision). If it already uses a helper with another name, add that name to authHelpers.",
      );
    }
    // 2. Cron routes need the secret, webhooks need a signature check
    if (isCron && !RE.cronSecret.test(all))
      add("cron-secret", "high", "Cron route without a CRON_SECRET check",
        "Anyone can call this URL in a loop. Refuse the request unless the header Authorization equals `Bearer ${process.env.CRON_SECRET}`, and refuse outside production.");
    if (isWebhook && !isPublic && !RE.signature.test(all))
      add("webhook-signature", "high", "Webhook that does not verify the sender's signature",
        "Anyone can send fake events. Verify the provider's signature on the raw body (e.g. stripe.webhooks.constructEvent), refuse old events and ignore event ids already processed.");
    // 3. Identity taken from the request
    if (any(RE.identity, own))
      add("identity", "high", "User id, role or email taken from the request instead of the session",
        "Anyone can send another user's id and act as them. Take the user from the verified session (getUser()) only, and check that any object they name belongs to them.");
    // 4. URL from the user (SSRF)
    if (any(RE.userUrl, own) && RE.outbound.test(all) && !RE.urlValidated.test(all))
      add("ssrf", "high", "Fetches a URL or path supplied by the user (SSRF risk)",
        "An attacker can point the server at internal addresses or other services. Never fetch a URL from the request; if you must, allow only a fixed list of hosts and paths.");
    // 5. Secrets in logs
    if (RE.logsSecret.test(all))
      add("logs-secret", "high", "Logs a key, token or Authorization header",
        "Logs are read by many people and tools. Remove the key from the log line; log an id or a short status instead.");
    // 6. GET handlers that change data (any link in an email can trigger them)
    const hasGet = methods.includes("GET");
    if (hasGet && cats.has("llm"))
      add("get-llm", "high", "GET handler on an endpoint that calls an LLM",
        "A simple link (an image in an email) can trigger it with the victim's session and spend AI credit. Use POST, check the Origin header and accept only application/json.");
    else if (hasGet && !isCron && RE.writes.test(own))
      add("get-writes", "medium", "GET handler in an endpoint that changes data",
        "A simple link can trigger it with the victim's session (CSRF). Move changes to POST/PUT/DELETE, check the Origin header and accept only application/json.");

    // LLM endpoints: cost and abuse
    if (cats.has("llm")) {
      if (!r.rateRe.test(all))
        add("llm-rate-limit", "high", "LLM endpoint without a rate limit",
          "One user or script can call it thousands of times and drain the AI budget. Add a per-user limit (e.g. Upstash Ratelimit) before calling the model.");
      if (any(RE.llmSettings, own))
        add("llm-settings", "high", "LLM endpoint takes the model, system prompt or settings from the request",
          "The client can switch to the most expensive model or rewrite the instructions. Accept only the user's message; set the model, system prompt and limits on the server.");
      if (!RE.inputLimit.test(all))
        add("llm-input-limit", "medium", "LLM endpoint without a visible input size limit",
          "A huge message multiplies the cost of each call. Validate the body (e.g. zod .max()) and cap message length, number of items and retries.");
      if (ep.kind === "app" && !RE.maxDuration.test(own) && !/maxDuration/.test(vercelJson))
        add("llm-max-duration", "medium", "LLM endpoint without an explicit maxDuration",
          "Without it, a slow or stuck call runs (and is billed) up to the platform maximum. Add `export const maxDuration = 60` (30 to 60 s for a simple call).");
    }
    // Third-party and container endpoints: outgoing calls need a timeout
    if ((cats.has("third-party") || cats.has("container")) && RE.outbound.test(all) && !RE.timeout.test(all))
      add("timeout", "medium", "Outgoing call without a timeout",
        "If the other service hangs, this endpoint hangs too and keeps consuming resources. Pass signal: AbortSignal.timeout(10_000) to fetch.");
    // Container endpoints: reach our own services safely
    if (cats.has("container")) {
      if (RE.forwardsHeaders.test(all))
        add("container-headers", "high", "Forwards the user's headers to an internal service",
          "The internal service then trusts whatever the browser sent. Send only a service credential (a shared secret or a Google ID token) and the fields it needs.");
      else if (!RE.serviceCredential.test(all))
        add("container-credential", containerAssumed ? "medium" : "high",
          containerAssumed ? "Calls a URL from a setting without a service credential (assumed to be one of our containers)" : "Calls an internal service without a service credential",
          "The container should refuse calls without a credential, so it cannot be reached directly. Send Authorization: Bearer <service secret or Google ID token>. " +
            (containerAssumed ? "If this URL is a third-party service, add its variable name to envUrls in config/endpoints.json." : ""));
    }

    items.push(...found);
    onEndpoint?.({ route: label, file: ep.path, kind: ep.kind, methods, categories: [...cats], access, issues: found.length });
  }
  return items;
}

function rootGuess(path) {
  const parts = path.split("/");
  const i = parts.findIndex((p) => p === "src" || p === "app" || p === "lib" || p === "actions");
  return i > 0 ? parts.slice(0, i).join("/") : "";
}
