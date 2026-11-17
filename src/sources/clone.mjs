import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { git, run } from "../util.mjs";

/**
 * Bare clone (or fetch) with every branch. The credentials go through git's environment
 * configuration: never on the command line, never in the remote URL stored on disk.
 */
export function syncBareClone(cloneUrl, dir, basicCredentials) {
  const env = {
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.extraHeader",
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(basicCredentials).toString("base64")}`,
  };
  if (existsSync(join(dir, "HEAD"))) {
    git(dir, ["fetch", "--prune", "--quiet", "origin", "+refs/heads/*:refs/heads/*"], { env });
  } else {
    mkdirSync(dirname(dir), { recursive: true });
    run("git", ["clone", "--bare", "--quiet", cloneUrl, dir], { env });
  }
}
