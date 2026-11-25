// Creates a realistic Next.js sample repository with planted security issues, to test the agent
// end to end on GitHub. All keys are fake and generated at runtime.
//   node test/make-sample-app.mjs <target-dir> [--author you@company.com]
// Only the dev/ branches are scanned; main is there as the base they start from.
// Then push it to a PRIVATE GitHub repository with all branches (see docs/TESTING.md).
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { randomBytes } from "node:crypto";
import { run } from "../src/util.mjs";
import { fakeAnthropicKey, fakeOpenAiKey } from "./make-fixture.mjs";

const alnum = (n) => {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  return [...randomBytes(n)].map((b) => chars[b % chars.length]).join("");
};
const fakeGitHubToken = () => ["gh", "p_", alnum(36)].join("");
const fakeSupabaseSecret = () => ["sb", "_secret_", alnum(32)].join("");

const { values, positionals } = parseArgs({ allowPositionals: true, options: { author: { type: "string" } } });
const target = resolve(positionals[0] ?? "../security-agent-sample-app");
const owner = values.author ?? "sample-app@example.com"; // commit author only: alerts go to the tech leads
if (existsSync(target)) {
  console.error(`${target} already exists: delete it first or choose another folder`);
  process.exit(1);
}

mkdirSync(target, { recursive: true });
const env = { GIT_AUTHOR_NAME: "Sample App", GIT_AUTHOR_EMAIL: owner, GIT_COMMITTER_NAME: "Sample App", GIT_COMMITTER_EMAIL: owner };
const g = (...args) => run("git", ["-C", target, ...args], { env });
const write = (path, text) => {
  mkdirSync(dirname(join(target, path)), { recursive: true });
  writeFileSync(join(target, path), text.replace(/^\n/, ""));
};
const commit = (msg) => {
  g("add", "-A");
  g("commit", "-q", "-m", msg);
};

run("git", ["init", "-q", "-b", "main", target]);
g("config", "commit.gpgsign", "false");

// ---------------------------------------------------------------- main
write(
  "package.json",
  JSON.stringify({ name: "security-agent-sample-app", private: true, scripts: { dev: "next dev" }, dependencies: { next: "16.0.0", react: "19.2.0", "react-dom": "19.2.0" } }, null, 2) + "\n",
);
write(".gitignore", "\nnode_modules\n.next\n# create-next-app used to ignore only local env files\n.env*.local\n");
write(
  "README.md",
  "\n# Security agent sample app\n\nTest repository with **planted, fake** security issues. Nothing here is a real key.\nUsed to check that the security agent detects and reports each issue.\n",
);
write(".env.example", "\nNEXT_PUBLIC_SUPABASE_URL=\nNEXT_PUBLIC_SUPABASE_ANON_KEY=\n");
write(
  "next.config.mjs",
  "\n/** @type {import('next').NextConfig} */\nconst nextConfig = {\n  // PLANTED: the env key copies these values into the browser bundle\n  env: {\n    STRIPE_KEY: process.env.STRIPE_KEY,\n  },\n};\n\nexport default nextConfig;\n",
);
write(
  "lib/supabase/client.ts",
  "\nimport { createBrowserClient } from \"@supabase/ssr\";\n\n// PLANTED (low): legacy anon key, to migrate to the publishable key\nexport const supabase = createBrowserClient(\n  process.env.NEXT_PUBLIC_SUPABASE_URL!,\n  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,\n);\n",
);
write("app/page.tsx", "\nexport default function Home() {\n  return <main>Sample app</main>;\n}\n");
commit("Initial Next.js app");

write(
  "components/analytics.tsx",
  "\n\"use client\";\n// PLANTED (to be validated): public variables not on the approved list\nexport const posthogKey = process.env.NEXT_PUBLIC_POSTHOG_KEY;\nexport const gaId = process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID;\n",
);
commit("Add analytics");

// PLANTED (critical): a .env.local committed by mistake, then deleted. Still in the history.
write(".env.local", `\nSUPABASE_SECRET_KEY=${fakeSupabaseSecret()}\nGITHUB_TOKEN=${fakeGitHubToken()}\n`);
g("add", "-f", ".env.local"); // .gitignore excludes it: someone forced it in
commit("Add local config");
g("rm", "-q", ".env.local");
commit("Remove local config");

// ---------------------------------------------------------------- dev/ai-chat
g("checkout", "-q", "-b", "dev/ai-chat");
write(
  "components/chat.tsx",
  "\n\"use client\";\n// PLANTED (critical): the OpenAI key is shipped to every visitor's browser\nexport async function ask(prompt: string) {\n  const res = await fetch(\"https://api.openai.com/v1/chat/completions\", {\n    method: \"POST\",\n    headers: { Authorization: `Bearer ${process.env.NEXT_PUBLIC_OPENAI_API_KEY}` },\n    body: JSON.stringify({ model: \"gpt-5\", messages: [{ role: \"user\", content: prompt }] }),\n  });\n  return res.json();\n}\n",
);
// PLANTED (critical): .env committed on a dev/ branch
write(".env", `\nNEXT_PUBLIC_OPENAI_API_KEY=${fakeOpenAiKey()}\n`);
commit("AI chat prototype");

// ---------------------------------------------------------------- dev/payments
g("checkout", "-q", "main");
g("checkout", "-q", "-b", "dev/payments");
write(
  "lib/stripe.ts",
  "\n// PLANTED (critical): a secret key with the NEXT_PUBLIC_ prefix\nexport const stripeKey = process.env.NEXT_PUBLIC_STRIPE_SECRET_KEY;\n",
);
write(
  "middleware.ts",
  "\n// PLANTED (high): a security switch readable in the browser\nexport function isDemo() {\n  return process.env.NEXT_PUBLIC_DEMO_MODE === \"true\";\n}\n",
);
write(
  "lib/summarize.ts",
  `\n// PLANTED (critical): hard-coded API key\nconst ANTHROPIC_API_KEY = "${fakeAnthropicKey()}";\nexport const headers = { "x-api-key": ANTHROPIC_API_KEY };\n`,
);
commit("Payments and summaries");

// ---------------------------------------------------------------- dev/clean
g("checkout", "-q", "main");
g("checkout", "-q", "-b", "dev/clean");
write(".gitignore", "\nnode_modules\n.next\n.env*\n!.env.example\n");
write("next.config.mjs", "\n/** @type {import('next').NextConfig} */\nconst nextConfig = {};\n\nexport default nextConfig;\n");
write(
  "lib/supabase/client.ts",
  "\nimport { createBrowserClient } from \"@supabase/ssr\";\n\nexport const supabase = createBrowserClient(\n  process.env.NEXT_PUBLIC_SUPABASE_URL!,\n  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,\n);\n",
);
write(".env.example", "\nNEXT_PUBLIC_SUPABASE_URL=\nNEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=\n");
write("components/analytics.tsx", "\nexport const analytics = null; // analytics removed\n");
commit("Fix env handling");

g("checkout", "-q", "main");
console.log(`Sample app created in ${target}`);
console.log("Branches: main, dev/ai-chat, dev/payments, dev/clean");
console.log("Optional: node test/add-sample-routes.mjs <dir> adds the API-route examples.");
console.log("Next: create a PRIVATE GitHub repo and push all branches (see docs/TESTING.md).");
