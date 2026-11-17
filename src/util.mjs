import { spawnSync } from "node:child_process";

// Environment variables whose values must never reach logs, errors or emails.
const SECRET_ENV_NAMES = ["GITHUB_SCAN_TOKEN", "GITLAB_TOKEN", "SMTP_PASS"];

export function scrub(text = "") {
  let out = String(text);
  for (const name of SECRET_ENV_NAMES) {
    const raw = process.env[name];
    if (!raw || raw.length < 6) continue;
    // Gmail shows App Passwords in groups of 4 ("abcd efgh ..."): redact both spellings.
    for (const value of new Set([raw, raw.replace(/\s+/g, "")])) {
      out = out.split(value).join("[redacted]");
      for (const user of ["oauth2", "x-access-token"])
        out = out.split(Buffer.from(`${user}:${value}`).toString("base64")).join("[redacted]");
    }
  }
  return out;
}

export const log = (...parts) => console.log(scrub(parts.join(" ")));
export const warn = (...parts) => console.warn(scrub(`WARN ${parts.join(" ")}`));

/**
 * Runs a command without a shell. Returns stdout, or null when allowFail is set and the
 * command fails (git grep exits 1 when nothing matches, cat-file fails on missing files...).
 */
export function run(cmd, args, { cwd, env, allowFail = false } = {}) {
  const result = spawnSync(cmd, args, {
    cwd,
    env: env ? { ...process.env, ...env } : process.env,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    if (allowFail) return null;
    const reason = result.error ? result.error.message : `exit ${result.status}: ${result.stderr}`;
    throw new Error(scrub(`${cmd} ${args.slice(0, 3).join(" ")} failed (${reason})`).slice(0, 800));
  }
  return result.stdout;
}

export const git = (dir, args, opts) => run("git", ["-C", dir, "-c", "core.quotePath=false", ...args], opts);

export const SEVERITIES = ["critical", "high", "medium", "low", "review"];
export const SEVERITY_LABEL = {
  critical: "CRITICAL",
  high: "HIGH",
  medium: "MEDIUM",
  low: "LOW",
  review: "TO BE VALIDATED",
};
// Fix deadlines from the ai-to-market-security skill (references/3-dependencies.md).
export const DEADLINE = {
  critical: "within 48 hours",
  high: "within 7 days",
  medium: "within 30 days",
  low: "at the next monthly maintenance",
  review: "decide: add it to the approved list, or move it to the server",
};
export const bySeverity = (a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity);
