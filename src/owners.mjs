// Finds who should receive a repo's alerts, in this order:
//   1. CODEOWNERS on the default branch
//   2. people given admin/maintainer rights directly on the repo (GitHub) or project (GitLab)
//   3. most active committer of the last 90 days
//   4. nobody (the fallback recipient takes it)
// Usernames are turned into work emails with the public profile email, then config/user-emails.json,
// then the email used in their commits.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { git, warn } from "./util.mjs";

const CODEOWNERS_PATHS = ["CODEOWNERS", ".github/CODEOWNERS", ".gitlab/CODEOWNERS", "docs/CODEOWNERS"];
const BOT_RE = /\[bot\]|bot@|github-actions|gitlab-ci|dependabot|renovate/i;
const NOREPLY_RE = /noreply|no-reply/i;
const GITHUB_NOREPLY_RE = /^(?:\d+\+)?([^@]+)@users\.noreply\.github\.com$/i;
const DEFAULT_DIRECTORY = fileURLToPath(new URL("../config/user-emails.json", import.meta.url));

/** Optional username -> work email map, for people whose GitHub email is private. */
export function loadDirectory(path = process.env.USER_EMAILS_PATH ?? DEFAULT_DIRECTORY) {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    return Object.fromEntries(
      Object.entries(raw)
        .filter(([k]) => !k.startsWith("_"))
        .map(([k, v]) => [k.toLowerCase(), String(v).toLowerCase()]),
    );
  } catch {
    return {};
  }
}

export function parseCodeowners(text) {
  const rules = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const section = line.match(/^\^?\[[^\]]+\](?:\[\d+\])?\s*(.*)$/); // GitLab "[Section] @default-owners"
    if (section) {
      if (section[1]) rules.push({ pattern: "*", owners: section[1].split(/\s+/) });
      continue;
    }
    const [pattern, ...owners] = line.split(/\s+/);
    rules.push({ pattern, owners });
  }
  const catchAll = rules.filter((r) => r.pattern === "*" || r.pattern === "/" || r.pattern === "/**");
  const chosen = (catchAll.length ? catchAll : rules).flatMap((r) => r.owners);
  return [...new Set(chosen.filter((o) => o.includes("@")))];
}

export function topCommitters(dir, since) {
  const args = ["shortlog", "-sne", "--all"];
  if (since) args.push(`--since=${since}`);
  const out = git(dir, args, { allowFail: true }) ?? "";
  return out
    .split("\n")
    .map((l) => l.match(/^\s*(\d+)\t(.*) <(.*)>$/))
    .filter(Boolean)
    .map((m) => ({ commits: Number(m[1]), name: m[2], email: m[3].toLowerCase() }))
    .filter((c) => c.email.includes("@") && !BOT_RE.test(c.email) && !BOT_RE.test(c.name));
}

export async function resolveOwners({ dir, defaultSha, provider = null, target = null, directory = {} }) {
  const everyone = topCommitters(dir);
  const realEmail = (e) => e && !NOREPLY_RE.test(e);
  const lookupUser = async (username) => {
    if (!provider) return null;
    try {
      return await provider.findUser(username);
    } catch (e) {
      warn(`could not look up user ${username}: ${e.message}`);
      return null;
    }
  };

  const emailForUser = (user) => {
    if (realEmail(user.email)) return user.email.toLowerCase();
    if (directory[user.username?.toLowerCase()]) return directory[user.username.toLowerCase()];
    const name = user.name?.toLowerCase();
    const match =
      everyone.find((c) => realEmail(c.email) && name && c.name.toLowerCase() === name) ??
      everyone.find((c) => realEmail(c.email) && c.email.split("@")[0] === user.username?.toLowerCase());
    return match?.email ?? null;
  };

  const emailForUsername = async (username) =>
    directory[username.toLowerCase()] ?? emailForUser((await lookupUser(username)) ?? { username });

  const emailForCommitter = async (c) => {
    const gh = c.email.match(GITHUB_NOREPLY_RE);
    if (gh) return emailForUsername(gh[1]);
    return realEmail(c.email) ? c.email : null;
  };

  // 1. CODEOWNERS
  if (defaultSha) {
    for (const path of CODEOWNERS_PATHS) {
      const text = git(dir, ["cat-file", "blob", `${defaultSha}:${path}`], { allowFail: true });
      if (!text) continue;
      const emails = [];
      for (const owner of parseCodeowners(text)) {
        if (!owner.startsWith("@")) emails.push(owner.toLowerCase());
        else if (!owner.includes("/")) {
          const email = await emailForUsername(owner.slice(1));
          if (email) emails.push(email);
        } // @org/team entries are not expanded in the prototype
      }
      if (emails.length) return { emails: [...new Set(emails)].slice(0, 3), source: "codeowners", why: `you are listed in ${path}` };
    }
  }

  // 2. Admins/maintainers added directly on the repo
  if (provider && target) {
    try {
      const emails = (await provider.platformOwners(target)).map(emailForUser).filter(Boolean);
      if (emails.length)
        return {
          emails: [...new Set(emails)].slice(0, 3),
          source: "platform",
          why: `you are ${provider.ownerRoleLabel} (please add a CODEOWNERS file naming the tech lead)`,
        };
    } catch (e) {
      warn(`could not list the owners of ${target.name}: ${e.message}`);
    }
  }

  // 3. Most active committer whose work email can be found
  const recent = topCommitters(dir, "90.days.ago");
  for (const [list, label] of [
    [recent, " of the last 90 days"],
    [everyone, ""],
  ]) {
    for (const c of list.slice(0, 5)) {
      const email = await emailForCommitter(c);
      if (email)
        return {
          emails: [email],
          source: "committer",
          why: `you are the most active committer${label} and no owner is declared (please add a CODEOWNERS file naming the tech lead)`,
        };
    }
  }

  return { emails: [], source: "none", why: "no owner could be found for this repository" };
}
