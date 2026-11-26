// Endpoints declared in code by JavaScript servers (Express, Fastify, Hono, NestJS), Azure Functions,
// Vercel functions, background-job endpoints (Inngest, QStash) and MCP servers over HTTP.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadEndpointRules, runEndpointChecks } from "../src/checks/endpoints.mjs";
import { listFiles } from "../src/checks/branch.mjs";
import { run } from "../src/util.mjs";

/** Commits the files to a new repo and runs the endpoint checks. */
function check(files) {
  const dir = mkdtempSync(join(tmpdir(), "secagent-srv-"));
  try {
    run("git", ["init", "-q", "-b", "main", dir]);
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text.replace(/^\n/, ""));
    }
    run("git", ["-C", dir, "add", "-A"]);
    run("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@corp.test", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "x"]);
    const sha = run("git", ["-C", dir, "rev-parse", "HEAD"]).trim();
    const seen = [];
    const items = runEndpointChecks(dir, sha, listFiles(dir, sha), loadEndpointRules(), { repo: "t/srv", onEndpoint: (e) => seen.push(e) });
    const byLabel = {};
    for (const it of items) (byLabel[it.fp.split("|")[2]] ??= []).push(it.fp.split("|")[1]);
    for (const k of Object.keys(byLabel)) byLabel[k].sort();
    const ep = (label) => {
      const e = seen.find((x) => x.route === label);
      assert.ok(e, `endpoint ${label} not found among: ${seen.map((x) => x.route).join(" | ")}`);
      return e;
    };
    const sev = (label, key) => items.find((i) => i.fp === `endpoint|${key}|${label}`)?.severity;
    const title = (label, key) => items.find((i) => i.fp === `endpoint|${key}|${label}`)?.title;
    return { items, seen, byLabel, ep, sev, title };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("Express: route and app-level middleware, prefixes, an open LLM route", () => {
  const r = check({
    "server/index.ts": `
import express from "express";
import OpenAI from "openai";
import { requireAuth } from "./auth";

const app = express();
const openai = new OpenAI();

app.get("/health", (req, res) => res.json({ ok: true }));

app.post("/chat", async (req, res) => {
  // Unsafe: no login, no rate limit, no size limit, calls the LLM.
  const out = await openai.chat.completions.create({ model: "gpt-4o-mini", max_tokens: 200, messages: [{ role: "user", content: req.body.message }] });
  res.json(out);
});

app.get("/me", requireAuth, (req, res) => res.json(req.user));

app.use("/admin", authMiddleware);
app.delete("/admin/users/:id", async (req, res) => res.json({ deleted: req.params.id }));

app.get("/public/stats", (req, res) => res.json({ users: 3 }));

app.listen(3000);
`,
    "server/auth.ts": "export function requireAuth(req, res, next) { next(); }\n",
  });
  assert.deepEqual(r.byLabel, {
    "POST /chat": ["llm-input-limit", "llm-rate-limit", "no-auth"],
    "GET /public/stats": ["no-auth"],
  });
  assert.equal(r.sev("POST /chat", "no-auth"), "critical", "calls an LLM");
  assert.equal(r.ep("GET /me").access, "login check (middleware)");
  assert.equal(r.ep("DELETE /admin/users/:id").access, "login check (middleware)");
  assert.equal(r.ep("GET /health").access, "public (approved)");
  assert.equal(r.ep("POST /chat").kind, "express");
  assert.deepEqual(r.ep("POST /chat").categories, ["llm"]);
});

test("Fastify: preHandler hooks count, a schema mentioning authorization does not", () => {
  const r = check({
    "services/jobs/server.js": `
const fastify = require("fastify")({ logger: true });

fastify.get("/jobs", { preHandler: [fastify.authenticate], schema: { headers: { authorization: { type: "string" } } } }, async () => []);

fastify.route({
  method: "POST",
  url: "/jobs/run",
  schema: { headers: { authorization: { type: "string" } } },
  handler: async (req) => ({ started: req.body.user_id }),
});

fastify.listen({ port: 3000 });
`,
  });
  assert.equal(r.ep("GET /jobs").access, "login check (middleware)");
  assert.deepEqual(r.byLabel, { "POST /jobs/run": ["identity", "no-auth"] });
});

test("Hono in a Next.js catch-all route: basePath and middleware paths; the route file itself is not reported", () => {
  const r = check({
    "web/next.config.js": "module.exports = {};\n",
    "web/app/api/[[...route]]/route.ts": `
import { Hono } from "hono";
import { handle } from "hono/vercel";
import { jwt } from "hono/jwt";

const app = new Hono().basePath("/api");
app.use("/private/*", jwt({ secret: process.env.JWT_SECRET }));
app.get("/private/notes", (c) => c.json([]));
app.get("/hello", (c) => c.json({ hi: 1 }));

export const GET = handle(app);
`,
  });
  assert.equal(r.ep("GET /api/private/notes").access, "login check (middleware)");
  assert.deepEqual(r.byLabel, { "GET /api/hello": ["no-auth"] });
  assert.ok(!r.seen.some((e) => e.route.includes("[[...route]]")), "the catch-all is reported route by route");
});

const NEST_CONTROLLERS = `
import { Body, Controller, Delete, Get, Post, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "./jwt.guard";
import { Public } from "./public.decorator";

@Controller("users")
export class UsersController {
  @Get()
  list() {
    return [];
  }

  @UseGuards(JwtAuthGuard)
  @Post(":id/role")
  setRole(@Body() body: { role: string }) {
    return { role: body.role };
  }

  @Public()
  @Get("ping")
  ping() {
    return "pong";
  }
}

@Controller("admin")
@UseGuards(JwtAuthGuard)
export class AdminController {
  @Delete(":id")
  remove() {
    return { ok: true };
  }
}
`;

test("NestJS: method and class guards; a global guard with @Public() exceptions", () => {
  const r = check({ "nest/src/users.controller.ts": NEST_CONTROLLERS });
  assert.deepEqual(r.byLabel, {
    "GET /users": ["no-auth"],
    "GET /users/ping": ["no-auth"],
    "POST /users/:id/role": ["identity"],
  });
  assert.equal(r.ep("POST /users/:id/role").access, "login check (guard)");
  assert.equal(r.ep("DELETE /admin/:id").access, "login check (guard)", "class-level guard");
  assert.equal(r.ep("GET /users").kind, "nestjs");

  const global = check({
    "nest/src/users.controller.ts": NEST_CONTROLLERS,
    "nest/src/app.module.ts": `
import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { JwtAuthGuard } from "./jwt.guard";

@Module({ providers: [{ provide: APP_GUARD, useClass: JwtAuthGuard }] })
export class AppModule {}
`,
  });
  assert.equal(global.ep("GET /users").access, "login check (global guard)");
  assert.deepEqual(Object.keys(global.byLabel).sort(), ["GET /users/ping", "POST /users/:id/role"], "@Public() opts out of the global guard");
});

test("Azure Functions in JS/TS: v4 app.http with function keys or anonymous (the default), v3 function.json", () => {
  const r = check({
    "func/src/functions/orders.ts": `
import { app } from "@azure/functions";

app.http("orders", { methods: ["GET"], authLevel: "function", handler: async () => ({ jsonBody: [] }) });

app.http("publicOrders", { methods: ["GET"], route: "orders/public", handler: listPublic });

async function listPublic(request) {
  return { jsonBody: [] };
}
`,
    "legacy/HttpTrigger1/function.json": JSON.stringify({ bindings: [{ type: "httpTrigger", direction: "in", name: "req", authLevel: "anonymous", methods: ["post"] }] }),
    "legacy/HttpTrigger1/index.js": "module.exports = async function (context, req) { context.res = { body: req.body }; };\n",
  });
  assert.equal(r.ep("GET /api/orders").access, "Azure function key");
  assert.deepEqual(r.byLabel, { "GET /api/orders/public": ["no-auth"], "POST /api/HttpTrigger1": ["no-auth"] });
  assert.match(r.title("GET /api/orders/public", "no-auth"), /authLevel anonymous/);
});

test("Vercel functions in /api (not in a Next.js project)", () => {
  const r = check({
    "package.json": '{ "name": "tools" }\n',
    "api/hello.ts": "export default function handler(req, res) { res.json({ hi: 1 }); }\n",
    "api/users/[id].ts": "export function GET(request) { return Response.json({ id: 1 }); }\n",
    "api/_lib/db.ts": "export const db = {};\n",
  });
  assert.deepEqual(r.byLabel, { "/api/hello": ["no-auth"], "/api/users/[id]": ["no-auth"] });
  assert.deepEqual(r.ep("/api/hello").methods, ["ANY"]);
  assert.equal(r.ep("/api/hello").kind, "vercel");

  const next = check({
    "package.json": '{ "name": "web" }\n',
    "next.config.js": "module.exports = {};\n",
    "api/hello.ts": "export default function handler(req, res) { res.json({}); }\n",
  });
  assert.equal(next.seen.length, 0, "a Next.js project does not deploy /api files as functions");
});

test("Background jobs: Inngest and QStash endpoints are protected by their signature", () => {
  const r = check({
    "app/api/inngest/route.ts": `
import { serve } from "inngest/next";
import { inngest, functions } from "@/inngest";

export const { GET, POST, PUT } = serve({ client: inngest, functions });
`,
    "inngest/index.ts": "export const inngest = {}; export const functions = [];\n",
    "app/api/jobs/route.ts": `
import { verifySignatureAppRouter } from "@upstash/qstash/nextjs";

async function handler(request: Request) {
  const job = await request.json();
  return Response.json({ done: job.id });
}

export const POST = verifySignatureAppRouter(handler);
`,
  });
  assert.equal(r.ep("/api/inngest").access, "Inngest (signing key)");
  assert.equal(r.ep("/api/jobs").access, "QStash signature");
  assert.deepEqual(r.byLabel, {});
});

test("MCP servers over HTTP: open ones are critical; requireBearerAuth, withMcpAuth and FastMCP auth count", () => {
  const r = check({
    "app/api/mcp/route.ts": `
import { createMcpHandler } from "mcp-handler";

const handler = createMcpHandler((server) => {
  server.tool("count", {}, async () => ({ content: [{ type: "text", text: "3" }] }));
});

export { handler as GET, handler as POST };
`,
    "app/api/secure-mcp/route.ts": `
import { createMcpHandler, withMcpAuth } from "mcp-handler";

const handler = createMcpHandler((server) => {});
const authed = withMcpAuth(handler, verifyToken, { required: true });

export { authed as GET, authed as POST };
`,
    "mcp/server.ts": `
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";

const app = express();
const server = new McpServer({ name: "tools", version: "1.0.0" });

app.post("/mcp", requireBearerAuth({ verifier }), async (req, res) => {
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});
`,
    "agents/reports_mcp.py": `
from mcp.server.fastmcp import FastMCP

mcp = FastMCP("reports")


@mcp.tool()
def count_rows() -> int:
    return 3


if __name__ == "__main__":
    mcp.run(transport="streamable-http")
`,
    "agents/secure_mcp.py": `
from fastapi import FastAPI
from mcp.server.fastmcp import FastMCP

mcp = FastMCP("secure", token_verifier=Verifier(), auth=AuthSettings(issuer_url="https://login.example.com"))
app = FastAPI()
app.mount("/tools", mcp.streamable_http_app())
`,
    "agents/local_mcp.py": `
from mcp.server.fastmcp import FastMCP

mcp = FastMCP("local")
mcp.run()
`,
  });
  assert.deepEqual(r.byLabel, { "/api/mcp": ["no-auth"], "ANY /mcp": ["no-auth"] });
  for (const label of ["/api/mcp", "ANY /mcp"]) {
    assert.equal(r.sev(label, "no-auth"), "critical", label);
    assert.match(r.title(label, "no-auth"), /^MCP server endpoint with no login check/, label);
  }
  assert.equal(r.ep("/api/secure-mcp").access, "login check");
  assert.equal(r.ep("POST /mcp").access, "login check (middleware)");
  assert.equal(r.ep("ANY /tools/mcp").access, "login check (MCP auth)");
  assert.ok(!r.seen.some((e) => e.file === "agents/local_mcp.py"), "an MCP server over stdio is not an endpoint");
});
