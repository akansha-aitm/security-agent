import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { git } from "../util.mjs";

/**
 * Bare copy holding only the given branches (the branches in scope), without tags. Anything else
 * (out-of-scope or deleted branches, tags from an older full clone) is removed, so the history
 * checks only see commits reachable from the branches in scope.
 * The credentials go through git's environment configuration: never on the command line, never on disk.
 */
export function syncBareClone(cloneUrl, dir, basicCredentials, branches) {
  const env = {
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.extraHeader",
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(basicCredentials).toString("base64")}`,
  };
  if (!existsSync(join(dir, "HEAD"))) {
    mkdirSync(dir, { recursive: true });
    git(dir, ["init", "--bare", "--quiet"]);
  }
  const refspecs = branches.map((b) => `+refs/heads/${b}:refs/heads/${b}`);
  git(dir, ["fetch", "--quiet", "--no-tags", "--", cloneUrl, ...refspecs], { env });
  const wanted = new Set(branches.map((b) => `refs/heads/${b}`));
  const refs = git(dir, ["for-each-ref", "--format=%(refname)", "refs/heads", "refs/tags"]).split("\n").filter(Boolean);
  for (const ref of refs) if (!wanted.has(ref)) git(dir, ["update-ref", "-d", ref]);
}
