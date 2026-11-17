#!/usr/bin/env node
// CLI entry point. Configuration comes from environment variables (GitHub Actions secrets/variables).
//
//   node src/index.mjs                       scan changed branches, alert new critical findings
//   node src/index.mjs --full                rescan every branch (after a rule/allowlist change)
//   node src/index.mjs --digest              also send the weekly digest
//   node src/index.mjs --inventory           list NEXT_PUBLIC_ variables only (no alerts)
//   node src/index.mjs --local <repo> --dry-run    test on a local repository, emails written to out/
import { parseArgs } from "node:util";
import { runAgent } from "./agent.mjs";
import { scrub } from "./util.mjs";

const { values } = parseArgs({
  options: {
    local: { type: "string", multiple: true },
    full: { type: "boolean", default: false },
    digest: { type: "boolean", default: false },
    inventory: { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
    state: { type: "string", default: process.env.STATE_PATH ?? ".state/state.json" },
    out: { type: "string", default: "out" },
  },
});

const list = (v) => (v ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

function sourceConfig() {
  const kind = (process.env.SOURCE || "github").toLowerCase();
  const repos = list(process.env.REPOS);
  // Never scan the agent's own repository: its tests contain planted (fake) issues by design.
  const exclude = list(process.env.EXCLUDE_REPOS).concat(list(process.env.GITHUB_REPOSITORY));
  if (kind === "gitlab")
    return { kind, url: process.env.GITLAB_URL || "https://gitlab.com", token: process.env.GITLAB_TOKEN, group: process.env.GITLAB_GROUP, repos, exclude };
  return { kind, apiUrl: process.env.GITHUB_API_URL || "https://api.github.com", token: process.env.GITHUB_SCAN_TOKEN, owner: process.env.GITHUB_OWNER || process.env.GITHUB_ORG, repos, exclude };
}
// Emails are only sent when explicitly enabled, so a misconfigured run cannot spam anyone.
const dryRun = values["dry-run"] || process.env.SEND_EMAILS !== "true";

try {
  const { summary } = await runAgent({
    local: values.local ?? [],
    full: values.full,
    digest: values.digest,
    inventory: values.inventory,
    dryRun,
    statePath: values.state,
    outDir: values.out,
    workDir: process.env.WORK_DIR ?? ".work",
    source: sourceConfig(),
    settings: {
      allowedDomains: list(process.env.ALLOWED_EMAIL_DOMAINS),
      fallback: process.env.FALLBACK_EMAIL?.trim().toLowerCase() || null,
      redirectTo: process.env.REDIRECT_EMAILS_TO?.trim() || null,
    },
  });
  process.exitCode = summary.errors ? 1 : 0;
} catch (e) {
  console.error(scrub(`ERROR ${e.message}`));
  process.exitCode = 2;
}
