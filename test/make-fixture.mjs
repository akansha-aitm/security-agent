// Creates a throwaway git repository with planted security issues on several branches.
// Only dev/ branches are in scope; main and feature/old are there to prove they are ignored.
// Fake keys are generated at runtime so that this file itself contains nothing secret-shaped.
//   node test/make-fixture.mjs [target-dir]
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import { run } from "../src/util.mjs";

const alnum = (n) => {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  return [...randomBytes(n)].map((b) => chars[b % chars.length]).join("");
};
const b64url = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");

export const fakeOpenAiKey = () => ["sk", "-", alnum(20), "T3Blbk", "FJ", alnum(20)].join("");
export const fakeAnthropicKey = () => ["sk", "-ant-", "api03-", alnum(93), "AA"].join("");
export const fakeServiceRoleJwt = () =>
  [b64url({ alg: "HS256", typ: "JWT" }), b64url({ iss: "supabase", ref: "fixture", role: ["service", "role"].join("_") }), alnum(43)].join(".");

export function makeFixture(target = mkdtempSync(join(tmpdir(), "secagent-fixture-"))) {
  const dir = resolve(target);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const env = {
    GIT_AUTHOR_NAME: "Tech Lead",
    GIT_AUTHOR_EMAIL: "tech.lead@example.com",
    GIT_COMMITTER_NAME: "Tech Lead",
    GIT_COMMITTER_EMAIL: "tech.lead@example.com",
  };
  const g = (...args) => run("git", ["-C", dir, ...args], { env });
  const write = (path, text) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  };
  const commit = (msg) => {
    g("add", "-A");
    g("commit", "-q", "-m", msg);
  };

  run("git", ["init", "-q", "-b", "main", dir]);
  g("config", "commit.gpgsign", "false");

  // main: old create-next-app .gitignore (does not ignore .env), legacy anon key, next.config env key
  write("package.json", JSON.stringify({ name: "fixture-app", private: true }, null, 2));
  write(".gitignore", "node_modules\n.next\n.env*.local\n");
  write(
    "src/lib/supabase.ts",
    "export const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;\nexport const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;\n",
  );
  write("next.config.js", "module.exports = {\n  env: {\n    BUILD_ID: process.env.BUILD_ID,\n  },\n};\n");
  write("README.md", "Set NEXT_PUBLIC_README_ONLY in your env.\n");
  commit("initial app");

  // main: a .env.production committed then deleted -> still in history
  write(".env.production", `ANTHROPIC_API_KEY=${fakeAnthropicKey()}\n`);
  commit("add prod env");
  g("rm", "-q", ".env.production");
  commit("remove prod env");

  // dev/ai: AI key exposed with NEXT_PUBLIC_, an unknown public var, a committed .env
  g("checkout", "-q", "-b", "dev/ai");
  write(
    "src/lib/ai.ts",
    "const key = process.env.NEXT_PUBLIC_OPENAI_API_KEY;\nconst ph = process.env.NEXT_PUBLIC_POSTHOG_KEY;\nexport { key, ph };\n",
  );
  write(".env", `NEXT_PUBLIC_OPENAI_API_KEY=${fakeOpenAiKey()}\nNEXT_PUBLIC_SUPABASE_KEY=${fakeServiceRoleJwt()}\n`);
  commit("ai feature");

  // dev/clean: everything done right
  g("checkout", "-q", "main");
  g("checkout", "-q", "-b", "dev/clean");
  write(".gitignore", "node_modules\n.next\n.env*\n!.env.example\n");
  write("src/lib/supabase.ts", "export const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;\nexport const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;\n");
  write("next.config.js", "module.exports = {};\n");
  write(".env.example", "NEXT_PUBLIC_SUPABASE_URL=\nNEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=\n");
  commit("clean setup");

  // feature/old: out of scope (not a dev/ branch), so its critical issue must never be reported
  g("checkout", "-q", "main");
  g("checkout", "-q", "-b", "feature/old");
  write("src/lib/pay.ts", "export const k = process.env.NEXT_PUBLIC_STRIPE_SECRET;\n");
  commit("old feature");

  g("checkout", "-q", "main");
  return dir;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(makeFixture(process.argv[2]));
}
