// Single sign-on recognised as a login check: Microsoft Entra ID in the code (Python and
// JavaScript), Azure App Service sign-in switched on in deploy files, Snowflake's login in front of
// Snowpark Container Services. Getting a token for outgoing calls must not count.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadEndpointRules, runEndpointChecks } from "../src/checks/endpoints.mjs";
import { listFiles } from "../src/checks/branch.mjs";
import { run } from "../src/util.mjs";

/** Commits the files to a new repo and runs the endpoint checks: { items, ep(label) }. */
function check(files) {
  const dir = mkdtempSync(join(tmpdir(), "secagent-sso-"));
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
    const items = runEndpointChecks(dir, sha, listFiles(dir, sha), loadEndpointRules(), { repo: "t/sso", onEndpoint: (e) => seen.push(e) });
    const ep = (label) => {
      const e = seen.find((x) => x.route === label);
      assert.ok(e, `endpoint ${label} not found`);
      return e;
    };
    return { items, ep, noAuth: (label) => items.some((i) => i.fp === `endpoint|no-auth|${label}`) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const PY_ENTRA_HELPER = `
import jwt
from jwt import PyJWKClient

JWKS = PyJWKClient("https://login.microsoftonline.com/common/discovery/v2.0/keys")


def verify_caller(request):
    token = request.headers["Authorization"].split(" ")[1]
    key = JWKS.get_signing_key_from_jwt(token)
    return jwt.decode(token, key.key, algorithms=["RS256"], audience="api://reports")
`;

// Outgoing only: the app gets its own token to call Microsoft Graph. Not a check on the caller.
const PY_OUTGOING_TOKEN = `
import msal


def graph_token():
    app = msal.ConfidentialClientApplication("client-id", authority="https://login.microsoftonline.com/tenant-id", client_credential=CREDENTIAL)
    return app.acquire_token_for_client(scopes=["https://graph.microsoft.com/.default"])
`;

test("Microsoft SSO in Python: token check in a helper, fastapi-azure-auth, App Service headers; outgoing tokens do not count", () => {
  const { ep, noAuth } = check({
    "auth/entra.py": PY_ENTRA_HELPER,
    "auth/graph.py": PY_OUTGOING_TOKEN,
    "app.py": `
from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi_azure_auth import SingleTenantAzureAuthorizationCodeBearer

from auth.entra import verify_caller
from auth.graph import graph_token

app = FastAPI()
azure_scheme = SingleTenantAzureAuthorizationCodeBearer(app_client_id="api-id", tenant_id="tenant-id")


@app.get("/api/reports")
async def reports(request: Request):
    verify_caller(request)
    return {"reports": []}


@app.get("/api/admin", dependencies=[Depends(azure_scheme)])
async def admin():
    return {"ok": True}


@app.get("/api/me")
async def me(request: Request):
    principal = request.headers.get("X-MS-CLIENT-PRINCIPAL-ID")
    if not principal:
        raise HTTPException(401)
    return {"id": principal}


@app.get("/api/files")
async def files():
    return {"token_ok": bool(graph_token())}
`,
  });
  for (const label of ["GET /api/reports", "GET /api/admin", "GET /api/me"]) {
    assert.equal(ep(label).access, "login check (Microsoft SSO)", label);
    assert.ok(!noAuth(label), label);
  }
  assert.equal(ep("GET /api/files").access, "none found", "getting a token for Graph is not a login check");
  assert.ok(noAuth("GET /api/files"));
});

test("Microsoft SSO in JavaScript: a route calling a helper that verifies Entra tokens with jose", () => {
  const { ep, noAuth } = check({
    "lib/entra.ts": `
import { createRemoteJWKSet, jwtVerify } from "jose";

const JWKS = createRemoteJWKSet(new URL("https://login.microsoftonline.com/common/discovery/v2.0/keys"));

export async function requireEntraUser(req: Request) {
  const token = req.headers.get("authorization")?.replace("Bearer ", "") ?? "";
  const { payload } = await jwtVerify(token, JWKS, { audience: process.env.API_AUDIENCE });
  return payload;
}
`,
    "app/api/me/route.ts": `
import { requireEntraUser } from "@/lib/entra";

export async function GET(req: Request) {
  const user = await requireEntraUser(req);
  return Response.json({ id: user.oid });
}
`,
    "app/api/stats/route.ts": `
import { requireEntraUser } from "@/lib/entra";

// Imports the helper but never calls it: still open.
export async function GET() {
  return Response.json({ count: 3, check: typeof requireEntraUser });
}
`,
  });
  assert.equal(ep("/api/me").access, "login check (Microsoft SSO)");
  assert.ok(!noAuth("/api/me"));
  assert.ok(noAuth("/api/stats"), "importing the helper without calling it is not a check");
});

test("Azure App Service sign-in from deploy files covers every endpoint except its excluded paths", () => {
  const { ep, noAuth } = check({
    "scripts/deploy.sh": `
az webapp auth update -g rg-reports -n reports-api --enabled true --action LoginWithAzureActiveDirectory --excluded-paths "/api/messages"
`,
    "main.py": `
from fastapi import FastAPI

app = FastAPI()


@app.get("/api/reports")
async def reports():
    return []


@app.post("/api/messages")
async def messages(activity: dict):
    return {"ok": True}
`,
  });
  assert.equal(ep("GET /api/reports").access, "Azure App Service sign-in (deploy files)");
  assert.ok(!noAuth("GET /api/reports"));
  assert.ok(noAuth("POST /api/messages"), "an excluded path is not protected by the sign-in");

  // Bicep (authsettingsV2) for a Next.js app.
  const bicep = check({
    "infra/main.bicep": `
resource auth 'Microsoft.Web/sites/config@2022-03-01' = {
  name: 'authsettingsV2'
  properties: {
    globalValidation: {
      requireAuthentication: true
      unauthenticatedClientAction: 'RedirectToLoginPage'
      excludedPaths: [
        '/api/public'
      ]
    }
  }
}
`,
    "app/api/items/route.ts": "export async function GET() { return Response.json([]); }\n",
    "app/api/public/route.ts": "export async function GET() { return Response.json({ up: true }); }\n",
  });
  assert.equal(bicep.ep("/api/items").access, "Azure App Service sign-in (deploy files)");
  assert.ok(bicep.noAuth("/api/public"));
});

test("Snowflake: public endpoints of a Snowpark Container Services service are behind the Snowflake login", () => {
  const { ep, noAuth } = check({
    "service/spec.yaml": `
spec:
  containers:
  - name: api
    image: /analytics/app/repo/api:latest
  endpoints:
  - name: api
    port: 8000
    public: true
`,
    "service/app.py": `
from flask import Flask

app = Flask(__name__)


@app.route("/api/summary")
def summary():
    return {"rows": 0}
`,
  });
  assert.equal(ep("GET /api/summary").access, "Snowflake login (Snowpark Container Services)");
  assert.ok(!noAuth("GET /api/summary"));
});

test("no SSO anywhere: endpoints are still reported", () => {
  const { noAuth } = check({
    "main.py": `
from fastapi import FastAPI

app = FastAPI()


@app.get("/api/data")
async def data():
    return []
`,
  });
  assert.ok(noAuth("GET /api/data"));
});

test("Teams: a bot endpoint that validates the Bot Framework token itself", () => {
  const { ep, noAuth } = check({
    "bot/main.py": `
from botframework.connector.auth import JwtTokenValidation, SimpleCredentialProvider
from fastapi import FastAPI, Request

app = FastAPI()
CREDENTIALS = SimpleCredentialProvider(APP_ID, APP_PASSWORD)


@app.post("/api/messages")
async def messages(request: Request):
    activity = await request.json()
    await JwtTokenValidation.authenticate_request(activity, request.headers.get("Authorization", ""), CREDENTIALS)
    return {"ok": True}
`,
  });
  assert.equal(ep("POST /api/messages").access, "login check (Microsoft SSO)");
  assert.ok(!noAuth("POST /api/messages"));
});
