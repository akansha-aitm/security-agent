// Checks that cover the git history of the branches in scope (every commit reachable from them).
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, run, warn } from "../util.mjs";
import { isEnvFile } from "./branch.mjs";

/** .env files that were added at some point in history and are no longer on any branch tip.
 * revs: the branch tips to walk back from (default: every ref). */
export function envFilesInHistory(dir, filesAtTips, revs = ["--all"]) {
  const out = git(dir, ["log", ...revs, "--diff-filter=A", "--name-only", "--format=%x01%h%x09%aI"], { allowFail: true }) ?? "";
  const first = new Map(); // path -> oldest commit that added it
  let commit = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("\x01")) {
      const [sha, date] = line.slice(1).split("\t");
      commit = { sha, date: date?.slice(0, 10) };
    } else if (line.trim() && commit && isEnvFile(line.trim())) {
      first.set(line.trim(), commit); // log is newest first, so the last write is the oldest commit
    }
  }
  const items = [];
  for (const [path, c] of first) {
    if (filesAtTips.has(path)) continue; // still present: already reported by the branch check
    items.push({
      fp: `env-history|${path}`,
      check: "env-history",
      severity: "critical",
      title: `.env file still in the git history: ${path}`,
      detail: `added in commit ${c.sha} on ${c.date}`,
      advice:
        "The file was deleted later, but its contents remain in the history, in every clone and fork, and in merge request diffs. " +
        "Treat every key it contained as leaked: revoke and replace them.",
    });
  }
  return items;
}

/**
 * Runs gitleaks over the history of the given branch tips (default: every ref). Returns null when
 * gitleaks is not available, so that existing findings are not wrongly marked as fixed.
 */
export function gitleaksScan(dir, revs = null, bin = process.env.GITLEAKS_BIN ?? "gitleaks") {
  if (run(bin, ["version"], { allowFail: true }) === null) {
    warn(`gitleaks not found (${bin}): secret scan skipped`);
    return null;
  }
  const tmp = mkdtempSync(join(tmpdir(), "secscan-"));
  try {
    // Our own config, so a scanned repo cannot weaken detection with its own .gitleaks.toml,
    // and an empty ignore folder so its .gitleaksignore is not used either.
    const config = join(tmp, "gitleaks.toml");
    writeFileSync(config, "[extend]\nuseDefault = true\n");
    const report = join(tmp, "report.json");
    run(bin, [
      "git",
      "--no-banner",
      "--redact",
      "--exit-code", "0",
      "--log-level", "error",
      "--timeout", "1800",
      "--config", config,
      "--gitleaks-ignore-path", tmp,
      "--ignore-gitleaks-allow",
      "--report-format", "json",
      "--report-path", report,
      ...(revs?.length ? ["--log-opts", `--full-history ${revs.join(" ")}`] : []),
      dir,
    ]);
    const leaks = JSON.parse(readFileSync(report, "utf8") || "[]");
    const grouped = new Map();
    for (const l of leaks) {
      const fp = `secret|${l.RuleID}|${l.File}`;
      const g = grouped.get(fp) ?? { rule: l.RuleID, description: l.Description, file: l.File, commits: [] };
      g.commits.push({ sha: String(l.Commit).slice(0, 8), line: l.StartLine, author: l.Author, date: String(l.Date).slice(0, 10) });
      grouped.set(fp, g);
    }
    return [...grouped].map(([fp, g]) => {
      const oldest = g.commits.at(-1);
      return {
        fp,
        check: "secret",
        severity: "critical",
        title: `Secret in git history: ${g.description} in ${g.file}`,
        detail:
          `line ${oldest.line}, commit ${oldest.sha} by ${oldest.author} on ${oldest.date}` +
          (g.commits.length > 1 ? ` (found in ${g.commits.length} commits)` : ""),
        advice:
          "Revoke and replace the key first, then remove it from the code. Deleting the line or the branch, or rewriting history, " +
          "is not enough: clones, forks, CI caches and merge request diffs keep the old commit. " +
          "If this is a false positive (test data), tell the security agent maintainers so the rule can be tuned.",
      };
    });
  } finally {
    rmSync(tmp, { recursive: true, force: true }); // the report is redacted, but do not leave it around
  }
}
