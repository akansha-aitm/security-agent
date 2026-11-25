import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { endpointOfFile, loadEndpointRules, runEndpointChecks } from "../src/checks/endpoints.mjs";
import { listFiles } from "../src/checks/branch.mjs";
import { run } from "../src/util.mjs";
import { EXPECTED_ENDPOINT_FINDINGS, SAMPLE_ROUTES } from "./sample-routes.mjs";
import { EXPECTED_PY_FINDINGS, SAMPLE_PY_ROUTES } from "./sample-py-routes.mjs";

test("endpointOfFile maps App Router, Pages Router, edge functions; ignores the rest", () => {
  assert.deepEqual(endpointOfFile("app/api/chat/route.ts"), { kind: "app", route: "/api/chat", root: "" });
  assert.deepEqual(endpointOfFile("apps/web/src/app/(dash)/api/items/[id]/route.ts"), { kind: "app", route: "/api/items/[id]", root: "apps/web" });
  assert.deepEqual(endpointOfFile("pages/api/users/index.ts"), { kind: "pages", route: "/api/users", root: "" });
  assert.deepEqual(endpointOfFile("supabase/functions/send-digest/index.ts"), { kind: "edge", route: "/functions/v1/send-digest", root: "" });
  assert.equal(endpointOfFile("app/_lib/route.ts"), null);
  assert.equal(endpointOfFile("app/page.tsx"), null);
  assert.equal(endpointOfFile("node_modules/x/app/api/route.ts"), null);
  assert.equal(endpointOfFile("supabase/functions/_shared/cors.ts"), null);
});

test("planted routes: every unsafe one flagged with the expected checks, no safe one flagged", () => {
  const dir = mkdtempSync(join(tmpdir(), "secagent-endpoints-"));
  try {
    run("git", ["init", "-q", "-b", "main", dir]);
    for (const [path, text] of Object.entries(SAMPLE_ROUTES)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text.replace(/^\n/, ""));
    }
    run("git", ["-C", dir, "add", "-A"]);
    run("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@corp.test", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "routes"]);
    const sha = run("git", ["-C", dir, "rev-parse", "HEAD"]).trim();

    const seen = [];
    const items = runEndpointChecks(dir, sha, listFiles(dir, sha), loadEndpointRules(), { repo: "t/sample", onEndpoint: (e) => seen.push(e) });

    const got = {};
    for (const it of items) {
      const [, key, route] = it.fp.split("|");
      (got[route] ??= []).push(key);
      assert.ok(it.title && it.advice && it.location, `incomplete finding ${it.fp}`);
    }
    for (const k of Object.keys(got)) got[k].sort();
    assert.deepEqual(got, EXPECTED_ENDPOINT_FINDINGS);

    const sev = (route, key) => items.find((i) => i.fp === `endpoint|${key}|${route}`).severity;
    assert.equal(sev("/api/ai/generate", "no-auth"), "critical"); // calls an LLM
    assert.equal(sev("/api/admin/set-role", "no-auth"), "critical"); // uses the secret key
    assert.equal(sev("server actions in app/actions/notes.ts", "no-auth"), "high");
    assert.equal(sev("/api/export", "container-credential"), "medium"); // assumed container

    // Inventory: categories and access as a person would expect.
    const ep = (route) => seen.find((e) => e.route === route);
    assert.deepEqual(ep("/api/chat").categories, ["llm"]);
    assert.deepEqual(ep("/api/search").categories, ["third-party"]);
    assert.deepEqual(ep("/api/summaries").categories, ["container"]);
    assert.equal(ep("/api/health").access, "public (approved)");
    assert.equal(ep("/api/cron/refresh").access, "cron");
    assert.equal(ep("/functions/v1/hello").access, "Supabase token check");
    for (const safe of ["/api/chat", "/api/search", "/api/summaries", "/api/webhooks/stripe", "/api/cron/refresh", "/api/health", "server actions in app/actions/profile.ts", "/functions/v1/hello"])
      assert.equal(ep(safe)?.issues, 0, `${safe} should be clean`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("per-repo config: a project's own login helper and public route are honoured", () => {
  const dir = mkdtempSync(join(tmpdir(), "secagent-endpoints2-"));
  try {
    run("git", ["init", "-q", "-b", "main", dir]);
    mkdirSync(join(dir, "app/api/me"), { recursive: true });
    mkdirSync(join(dir, "app/api/status"), { recursive: true });
    writeFileSync(join(dir, "app/api/me/route.ts"), 'import { mustBeSignedIn } from "@/lib/guard";\nexport async function GET() { const u = await mustBeSignedIn(); return Response.json(u); }\n');
    writeFileSync(join(dir, "app/api/status/route.ts"), "export function GET() { return Response.json({ up: true }); }\n");
    run("git", ["-C", dir, "add", "-A"]);
    run("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@corp.test", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "x"]);
    const sha = run("git", ["-C", dir, "rev-parse", "HEAD"]).trim();
    const files = listFiles(dir, sha);
    const config = loadEndpointRules();

    const before = runEndpointChecks(dir, sha, files, config, { repo: "acme/web" }).map((i) => i.fp).sort();
    assert.deepEqual(before, ["endpoint|no-auth|/api/me", "endpoint|no-auth|/api/status"]);

    config.repos = { "acme/web": { authHelpers: ["mustBeSignedIn"], publicRoutes: ["/api/status"] } };
    assert.deepEqual(runEndpointChecks(dir, sha, files, config, { repo: "acme/web" }), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Python endpoints: Flask, FastAPI, Teams bot (aiohttp) and Azure Functions", () => {
  const dir = mkdtempSync(join(tmpdir(), "secagent-py-"));
  try {
    run("git", ["init", "-q", "-b", "main", dir]);
    for (const [path, text] of Object.entries(SAMPLE_PY_ROUTES)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text.replace(/^\n/, ""));
    }
    run("git", ["-C", dir, "add", "-A"]);
    run("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@corp.test", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "py"]);
    const sha = run("git", ["-C", dir, "rev-parse", "HEAD"]).trim();

    const seen = [];
    const items = runEndpointChecks(dir, sha, listFiles(dir, sha), loadEndpointRules(), { repo: "t/py", onEndpoint: (e) => seen.push(e) });
    const got = {};
    for (const it of items) {
      const [, key, label] = it.fp.split("|");
      (got[label] ??= []).push(key);
      assert.ok(it.title && it.advice && /\.py:\d+$/.test(it.location), `incomplete finding ${it.fp}`);
    }
    for (const k of Object.keys(got)) got[k].sort();
    assert.deepEqual(got, EXPECTED_PY_FINDINGS);

    const sev = (label, key) => items.find((i) => i.fp === `endpoint|${key}|${label}`).severity;
    assert.equal(sev("POST /api/chat", "no-auth"), "critical", "calls an LLM");
    assert.equal(sev("GET /api/preview", "no-auth"), "high");
    assert.equal(sev("POST /api/trigger", "no-auth"), "critical", "the LLM is reached through the bot module");
    assert.equal(sev("POST /api/sync", "no-auth"), "critical", "uses the Supabase secret key");
    assert.match(items.find((i) => i.fp === "endpoint|no-auth|POST /api/sync").title, /ANONYMOUS/);

    const ep = (label) => seen.find((e) => e.route === label);
    assert.deepEqual(seen.map((e) => e.route).sort(), [
      "ANY /api/status", "GET /api/preview", "GET /api/users/delete", "GET /health", "GET /items/{item_id}",
      "POST /admin/reindex", "POST /api/chat", "POST /api/messages", "POST /api/summary", "POST /api/sync",
      "POST /api/trigger", "POST /v1/ask", "POST /webhooks/stripe",
    ]);
    assert.equal(ep("POST /api/summary").issues, 0);
    assert.equal(ep("POST /api/summary").access, "login check");
    assert.equal(ep("GET /items/{item_id}").access, "login check", "FastAPI security scheme");
    assert.match(ep("POST /admin/reindex").access, /^login check/, "router-level dependencies=[Depends(...)]");
    assert.equal(ep("POST /api/messages").access, "Bot Framework token check");
    assert.equal(ep("ANY /api/status").access, "Azure function key");
    assert.equal(ep("GET /health").access, "public (approved)");
    assert.deepEqual(ep("POST /api/messages").categories, ["llm"]);
    assert.deepEqual([ep("POST /api/chat").kind, ep("POST /v1/ask").kind, ep("POST /api/messages").kind, ep("POST /api/sync").kind], ["flask", "fastapi", "aiohttp", "azure-function"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
