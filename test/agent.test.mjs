import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyVar, loadRules, secretKindOfValue } from "../src/rules.mjs";
import { gitignoreIgnoresEnv, isEnvFile } from "../src/checks/branch.mjs";
import { runAgent } from "../src/agent.mjs";
import { fakeAnthropicKey, fakeOpenAiKey, fakeServiceRoleJwt, makeFixture } from "./make-fixture.mjs";
import { branchFilter, run } from "../src/util.mjs";

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

test("branch scope: dev/ prefix, any capitalisation, configurable", () => {
  const dev = branchFilter(["dev/"]);
  assert.ok(dev("dev/chat-export") && dev("Dev/Chat") && dev("DEV/x"));
  assert.ok(!dev("main") && !dev("develop") && !dev("feature/dev/x") && !dev("dev"));
  const two = branchFilter(["dev/", "hotfix/"]);
  assert.ok(two("hotfix/login") && !two("release/1"));
  assert.ok(branchFilter(["*"])("main") && branchFilter([])("main"));
});

const LEADS = ["lead.one@example.com", "lead.two@example.com", "lead.three@example.com"];

test("end to end on a fixture repo with planted issues (dev/ branches only)", async () => {
  const fixture = makeFixture();
  const out = mkdtempSync(join(tmpdir(), "secagent-out-"));
  const statePath = join(out, "state.json");
  const settings = { recipients: LEADS, redirectTo: null };
  const send = async (emails) => emails; // pretend every email was delivered
  try {
    const first = await runAgent({ local: [fixture], dryRun: false, send, statePath, outDir: out, settings, now: "2026-11-17T10:00:00.000Z" });
    const open = Object.values(first.state.findings).filter((f) => f.status === "open");
    const byKey = Object.fromEntries(open.map((f) => [f.fp.split("|").slice(1).join("|"), f]));

    // Only dev/ branches are scanned
    assert.deepEqual(Object.keys(Object.values(first.state.repos)[0].branches).sort(), ["dev/ai", "dev/clean"]);
    assert.ok(!byKey["public-env|NEXT_PUBLIC_STRIPE_SECRET"], "feature/old is out of scope");

    // NEXT_PUBLIC_ checks
    assert.equal(byKey["public-env|NEXT_PUBLIC_OPENAI_API_KEY"].severity, "critical");
    assert.deepEqual(Object.keys(byKey["public-env|NEXT_PUBLIC_OPENAI_API_KEY"].branches), ["dev/ai"]);
    assert.equal(byKey["public-env|NEXT_PUBLIC_POSTHOG_KEY"].severity, "review");
    assert.deepEqual(Object.keys(byKey["public-env|NEXT_PUBLIC_SUPABASE_ANON_KEY"].branches), ["dev/ai"]);
    assert.equal(byKey["public-env-value|NEXT_PUBLIC_SUPABASE_KEY"].severity, "critical");
    assert.ok(!byKey["public-env-value|NEXT_PUBLIC_OPENAI_API_KEY"], "no duplicate value alert when the name is already critical");
    assert.ok(!byKey["public-env|NEXT_PUBLIC_README_ONLY"], "markdown files are ignored");
    assert.ok(!byKey["public-env|NEXT_PUBLIC_SUPABASE_URL"] && !byKey["public-env|NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"]);

    // .env and .gitignore checks
    assert.deepEqual(Object.keys(byKey["env-file|.env"].branches), ["dev/ai"]);
    assert.ok(byKey["env-history|.env.production"], "main's history is reachable from the dev/ branches");
    assert.deepEqual(Object.keys(byKey["gitignore-env"].branches), ["dev/ai"]);
    assert.deepEqual(Object.keys(byKey["next-config-env|next.config.js"].branches), ["dev/ai"]);
    if (hasGitleaks) assert.ok(open.some((f) => f.check === "secret"), "gitleaks finds the planted keys");

    // One email to all tech leads, with every new finding (all severities), critical first
    assert.equal(first.emails.length, 1);
    const email = first.emails[0];
    assert.deepEqual(email.to, LEADS);
    assert.equal(email.fps.length, open.length);
    assert.match(email.subject, /^\[Security\] New issues in .+: \d+ critical, \d+ high, \d+ low, \d+ to check$/);
    assert.match(email.text, /CRITICAL/);
    assert.match(email.text, /TO BE VALIDATED/, "all severities are emailed, not only critical");
    assert.ok(email.text.indexOf("=== CRITICAL") < email.text.indexOf("=== HIGH"), "critical first");
    assert.match(email.text, /=== What was pushed/);
    assert.match(email.html, /^<!doctype html>/);
    assert.ok(email.html.indexOf(">CRITICAL &middot;") < email.html.indexOf(">HIGH &middot;"), "critical first in HTML too");
    for (const body of [email.text, email.html])
      assert.doesNotMatch(body, /sk-[A-Za-z0-9]{10}|sk-ant-api03|eyJ[\w-]{10}/, "email must not contain secret values");

    // Second run with nothing changed: no rescan, no new email
    const second = await runAgent({ local: [fixture], dryRun: false, send, statePath, outDir: out, settings, now: "2026-11-17T11:00:00.000Z" });
    assert.equal(second.summary.branchesScanned, 0);
    assert.equal(second.emails.length, 0);

    // Fix dev/ai by deleting the branch: its branch-only findings are resolved
    run("git", ["-C", fixture, "branch", "-q", "-D", "dev/ai"]);
    const third = await runAgent({ local: [fixture], dryRun: false, send, statePath, outDir: out, settings, now: "2026-11-17T12:00:00.000Z", digest: true });
    const f3 = third.state.findings;
    const key = (k) => `${repoKey(third.state)}|${k}`;
    assert.equal(f3[key("public-env|NEXT_PUBLIC_OPENAI_API_KEY")].status, "resolved");
    assert.equal(f3[key("gitignore-env")].status, "resolved", "only dev/ai had it; main is out of scope");
    assert.equal(f3[key("env-history|.env.production")].status, "open", "still reachable from dev/clean");
    assert.equal(third.emails.length, 1);
    assert.match(third.emails[0].subject, /Weekly digest/);
    assert.match(third.emails[0].text, /Fixed since the last digest/);

    // No dev/ branch left: the repo is out of scope and everything is closed
    run("git", ["-C", fixture, "branch", "-q", "-D", "dev/clean"]);
    const fourth = await runAgent({ local: [fixture], dryRun: false, send, statePath, outDir: out, settings, now: "2026-11-17T13:00:00.000Z" });
    assert.ok(Object.values(fourth.state.findings).every((f) => f.status === "resolved"));
    assert.equal(fourth.emails.length, 0);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
});

test("SCAN_BRANCH_PREFIXES=* scans every branch", async () => {
  const fixture = makeFixture();
  const out = mkdtempSync(join(tmpdir(), "secagent-all-"));
  try {
    const r = await runAgent({ local: [fixture], dryRun: true, branchPrefixes: ["*"], statePath: join(out, "state.json"), outDir: out, settings: { recipients: LEADS } });
    assert.deepEqual(Object.keys(Object.values(r.state.repos)[0].branches).sort(), ["dev/ai", "dev/clean", "feature/old", "main"]);
    assert.ok(Object.values(r.state.findings).some((f) => f.title.includes("NEXT_PUBLIC_STRIPE_SECRET")));
  } finally {
    rmSync(fixture, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
});

test("dry run writes emails to disk and never marks findings as alerted", async () => {
  const fixture = makeFixture();
  const out = mkdtempSync(join(tmpdir(), "secagent-dry-"));
  const opts = { local: [fixture], dryRun: true, statePath: join(out, "state.json"), outDir: out, settings: { recipients: LEADS } };
  try {
    const first = await runAgent(opts);
    assert.deepEqual(readdirSync(join(out, "emails")).sort(), ["01.html", "01.txt"]);
    assert.ok(Object.values(first.state.findings).every((f) => f.alertedAt === null));
    const text = readFileSync(join(out, "emails", "01.txt"), "utf8");
    assert.ok(text.startsWith(`To: ${LEADS.join(", ")}\n`));
    const second = await runAgent(opts);
    assert.equal(second.summary.branchesScanned, 0, "scan progress is saved");
    assert.equal(second.emails.length, 1, "the alert is still pending for when emails go live");
  } finally {
    rmSync(fixture, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
});

test("no recipient configured: nothing is emailed and nothing is marked as alerted", async () => {
  const fixture = makeFixture();
  const out = mkdtempSync(join(tmpdir(), "secagent-norcpt-"));
  try {
    const r = await runAgent({ local: [fixture], dryRun: false, send: async (e) => e, statePath: join(out, "state.json"), outDir: out, settings: { recipients: [] } });
    assert.equal(r.emails.length, 0);
    assert.ok(r.summary.undeliverable > 0);
    assert.ok(Object.values(r.state.findings).every((f) => f.alertedAt === null));
  } finally {
    rmSync(fixture, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
});

const repoKey = (state) => Object.keys(state.repos)[0];
