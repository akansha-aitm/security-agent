// Single sign-on that protects an endpoint without a project-specific helper name:
// - Microsoft Entra ID (Microsoft / Azure SSO): the code validates the caller's token against
//   Microsoft's keys, or uses a library that does; Teams bots: the Bot Framework token check.
// - Azure App Service / Container Apps sign-in ("Easy Auth"): the code reads the headers it adds,
//   or the deploy files switch it on (paths it excludes stay unprotected).
// - Snowflake: a Snowpark Container Services service with public endpoints, which Snowflake puts
//   behind its own login.
// Getting a token to call Microsoft (msal client credentials, .../oauth2/v2.0/token) is not a
// login check: it says who the app is, not who is calling it.
import { git } from "../util.mjs";

// Libraries and classes that only exist to check incoming Microsoft tokens.
// (Teams adapters count only where a request goes through them: see the Bot Framework check.)
const ENTRA_LIB_RE =
  /fastapi_azure_auth|(?:SingleTenant|MultiTenant|B2CMultiTenant)AzureAuthorizationCodeBearer|passport-azure-ad|\bBearerStrategy\b|azure-ad-verify-token|\bJwtTokenValidation\b|\bChannelValidation\.authenticate/;
// Microsoft's token issuers and public keys, checked by a generic JWT library.
const ENTRA_KEYS_RE = /(?:login\.microsoftonline\.com|login\.windows\.net|sts\.windows\.net)[^"'`\s]*(?:discovery\/(?:v2\.0\/)?keys|\.well-known\/openid-configuration)|login\.microsoftonline\.com\/common\/discovery/;
const VERIFY_RE = /\bjwt\.decode\(|\bPyJWKClient\b|\bjwtVerify\(|\bcreateRemoteJWKSet\(|\bjwt\.verify\(|\bjwks/i;
// Headers that Azure App Service / Container Apps sign-in adds to every signed-in request.
const EASY_AUTH_HEADER_RE = /x-ms-client-principal/i;

/** Whether this code checks the caller with Microsoft SSO (token validation or App Service headers). */
export function checksMicrosoftLogin(text) {
  return ENTRA_LIB_RE.test(text) || (ENTRA_KEYS_RE.test(text) && VERIFY_RE.test(text)) || EASY_AUTH_HEADER_RE.test(text);
}

const DEPLOY_FILE_RE = /\.(ps1|sh|ya?ml|bicep|json|tf)$/i;
const SKIP_RE = /(^|\/)(node_modules|\.venv|venv|dist|build|\.next)\//;

/**
 * Login switched on by the platform for the whole app, found in the repo's deploy files.
 * Returns { label, excluded(route) } or null. Repo-wide: in a repo holding several apps, a person
 * should confirm that the setting belongs to the app that serves these endpoints.
 */
export function platformLogin(dir, sha, files) {
  const read = (p) => git(dir, ["cat-file", "blob", `${sha}:${p}`], { allowFail: true }) ?? "";
  const candidates = files.filter((f) => DEPLOY_FILE_RE.test(f) && !SKIP_RE.test(f) && !/package(-lock)?\.json$|tsconfig|\.eslintrc/.test(f));
  const hits = new Set(
    (git(dir, ["grep", "-l", "-i", "-E", "webapp auth|containerapp auth|authsettingsV2|auth_settings_v2|unauthenticatedClientAction|unauthenticated-client-action|public:[[:space:]]*true", sha, "--", ...candidates.length ? candidates : ["__none__"]], { allowFail: true }) ?? "")
      .split("\n")
      .filter((l) => l.startsWith(`${sha}:`))
      .map((l) => l.slice(sha.length + 1)),
  );

  const excluded = [];
  let azure = false;
  let snowflake = false;
  for (const f of hits) {
    const t = read(f);
    // CLI: az webapp auth update --enabled true ... / --unauthenticated-client-action RedirectToLoginPage
    for (const m of t.matchAll(/\baz\s+(?:webapp|containerapp|functionapp)\s+auth\b[^\n]*/gi)) {
      const line = m[0];
      if (/--enabled\s+true|--action\s+LoginWith|--unauthenticated-client-action\s+["']?(?:RedirectToLoginPage|Return401|Return403)/i.test(line)) azure = true;
      for (const p of line.matchAll(/--excluded-paths\s+("[^"]*"|'[^']*'|\S+)/gi)) excluded.push(...splitPaths(p[1]));
    }
    // Bicep / ARM / Terraform: authsettingsV2 with requireAuthentication or a non-anonymous action
    if (/authsettingsV2|auth_settings_v2/i.test(t)) {
      if (/requireAuthentication['"]?\s*[:=]\s*true|require_authentication\s*=\s*true|unauthenticatedClientAction['"]?\s*[:=]\s*['"](?:RedirectToLoginPage|Return401|Return403)|unauthenticated_action\s*=\s*"(?:RedirectToLoginPage|Return401|Return403)"/i.test(t))
        azure = true;
      for (const p of t.matchAll(/excluded_?[Pp]aths['"]?\s*[:=]\s*\[([^\]]*)\]/g)) excluded.push(...splitPaths(p[1]));
    }
    // Snowpark Container Services spec: a public endpoint is reachable only after a Snowflake login.
    if (/^\s*spec\s*:/m.test(t) && /^\s*containers\s*:/m.test(t) && /^\s*endpoints\s*:/m.test(t) && /^\s*public\s*:\s*true\b/m.test(t)) snowflake = true;
  }
  if (!azure && !snowflake) return null;
  const isExcluded = (route) => excluded.some((p) => (p.endsWith("*") ? route.startsWith(p.replace(/\*+$/, "")) : route === p || route === p.replace(/\/$/, "")));
  return {
    label: azure ? "Azure App Service sign-in (deploy files)" : "Snowflake login (Snowpark Container Services)",
    // Snowflake's ingress protects every public endpoint; App Service skips its excluded paths.
    excluded: azure ? isExcluded : () => false,
  };
}

function splitPaths(text) {
  return text
    .split(/[\s,]+/)
    .map((s) => s.replace(/^["']|["']$/g, "").trim())
    .filter((s) => s.startsWith("/"));
}
