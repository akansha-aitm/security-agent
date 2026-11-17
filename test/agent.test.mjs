import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyVar, loadRules, secretKindOfValue } from "../src/rules.mjs";
import { gitignoreIgnoresEnv, isEnvFile } from "../src/checks/branch.mjs";
import { parseCodeowners } from "../src/owners.mjs";
import { runAgent } from "../src/agent.mjs";
import { fakeAnthropicKey, fakeOpenAiKey, fakeServiceRoleJwt, makeFixture } from "./make-fixture.mjs";
import { run } from "../src/util.mjs";

const rules = loadRules();
const hasGitleaks = run(process.env.GITLEAKS_BIN ?? "gitleaks", ["version"], { allowFail: true }) !== null;

test("classifies NEXT_PUBLIC_ names", () => {
  assert.equal(classifyVar("NEXT_PUBLIC_SUPABASE_URL", rules).status, "allowed");
  assert.equal(classifyVar("NEXT_PUBLIC_SUPABASE_ANON_KEY", rules).status, "deprecated");
  assert.deepEqual(
    [classifyVar("NEXT_PUBLIC_OPENAI_API_KEY", rules).status, classifyVar("NEXT_PUBLIC_OPENAI_API_KEY", rules).severity],
    ["forbidden", "critical"],
  );
  assert.equal(classifyVar("NEXT_PUBLIC_STRIPE_SECRET", rules).severity, "critical");
  assert.equal(classifyVar("NEXT_PUBLIC_DEMO_MODE", rules).severity, "high");
  assert.equal(classifyVar("NEXT_PUBLIC_POSTHOG_KEY", rules).status, "review");
});

test("recognises secret-shaped values without returning them", () => {
  assert.equal(secretKindOfValue(fakeOpenAiKey(), rules), "OpenAI-style secret key");
  assert.equal(secretKindOfValue(`"${fakeAnthropicKey()}"`, rules), "Anthropic API key");
  assert.match(secretKindOfValue(fakeServiceRoleJwt(), rules), /service_role/);
  assert.equal(secretKindOfValue("https://abc.supabase.co", rules), null);
  assert.equal(secretKindOfValue("sb_publishable_abc", rules), null);
});

test("matches .env files and .gitignore rules", () => {
  assert.ok(isEnvFile(".env") && isEnvFile("apps/web/.env.local") && isEnvFile(".env.production"));
  assert.ok(!isEnvFile(".env.example") && !isEnvFile("src/env.ts") && !isEnvFile(".envrc.md"));
  assert.ok(gitignoreIgnoresEnv(".env*\n!.env.example\n"));
  assert.ok(gitignoreIgnoresEnv("/.env\n.env.*\n"));
  assert.ok(!gitignoreIgnoresEnv("node_modules\n.env*.local\n"));
  assert.ok(!gitignoreIgnoresEnv(".env*\n!.env\n"));
});

test("parses CODEOWNERS", () => {
  assert.deepEqual(parseCodeowners("# c\n*.md @docs\n* @alice bob@x.com\n"), ["@alice", "bob@x.com"]);
  assert.deepEqual(parseCodeowners("[Backend] @carol\n/api/ @dave\n"), ["@carol"]);
  assert.deepEqual(parseCodeowners("/api/ @dave\n"), ["@dave"]);
});

test("end to end on a fixture repo with planted issues", async () => {
  const fixture = makeFixture();
  const out = mkdtempSync(join(tmpdir(), "secagent-out-"));
  const statePath = join(out, "state.json");
  const settings = { allowedDomains: [], fallback: "fallback@example.com", redirectTo: null };
  const send = async (emails) => emails; // pretend every email was delivered
  try {
    const first = await runAgent({ local: [fixture], dryRun: false, send, statePath, outDir: out, settings, now: "2026-11-17T10:00:00.000Z" });
    const open = Object.values(first.state.findings).filter((f) => f.status === "open");
    const byKey = Object.fromEntries(open.map((f) => [f.fp.split("|").slice(1).join("|"), f]));

    // NEXT_PUBLIC_ checks
    assert.equal(byKey["public-env|NEXT_PUBLIC_OPENAI_API_KEY"].severity, "critical");
    assert.deepEqual(Object.keys(byKey["public-env|NEXT_PUBLIC_OPENAI_API_KEY"].branches), ["feature/ai"]);
    assert.equal(byKey["public-env|NEXT_PUBLIC_POSTHOG_KEY"].severity, "review");
    assert.deepEqual(Object.keys(byKey["public-env|NEXT_PUBLIC_SUPABASE_ANON_KEY"].branches).sort(), ["feature/ai", "main"]);
    assert.equal(byKey["public-env-value|NEXT_PUBLIC_SUPABASE_KEY"].severity, "critical");
    assert.ok(!byKey["public-env-value|NEXT_PUBLIC_OPENAI_API_KEY"], "no duplicate value alert when the name is already critical");
    assert.ok(!byKey["public-env|NEXT_PUBLIC_README_ONLY"], "markdown files are ignored");
    assert.ok(!byKey["public-env|NEXT_PUBLIC_SUPABASE_URL"] && !byKey["public-env|NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"]);

    // .env and .gitignore checks
    assert.deepEqual(Object.keys(byKey["env-file|.env"].branches), ["feature/ai"]);
    assert.ok(byKey["env-history|.env.production"]);
    assert.deepEqual(Object.keys(byKey["gitignore-env"].branches).sort(), ["feature/ai", "main"]);
    assert.deepEqual(Object.keys(byKey["next-config-env|next.config.js"].branches).sort(), ["feature/ai", "main"]);
    if (hasGitleaks) assert.ok(open.some((f) => f.check === "secret"), "gitleaks finds the planted keys");

    // Owner from CODEOWNERS, one immediate email, and no secret value anywhere in it
    const repo = Object.values(first.state.repos)[0];
    assert.equal(repo.owners.source, "codeowners");
    assert.deepEqual(repo.owners.emails, ["tech.lead@example.com"]);
    assert.equal(first.emails.length, 1);
    assert.equal(first.emails[0].to, "tech.lead@example.com");
    const text = first.emails[0].text;
    assert.match(text, /CRITICAL/);
    assert.doesNotMatch(text, /sk-[A-Za-z0-9]{10}|sk-ant-api03|eyJ[\w-]{10}/, "email must not contain secret values");
    assert.doesNotMatch(text, /TO BE VALIDATED/, "non-critical findings wait for the digest");

    // Second run with nothing changed: no rescan, no new email
    const second = await runAgent({ local: [fixture], dryRun: false, send, statePath, outDir: out, settings, now: "2026-11-17T11:00:00.000Z" });
    assert.equal(second.summary.branchesScanned, 0);
    assert.equal(second.emails.length, 0);

    // Fix feature/ai by deleting the branch: its branch-only findings are resolved
    run("git", ["-C", fixture, "branch", "-q", "-D", "feature/ai"]);
    const third = await runAgent({ local: [fixture], dryRun: false, send, statePath, outDir: out, settings, now: "2026-11-17T12:00:00.000Z", digest: true });
    const f3 = third.state.findings;
    const key = (k) => `${repoKey(third.state)}|${k}`;
    assert.equal(f3[key("public-env|NEXT_PUBLIC_OPENAI_API_KEY")].status, "resolved");
    assert.equal(f3[key("gitignore-env")].status, "open", "still broken on main");
    assert.equal(f3[key("env-history|.env.production")].status, "open");
    assert.equal(third.emails.length, 1);
    assert.match(third.emails[0].text, /Fixed since the last digest/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
});

test("dry run writes emails to disk and never marks findings as alerted", async () => {
  const fixture = makeFixture();
  const out = mkdtempSync(join(tmpdir(), "secagent-dry-"));
  const opts = { local: [fixture], dryRun: true, statePath: join(out, "state.json"), outDir: out, settings: { allowedDomains: [], fallback: null } };
  try {
    const first = await runAgent(opts);
    assert.equal(readdirSync(join(out, "emails")).length, 1);
    assert.ok(Object.values(first.state.findings).every((f) => f.alertedAt === null));
    const text = readFileSync(join(out, "emails", readdirSync(join(out, "emails"))[0]), "utf8");
    assert.match(text, /^To: tech\.lead@example\.com/);
    const second = await runAgent(opts);
    assert.equal(second.summary.branchesScanned, 0, "scan progress is saved");
    assert.equal(second.emails.length, 1, "the critical alert is still pending for when emails go live");
  } finally {
    rmSync(fixture, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
});

const repoKey = (state) => Object.keys(state.repos)[0];
