// One-time Google sign-in for the alert sender (send-only permission).
//
//   npm run gmail-auth -- <path to the downloaded OAuth client .json> --account support@yourcompany.com
//
// Opens Google's sign-in page; sign in AS THE SENDING ACCOUNT and allow "Send email on your behalf".
// Prints the three values to store in GitHub. Run it in your own terminal window: the output contains
// secrets, so don't run it through a chat or an AI assistant, and close the window afterwards.
//
// Permission requested: gmail.send (send only, cannot read mail), plus openid/email so the script can
// check which account signed in. Nothing is written to disk.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { parseArgs } from "node:util";

const SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";
const { values, positionals } = parseArgs({ allowPositionals: true, options: { account: { type: "string" } } });
const clientFile = positionals[0];
const expected = values.account?.trim().toLowerCase();
if (!clientFile || !expected) {
  console.error("usage: npm run gmail-auth -- <client_secret_....json> --account support@yourcompany.com");
  process.exit(1);
}

const json = JSON.parse(readFileSync(clientFile, "utf8"));
const client = json.installed ?? json.web;
if (!json.installed) {
  console.error('This file is not a "Desktop app" OAuth client. Create one with Application type: Desktop app.');
  process.exit(1);
}

const verifier = randomBytes(32).toString("base64url");
const challenge = createHash("sha256").update(verifier).digest("base64url");
const state = randomBytes(16).toString("hex");

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  if (url.pathname !== "/") return res.writeHead(404).end();
  const finish = (code, text) => {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" }).end(text);
    server.close();
    if (code) process.exitCode = code;
  };
  if (url.searchParams.get("state") !== state) return finish(1, "Unexpected request. Close this tab and run the command again.");
  if (url.searchParams.get("error")) {
    console.error(`Sign-in cancelled or refused: ${url.searchParams.get("error")}`);
    return finish(1, "Sign-in was not completed. You can close this tab.");
  }
  try {
    const tokenRes = await fetch(client.token_uri ?? "https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: url.searchParams.get("code"),
        redirect_uri: redirectUri,
        client_id: client.client_id,
        client_secret: client.client_secret,
        code_verifier: verifier,
      }),
    });
    const tokens = await tokenRes.json();
    if (!tokenRes.ok) throw new Error(`${tokens.error}: ${tokens.error_description ?? ""}`);

    const who = JSON.parse(Buffer.from(tokens.id_token.split(".")[1], "base64url").toString()).email?.toLowerCase();
    const scopes = String(tokens.scope ?? "").split(" ");
    const problem =
      who !== expected ? `you signed in as ${who}, not ${expected}` :
      !scopes.includes(SEND_SCOPE) ? 'the "Send email on your behalf" box was not ticked' :
      !tokens.refresh_token ? "Google returned no long-lived token" : null;
    if (problem) {
      if (tokens.refresh_token) await revoke(tokens.refresh_token);
      console.error(`Not saved: ${problem}. Run the command again.`);
      return finish(1, `Not saved: ${problem}. Run the command again. You can close this tab.`);
    }

    console.log(`\nSigned in as ${who}, permission: send email only.\n`);
    console.log("Store these in GitHub (agent repo > Settings > Secrets and variables > Actions):\n");
    console.log(`  Variable  GMAIL_CLIENT_ID      ${client.client_id}`);
    console.log(`  Secret    GMAIL_CLIENT_SECRET  ${client.client_secret}`);
    console.log(`  Secret    GMAIL_REFRESH_TOKEN  ${tokens.refresh_token}`);
    console.log("\nThen close this terminal window, and delete the downloaded client .json file.");
    finish(0, "Done. Go back to the terminal. You can close this tab.");
  } catch (err) {
    console.error(`Sign-in failed: ${err.message}`);
    finish(1, "Sign-in failed, see the terminal. You can close this tab.");
  }
});

async function revoke(token) {
  await fetch("https://oauth2.googleapis.com/revoke", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token }),
  }).catch(() => {});
}

let redirectUri;
server.listen(0, "127.0.0.1", () => {
  redirectUri = `http://127.0.0.1:${server.address().port}`;
  const authUrl = new URL(client.auth_uri ?? "https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.search = new URLSearchParams({
    client_id: client.client_id,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: `openid email ${SEND_SCOPE}`,
    access_type: "offline",
    prompt: "consent",
    login_hint: expected,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();
  console.log(`Opening Google sign-in. Sign in as ${expected}.`);
  console.log(`If no browser opens, paste this link into one:\n\n${authUrl}\n`);
  const opener = process.platform === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", authUrl.href]]
    : process.platform === "darwin" ? ["open", [authUrl.href]] : ["xdg-open", [authUrl.href]];
  spawn(opener[0], opener[1], { stdio: "ignore", detached: true }).on("error", () => {}).unref();
  setTimeout(() => {
    console.error("Timed out after 10 minutes. Run the command again.");
    process.exit(1);
  }, 10 * 60 * 1000).unref();
});
