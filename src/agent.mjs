// Orchestrates one run: pick repos, scan changed branches, update findings, send alerts.
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { createGitHubSource } from "./sources/github.mjs";
import { createGitLabSource } from "./sources/gitlab.mjs";
import { isEnvFile, listFiles, runBranchChecks } from "./checks/branch.mjs";
import { loadEndpointRules } from "./checks/endpoints.mjs";
import { envFilesInHistory, gitleaksScan } from "./checks/history.mjs";
import { loadDirectory, resolveOwners } from "./owners.mjs";
import { loadRules } from "./rules.mjs";
import { applyBranchResults, applyRepoResults, closeFixed, forgetBranches, loadState, saveState } from "./state.mjs";
import { buildEmails, deliver } from "./notify.mjs";
import { SEVERITIES, git, log, warn } from "./util.mjs";

const RESOLVED_RETENTION_DAYS = 90;

/**
 * options:
 *   local: string[]        scan these local repositories instead of GitHub/GitLab (testing)
 *   full: boolean          rescan every branch even if unchanged (after a rule or allowlist change)
 *   digest: boolean        send the weekly digest of all open findings
 *   inventory: boolean     only list NEXT_PUBLIC_ variables and API endpoints, no findings, no emails
 *   dryRun: boolean        write emails to outDir instead of sending. Scan progress is saved, but
 *                          nothing is marked as alerted, so going live later still sends every alert.
 *   send: function         replaces the email sender (tests)
 *   statePath, outDir, workDir, allowlistPath, endpointsPath
 *   source: { kind: "github", org, token, apiUrl, repos[], exclude[] }
 *        or { kind: "gitlab", group, token, url, repos[], exclude[] }   (ignored with local)
 *   settings: { allowedDomains[], fallback, redirectTo }
 */
export async function runAgent(options) {
  const { local = [], full = false, digest = false, inventory: inventoryOnly = false, dryRun = false } = options;
  const { statePath = ".state/state.json", outDir = "out", workDir = ".work", settings } = options;
  const now = options.now ?? new Date().toISOString();
  const rules = loadRules(options.allowlistPath);
  rules.endpoints = loadEndpointRules(options.endpointsPath);
  const state = loadState(statePath);
  const source = local.length ? null : createSource(options.source);
  const directory = loadDirectory(options.userEmailsPath);
  const summary = { repos: 0, reposScanned: 0, branchesScanned: 0, errors: 0, emailsSent: 0, undeliverable: 0 };

  // NEXT_PUBLIC_ inventory: name -> { classification, repos }
  const inventory = new Map();
  let currentRepo = "";
  const onVar = (name, classification) => {
    const entry = inventory.get(name) ?? { classification, repos: new Set() };
    entry.repos.add(currentRepo);
    inventory.set(name, entry);
  };
  // API endpoint inventory: "repo route" -> endpoint, with the branches it was seen on
  const endpoints = new Map();
  let currentBranch = "";
  const onEndpoint = (ep) => {
    const key = `${currentRepo} ${ep.route}`;
    const entry = endpoints.get(key) ?? { repo: currentRepo, ...ep, branches: new Set() };
    entry.branches.add(currentBranch);
    endpoints.set(key, entry);
  };

  const targets = local.length ? localTargets(local) : await source.listTargets();
  summary.repos = targets.length;
  log(`${targets.length} repositor${targets.length === 1 ? "y" : "ies"} to check`);

  for (const t of targets) {
    try {
      currentRepo = t.name;
      await scanTarget(t);
    } catch (e) {
      summary.errors++;
      warn(`${t.name}: ${e.message}`);
    }
  }

  async function scanTarget(t) {
    const prev = state.repos[t.key]?.branches ?? {};
    const force = full || inventoryOnly;

    if (source) {
      // Ask the API first, so unchanged repos are not even fetched.
      const remote = await source.listBranches(t);
      if (!Object.keys(remote).length) return; // empty repository
      if (!force && sameBranches(prev, remote)) return;
      t.dir = join(workDir, "repos", `${t.key.replace(":", "-")}.git`);
      source.syncClone(t, t.dir);
    }

    const branches = listBranches(t.dir, !source);
    const changed = Object.entries(branches).filter(([b, sha]) => force || prev[b] !== sha);
    const deleted = Object.keys(prev).filter((b) => !(b in branches));
    if (!changed.length && !deleted.length) return;
    summary.reposScanned++;
    log(`scanning ${t.name}: ${changed.length} changed branch(es), ${deleted.length} deleted`);

    for (const [branch, sha] of changed) {
      currentBranch = branch;
      const items = runBranchChecks(t.dir, sha, rules, { repo: t.name, onVar, onEndpoint });
      if (!inventoryOnly) applyBranchResults(state, t.key, branch, items, now);
      summary.branchesScanned++;
    }
    if (inventoryOnly) return;
    forgetBranches(state, t.key, deleted);

    // History checks cover every commit of every branch.
    const envAtTips = new Set(Object.values(branches).flatMap((sha) => listFiles(t.dir, sha).filter(isEnvFile)));
    applyRepoResults(state, t.key, ["env-history"], envFilesInHistory(t.dir, envAtTips), now);
    const leaks = gitleaksScan(t.dir);
    if (leaks) applyRepoResults(state, t.key, ["secret"], leaks, now);
    closeFixed(state, t.key, now);

    const defaultBranch = t.defaultBranch ?? localDefaultBranch(t.dir, branches);
    const owners = await resolveOwners({
      dir: t.dir,
      defaultSha: branches[defaultBranch],
      provider: source,
      target: source ? t : null,
      directory,
    });
    state.repos[t.key] = { name: t.name, webUrl: t.webUrl, branches, owners, scannedAt: now };
  }

  if (inventoryOnly) {
    writeInventory(inventory, outDir);
    writeEndpointInventory(endpoints, outDir);
    return { state, inventory, endpoints, summary, emails: [] };
  }

  // Alerts: new critical findings right away; everything open in the weekly digest.
  const all = Object.values(state.findings);
  const open = all.filter((f) => f.status === "open");
  let batch;
  if (digest) {
    const since = state.lastDigestAt;
    const resolvedSince = all.filter((f) => f.status === "resolved" && (!since || f.resolvedAt > since));
    batch = buildEmails(open, { state, kind: "digest", settings, resolvedSince });
  } else {
    batch = buildEmails(open.filter((f) => f.severity === "critical" && !f.alertedAt), { state, kind: "immediate", settings });
  }
  const send = options.send ?? deliver;
  const delivered = await send(batch.emails, { dryRun, outDir, redirectTo: settings.redirectTo });
  if (!dryRun) {
    for (const fp of delivered.flatMap((e) => e.fps)) state.findings[fp].alertedAt ??= now;
    if (digest && delivered.length === batch.emails.length) state.lastDigestAt = now;
  }
  summary.emailsSent = delivered.length;
  summary.dryRun = dryRun;
  summary.undeliverable = batch.undeliverable.length;
  if (batch.undeliverable.length)
    warn(`${batch.undeliverable.length} finding(s) have no recipient: set FALLBACK_EMAIL or add CODEOWNERS files`);

  // Forget findings fixed a long time ago.
  const cutoff = new Date(Date.parse(now) - RESOLVED_RETENTION_DAYS * 86400e3).toISOString();
  for (const f of all) if (f.status === "resolved" && f.resolvedAt < cutoff) delete state.findings[f.fp];

  saveState(statePath, state);
  writeSummary(state, summary);
  return { state, inventory, summary, emails: batch.emails };
}

function createSource(config = {}) {
  if (config.kind === "gitlab") return createGitLabSource(config);
  if (config.kind === "github") return createGitHubSource(config);
  throw new Error(`unknown SOURCE "${config.kind}" (expected github or gitlab)`);
}

function localTargets(paths) {
  return paths.map((p) => ({ key: `local:${resolve(p)}`, name: basename(resolve(p)), dir: resolve(p), webUrl: null }));
}

/** Branch name -> tip commit. Local repos also include remote-tracking branches not checked out locally. */
function listBranches(dir, includeRemotes) {
  const refs = includeRemotes ? ["refs/heads", "refs/remotes"] : ["refs/heads"];
  const out = git(dir, ["for-each-ref", "--format=%(refname)%09%(objectname)", ...refs]);
  const heads = {};
  const remotes = {};
  for (const line of out.split("\n").filter(Boolean)) {
    const [ref, sha] = line.split("\t");
    if (ref.startsWith("refs/heads/")) heads[ref.slice(11)] = sha;
    else if (!ref.endsWith("/HEAD")) remotes[ref.slice(13)] = sha;
  }
  for (const [name, sha] of Object.entries(remotes)) {
    const short = name.slice(name.indexOf("/") + 1);
    if (!(short in heads)) heads[name] = sha;
  }
  return heads;
}

function localDefaultBranch(dir, branches) {
  const head = git(dir, ["symbolic-ref", "--short", "HEAD"], { allowFail: true })?.trim();
  if (head && head in branches) return head;
  return ["main", "master"].find((b) => b in branches) ?? Object.keys(branches)[0];
}

function sameBranches(a, b) {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]);
}

function writeInventory(inventory, outDir) {
  mkdirSync(outDir, { recursive: true });
  const rows = [...inventory]
    .map(([name, e]) => ({ name, status: e.classification.status, severity: e.classification.severity ?? "", repos: [...e.repos].sort() }))
    .sort((a, b) => a.status.localeCompare(b.status) || b.repos.length - a.repos.length || a.name.localeCompare(b.name));
  const csv = ["variable,classification,severity,repo_count,repos"]
    .concat(rows.map((r) => `${r.name},${r.status},${r.severity},${r.repos.length},"${r.repos.join(" ")}"`))
    .join("\n");
  writeFileSync(join(outDir, "public-env-inventory.csv"), csv + "\n");
  log(`inventory: ${rows.length} NEXT_PUBLIC_ variable(s) written to ${join(outDir, "public-env-inventory.csv")}`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const md = ["## NEXT_PUBLIC_ inventory", "", "| Variable | Classification | Repos |", "|---|---|---|"]
      .concat(rows.map((r) => `| \`${r.name}\` | ${r.status}${r.severity && r.severity !== "review" ? ` (${r.severity})` : ""} | ${r.repos.length} |`))
      .join("\n");
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + "\n");
  }
}

function writeEndpointInventory(endpoints, outDir) {
  mkdirSync(outDir, { recursive: true });
  const rows = [...endpoints.values()].sort((a, b) => a.repo.localeCompare(b.repo) || a.route.localeCompare(b.route));
  const q = (v) => `"${String(v).replace(/"/g, '""')}"`;
  const csv = ["repo,endpoint,file,kind,methods,categories,access,issues,branches"]
    .concat(rows.map((e) => [e.repo, e.route, e.file, e.kind, e.methods.join(" "), e.categories.join(" "), e.access, e.issues, [...e.branches].sort().join(" ")].map(q).join(",")))
    .join("\n");
  writeFileSync(join(outDir, "endpoint-inventory.csv"), csv + "\n");
  log(`inventory: ${rows.length} API endpoint(s) written to ${join(outDir, "endpoint-inventory.csv")}`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const md = ["## API endpoints", "", "| Repo | Endpoint | Kind | Calls | Access | Issues |", "|---|---|---|---|---|---|"]
      .concat(rows.map((e) => `| ${e.repo} | \`${e.route}\` | ${e.kind} | ${e.categories.join(" + ")} | ${e.access} | ${e.issues} |`))
      .join("\n");
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + "\n");
  }
}

/** Counts only: job logs and summaries are visible to everyone with access to the agent's repo. */
function writeSummary(state, summary) {
  const open = Object.values(state.findings).filter((f) => f.status === "open");
  const counts = SEVERITIES.map((s) => `${s}: ${open.filter((f) => f.severity === s).length}`).join(", ");
  const emailLine = summary.dryRun
    ? `${summary.emailsSent} NOT sent (dry run: set the variable SEND_EMAILS to true to send)`
    : `${summary.emailsSent} sent`;
  log(
    `done: ${summary.reposScanned}/${summary.repos} repos and ${summary.branchesScanned} branches scanned, ` +
      `${summary.errors} error(s), emails: ${emailLine}. Open findings: ${counts}`,
  );
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `## Security scan\n\n- Repos scanned: ${summary.reposScanned}/${summary.repos}\n- Branches scanned: ${summary.branchesScanned}\n` +
        `- Errors: ${summary.errors}\n- Emails: ${emailLine}\n- Open findings: ${counts}\n`,
    );
}
