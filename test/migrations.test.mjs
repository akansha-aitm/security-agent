// Code-level migrations: endpoints that change the database structure themselves. SQL files kept in
// supabase/ or snowflake/ folders are run by hand and must not be reported.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadEndpointRules, runEndpointChecks } from "../src/checks/endpoints.mjs";
import { listFiles } from "../src/checks/branch.mjs";
import { run } from "../src/util.mjs";

/** Commits the files to a new repo, runs the endpoint checks and returns the migration findings by endpoint. */
function check(files) {
  const dir = mkdtempSync(join(tmpdir(), "secagent-mig-"));
  try {
    run("git", ["init", "-q", "-b", "main", dir]);
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text.replace(/^\n/, ""));
    }
    run("git", ["-C", dir, "add", "-A"]);
    run("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@corp.test", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "x"]);
    const sha = run("git", ["-C", dir, "rev-parse", "HEAD"]).trim();
    const items = runEndpointChecks(dir, sha, listFiles(dir, sha), loadEndpointRules(), { repo: "t/mig" });
    const migration = {};
    for (const it of items.filter((i) => i.fp.startsWith("endpoint|migration|"))) migration[it.fp.split("|")[2]] = it.severity;
    return { items, migration };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("open Next.js route that creates tables through Supabase exec_sql is critical, and not reported twice", () => {
  const { items, migration } = check({
    "app/api/setup/route.ts": `
import { createClient } from "@supabase/supabase-js";
const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!);
export async function POST() {
  await supabase.rpc("exec_sql", { sql: "create table if not exists notes (id uuid primary key)" });
  return Response.json({ ok: true });
}
`,
  });
  assert.equal(migration["/api/setup"], "critical");
  assert.ok(!items.some((i) => i.fp === "endpoint|no-auth|/api/setup"), "no second no-auth alert");
});

test("logged-in route with DDL but no admin check is high; with an admin check it is not reported", () => {
  const route = (extra) => `
import { getUser } from "@/lib/auth";
import { sql } from "@/lib/db";
export async function POST() {
  const user = await getUser();
  if (!user) return new Response("no", { status: 401 });
  ${extra}
  await sql\`ALTER TABLE reports ADD COLUMN score int\`;
  return Response.json({ ok: true });
}
`;
  const { migration } = check({
    "app/api/migrate/route.ts": route(""),
    "app/api/admin/migrate/route.ts": route('if (user.role !== "admin") return new Response("no", { status: 403 });'),
    "lib/auth.ts": "export async function getUser() { return null; }\n",
    "lib/db.ts": "export const sql = () => {};\n",
  });
  assert.equal(migration["/api/migrate"], "high");
  assert.equal(migration["/api/admin/migrate"], undefined);
});

test("Python endpoints: SQLAlchemy create_all and Snowflake DDL", () => {
  const { migration } = check({
    "api/app.py": `
from fastapi import FastAPI
from .db import Base, engine, snowflake_conn

app = FastAPI()


@app.post("/init")
def init_db():
    Base.metadata.create_all(bind=engine)
    return {"ok": True}


@app.post("/stage")
def make_stage():
    snowflake_conn.cursor().execute("CREATE OR REPLACE TABLE events (id string)")
    return {"ok": True}


@app.get("/items")
def items():
    return []
`,
    "api/db.py": "Base = None\nengine = None\nsnowflake_conn = None\n",
  });
  assert.equal(migration["POST /init"], "critical");
  assert.equal(migration["POST /stage"], "critical");
  assert.equal(migration["GET /items"], undefined);
});

test("not reported: SQL files in supabase/ and snowflake/, temporary tables, prose, plain inserts", () => {
  const { migration } = check({
    "supabase/migrations/20240101_init.sql": "create table notes (id uuid primary key);\n",
    "snowflake/setup.sql": "CREATE OR REPLACE TABLE events (id string);\n",
    "app/api/upload/route.ts": `
import { getUser } from "@/lib/auth";
import { conn } from "@/lib/snow";
export async function POST() {
  const user = await getUser();
  if (!user) return new Response("no", { status: 401 });
  await conn.execute({ sqlText: "CREATE TEMPORARY STAGE upload_stage" });
  return Response.json({ ok: true });
}
`,
    "app/api/help/route.ts": `
export async function GET() {
  return Response.json({ tip: "Click to create table views in the editor" });
}
`,
    "app/api/notes/route.ts": `
import { db } from "@/lib/db";
export async function POST(req: Request) {
  await db.from("notes").insert({ text: "x" });
  return Response.json({ ok: true });
}
`,
    "lib/auth.ts": "export async function getUser() { return null; }\n",
    "lib/snow.ts": "export const conn = null;\n",
    "lib/db.ts": "export const db = null;\n",
  });
  assert.deepEqual(migration, {});
});

test("seed route that writes data is a migration endpoint; the same writes elsewhere are not", () => {
  const { migration } = check({
    "app/api/seed/route.ts": `
import { db } from "@/lib/db";
export async function POST() {
  await db.from("products").delete().neq("id", 0);
  await db.from("products").insert([{ name: "a" }]);
  return Response.json({ ok: true });
}
`,
    "lib/db.ts": "export const db = null;\n",
  });
  assert.equal(migration["/api/seed"], "critical");
});
