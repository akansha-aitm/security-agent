// Adds the endpoint test material to an existing sample repo (made by make-sample-app.mjs):
// a new branch feature/api-routes with safe and unsafe API routes (test/sample-routes.mjs).
//   node test/add-sample-routes.mjs ../security-agent-sample-app
// Then push the branch (see docs/TESTING.md, section 7).
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { run } from "../src/util.mjs";
import { SAMPLE_ROUTES } from "./sample-routes.mjs";

const target = resolve(process.argv[2] ?? "../security-agent-sample-app");
if (!existsSync(join(target, ".git"))) {
  console.error(`usage: node test/add-sample-routes.mjs <sample repo>  (${target} is not a git repository)`);
  process.exit(1);
}
const g = (...args) => run("git", ["-C", target, ...args]);
if (g("status", "--porcelain").trim()) {
  console.error("The sample repo has uncommitted changes: commit or stash them first.");
  process.exit(1);
}
if (g("branch", "--list", "feature/api-routes").trim()) {
  console.error("Branch feature/api-routes already exists in the sample repo.");
  process.exit(1);
}

g("checkout", "-q", "main");
g("checkout", "-q", "-b", "feature/api-routes");
for (const [path, text] of Object.entries(SAMPLE_ROUTES)) {
  mkdirSync(dirname(join(target, path)), { recursive: true });
  writeFileSync(join(target, path), text.replace(/^\n/, ""));
}
g("add", "-A");
g("commit", "-q", "-m", "API routes: safe and unsafe examples for the endpoint checks");
g("checkout", "-q", "main");

console.log("Added: branch feature/api-routes with planted routes.");
console.log("Next: git push -u origin feature/api-routes");
