// Adds the endpoint test material to an existing sample repo (made by make-sample-app.mjs):
//   - on main: .github/workflows/notify-security-agent.yml (asks the agent to scan after each push)
//   - new branch feature/api-routes: safe and unsafe API routes (test/sample-routes.mjs)
//   node test/add-sample-routes.mjs ../security-agent-sample-app
// Then push main first, then feature/api-routes (see docs/TESTING.md, section 8).
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
const workflow = join(target, ".github/workflows/notify-security-agent.yml");
mkdirSync(dirname(workflow), { recursive: true });
copyFileSync(fileURLToPath(new URL("../templates/notify-security-agent.yml", import.meta.url)), workflow);
g("add", "-A");
g("commit", "-q", "-m", "Ask the security agent to scan after each push");

g("checkout", "-q", "-b", "feature/api-routes");
for (const [path, text] of Object.entries(SAMPLE_ROUTES)) {
  mkdirSync(dirname(join(target, path)), { recursive: true });
  writeFileSync(join(target, path), text.replace(/^\n/, ""));
}
g("add", "-A");
g("commit", "-q", "-m", "API routes: safe and unsafe examples for the endpoint checks");
g("checkout", "-q", "main");

console.log("Added: notify workflow on main, branch feature/api-routes with planted routes.");
console.log("Push main first, then: git push -u origin feature/api-routes");
