// What the agent remembers between runs: branch tips already scanned, and every finding with
// its alert status. It stores locations only, never secret values.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const MAX_LOCATIONS_PER_BRANCH = 5;

export function loadState(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { version: 1, repos: {}, findings: {}, lastDigestAt: null };
  }
}

export function saveState(path, state) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 1));
}

const repoFindings = (state, repoKey) => Object.values(state.findings).filter((f) => f.repoKey === repoKey);

function upsert(state, repoKey, item, now) {
  const fp = `${repoKey}|${item.fp}`;
  let f = state.findings[fp];
  if (!f || f.status === "resolved") {
    // A finding that comes back after being fixed is treated as new, so it is alerted again.
    f = state.findings[fp] = { fp, repoKey, firstSeen: now, status: "open", alertedAt: null, branches: {} };
  }
  Object.assign(f, {
    check: item.check,
    severity: item.severity,
    title: item.title,
    advice: item.advice,
    detail: item.detail ?? null,
    repoLevel: !item.location,
    lastSeen: now,
  });
  return f;
}

function resolve(f, now) {
  f.status = "resolved";
  f.resolvedAt = now;
}

/** Replaces everything known about one branch of one repo with the latest scan results. */
export function applyBranchResults(state, repoKey, branch, items, now) {
  for (const f of repoFindings(state, repoKey)) if (!f.repoLevel) delete f.branches[branch];
  for (const item of items) {
    const f = upsert(state, repoKey, item, now);
    const locs = (f.branches[branch] ??= []);
    if (locs.length < MAX_LOCATIONS_PER_BRANCH && !locs.includes(item.location)) locs.push(item.location);
  }
}

export function forgetBranches(state, repoKey, branches) {
  for (const f of repoFindings(state, repoKey)) for (const b of branches) delete f.branches[b];
}

/** Replaces the repo-level results of the given checks (history scans). */
export function applyRepoResults(state, repoKey, checks, items, now) {
  const seen = new Set(items.map((i) => `${repoKey}|${i.fp}`));
  for (const f of repoFindings(state, repoKey))
    if (f.repoLevel && f.status === "open" && checks.includes(f.check) && !seen.has(f.fp)) resolve(f, now);
  for (const item of items) upsert(state, repoKey, item, now);
}

/** Branch-level findings that no longer appear on any branch are fixed. */
export function closeFixed(state, repoKey, now) {
  for (const f of repoFindings(state, repoKey))
    if (!f.repoLevel && f.status === "open" && Object.keys(f.branches).length === 0) resolve(f, now);
}
