// Checks that run on the tip commit of one branch. They read the repository through git
// (git grep / cat-file on a commit), never through a checkout, and never run the repo's code.
import { git } from "../util.mjs";
import { classifyVar, secretKindOfValue } from "../rules.mjs";

const NEXT_PUBLIC_RE = "NEXT_PUBLIC_[A-Za-z0-9_]+";
const GREP_EXCLUDES = [
  "**/node_modules/**",
  "**/.next/**",
  "**/dist/**",
  "**/build/**",
  "**/out/**",
  "**/coverage/**",
  "**/.vercel/**",
  "**/*.min.js",
  "**/*.map",
  "**/*.md",
  "**/package-lock.json",
  "**/pnpm-lock.yaml",
  "**/yarn.lock",
].map((g) => `:(exclude,glob)${g}`);

// .env, .env.local, apps/web/.env.production... but not the documented templates.
export const ENV_FILE_RE = /(^|\/)\.env(\.[^/]+)?$/;
const ENV_TEMPLATE_RE = /\.(example|sample|template|dist|defaults)$/;
export const isEnvFile = (path) => ENV_FILE_RE.test(path) && !ENV_TEMPLATE_RE.test(path);

export function listFiles(dir, sha) {
  return git(dir, ["ls-tree", "-r", "-z", "--name-only", sha]).split("\0").filter(Boolean);
}

const readBlob = (dir, sha, path) => git(dir, ["cat-file", "blob", `${sha}:${path}`], { allowFail: true });

/** Every NEXT_PUBLIC_ name used on this commit, with its locations. Only names are captured, never lines. */
export function findPublicEnvUsages(dir, sha) {
  const out = git(dir, ["grep", "-I", "-n", "-o", "-E", NEXT_PUBLIC_RE, sha, "--", ".", ...GREP_EXCLUDES], { allowFail: true }) ?? "";
  const usages = [];
  for (const line of out.split("\n")) {
    if (!line.startsWith(`${sha}:`)) continue;
    const m = line.slice(sha.length + 1).match(/^(.*):(\d+):(NEXT_PUBLIC_[A-Za-z0-9_]+)$/);
    if (m) usages.push({ path: m[1], line: Number(m[2]), name: m[3] });
  }
  return usages;
}

/** Simplified .gitignore matcher: enough to tell whether .env files are ignored at the root. */
export function gitignoreIgnoresEnv(text) {
  const rules = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
  const toRegex = (glob) =>
    new RegExp(
      "^" +
        [...glob].map((c) => (c === "*" ? ".*" : c === "?" ? "." : c.replace(/[.+^${}()|[\]\\]/g, "\\$&"))).join("") +
        "$",
    );
  const ignored = (name) => {
    let result = false;
    for (const rule of rules) {
      const negate = rule.startsWith("!");
      let pattern = negate ? rule.slice(1) : rule;
      if (pattern.endsWith("/")) continue; // directories only
      pattern = pattern.replace(/^\//, "").replace(/^\*\*\//, "");
      if (pattern.includes("/")) continue; // path-specific rule, does not apply to the root file
      if (toRegex(pattern).test(name)) result = !negate;
    }
    return result;
  };
  return [".env", ".env.local", ".env.production"].every(ignored);
}

/**
 * Runs every per-branch check. Returns items:
 * { fp, check, severity, title, advice, location }
 * fp identifies the issue inside the repo, independent of branch and line, so the same issue on
 * twelve branches becomes one alert listing the branches.
 */
export function runBranchChecks(dir, sha, rules, inventory) {
  const items = [];
  const files = listFiles(dir, sha);

  // 1. NEXT_PUBLIC_ variables against the allowlist
  const forbiddenCritical = new Set();
  for (const u of findPublicEnvUsages(dir, sha)) {
    const c = classifyVar(u.name, rules);
    inventory?.(u.name, c);
    if (c.status === "allowed") continue;
    if (c.status === "forbidden" && c.severity === "critical") forbiddenCritical.add(u.name);
    items.push({
      fp: `public-env|${u.name}`,
      check: "public-env",
      severity: c.severity,
      location: `${u.path}:${u.line}`,
      ...publicEnvText(u.name, c),
    });
  }

  // 2. Committed .env files, and NEXT_PUBLIC_ values in them that look like secrets
  for (const path of files.filter(isEnvFile)) {
    items.push({
      fp: `env-file|${path}`,
      check: "env-file",
      severity: "critical",
      location: path,
      title: `.env file committed to the repository: ${path}`,
      advice:
        "Treat every key in this file as leaked: revoke and replace them first, because the file is in the history of every clone. " +
        "Then remove it from the repo (git rm --cached) and add .env* to .gitignore.",
    });
    const text = readBlob(dir, sha, path) ?? "";
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*(?:export\s+)?(NEXT_PUBLIC_[A-Za-z0-9_]+)\s*=\s*(.*)$/);
      if (!m || forbiddenCritical.has(m[1])) continue; // already a critical alert by name
      const kind = secretKindOfValue(m[2], rules);
      if (!kind) continue;
      items.push({
        fp: `public-env-value|${m[1]}`,
        check: "public-env-value",
        severity: "critical",
        location: path,
        title: `${m[1]} holds a value that looks like a secret (${kind})`,
        advice:
          "NEXT_PUBLIC_ values are copied into the JavaScript every visitor downloads. Revoke and replace this key, " +
          "store the new one in a server-only variable (no NEXT_PUBLIC_ prefix), and use it only from server code.",
      });
    }
  }

  // 3. Root .gitignore must exclude .env files
  const gitignore = files.includes(".gitignore") ? readBlob(dir, sha, ".gitignore") ?? "" : null;
  if (gitignore === null || !gitignoreIgnoresEnv(gitignore)) {
    items.push({
      fp: "gitignore-env",
      check: "gitignore",
      severity: "high",
      location: ".gitignore",
      title: gitignore === null ? "No .gitignore at the repository root" : "The root .gitignore does not exclude .env files",
      advice: "Add these two lines to the root .gitignore:  .env*  and  !.env.example",
    });
  }

  // 4. next.config "env" key: its values always end up in the browser bundle
  for (const path of files.filter((f) => /(^|\/)next\.config\.(js|mjs|cjs|ts)$/.test(f))) {
    const text = readBlob(dir, sha, path) ?? "";
    const idx = text.search(/\benv\s*:\s*\{/);
    if (idx < 0) continue;
    items.push({
      fp: `next-config-env|${path}`,
      check: "next-config-env",
      severity: "high",
      location: `${path}:${text.slice(0, idx).split("\n").length}`,
      title: `${path} uses the "env" key, which copies values into the browser bundle`,
      advice:
        'Remove the "env" key. Read server values with process.env in server code only; only public values may use the NEXT_PUBLIC_ prefix.',
    });
  }

  return items;
}

function publicEnvText(name, c) {
  if (c.status === "deprecated")
    return { title: `${name} is deprecated`, advice: c.reason };
  if (c.status === "forbidden")
    return {
      title: `${name} is exposed in the browser (${c.reason})`,
      advice:
        "Anything prefixed NEXT_PUBLIC_ is copied into the JavaScript every visitor downloads, including on Vercel previews of this branch. " +
        "Move it to a server-only variable (remove the prefix) and use it only from server code or an API route. " +
        "If it held a real secret, revoke and replace it: it has already been published in every build.",
    };
  return {
    title: `${name} is not on the approved list of public variables`,
    advice:
      "If this value is meant to be public (an analytics ID, a public URL...), ask for it to be added to the approved list. " +
      "If it is a secret, remove the NEXT_PUBLIC_ prefix and read it on the server only.",
  };
}
