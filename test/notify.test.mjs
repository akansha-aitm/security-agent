import { test } from "node:test";
import assert from "node:assert/strict";
import { deliver } from "../src/notify.mjs";
import { scrub } from "../src/util.mjs";

test("App Password is redacted with or without its spaces", () => {
  const before = process.env.SMTP_PASS;
  process.env.SMTP_PASS = "abcd efgh ijkl mnop";
  try {
    assert.equal(scrub("a abcd efgh ijkl mnop b abcdefghijklmnop c"), "a [redacted] b [redacted] c");
  } finally {
    if (before === undefined) delete process.env.SMTP_PASS;
    else process.env.SMTP_PASS = before;
  }
});

test("sending without SMTP credentials sends nothing and marks nothing as delivered", async () => {
  const saved = { u: process.env.SMTP_USER, p: process.env.SMTP_PASS };
  delete process.env.SMTP_USER;
  delete process.env.SMTP_PASS;
  try {
    const sent = await deliver([{ to: "a@corp.test", subject: "s", text: "t", fps: ["x"] }], { dryRun: false });
    assert.deepEqual(sent, []);
  } finally {
    if (saved.u !== undefined) process.env.SMTP_USER = saved.u;
    if (saved.p !== undefined) process.env.SMTP_PASS = saved.p;
  }
});

test("Gmail API sender: send-only sign-in, then one MIME message per email", async () => {
  const keys = ["GMAIL_CLIENT_ID", "GMAIL_CLIENT_SECRET", "GMAIL_REFRESH_TOKEN", "MAIL_FROM", "MAIL_REPLY_TO"];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  const realFetch = globalThis.fetch;
  const calls = [];
  Object.assign(process.env, {
    GMAIL_CLIENT_ID: "cid",
    GMAIL_CLIENT_SECRET: "client-secret-value",
    GMAIL_REFRESH_TOKEN: "refresh-token-value",
    MAIL_FROM: "AITM Security Agent <support@corp.test>",
    MAIL_REPLY_TO: "lead@corp.test",
  });
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).includes("oauth2.googleapis.com/token"))
      return Response.json({ access_token: "access-1", scope: "https://www.googleapis.com/auth/gmail.send", expires_in: 3599 });
    return Response.json({ id: "m1" });
  };
  try {
    const emails = [{ to: "owner@corp.test", subject: "2 new critical issues", text: "body", fps: ["a"] }];
    const sent = await deliver(emails, { dryRun: false, redirectTo: "me@corp.test" });
    assert.equal(sent.length, 1);
    assert.equal(calls.length, 2); // one sign-in, one send
    const form = new URLSearchParams(calls[0].init.body);
    assert.deepEqual([form.get("grant_type"), form.get("refresh_token")], ["refresh_token", "refresh-token-value"]);
    assert.equal(calls[1].init.headers.authorization, "Bearer access-1");
    const mime = Buffer.from(JSON.parse(calls[1].init.body).raw, "base64url").toString();
    assert.match(mime, /^From: AITM Security Agent <support@corp\.test>$/m);
    assert.match(mime, /^To: me@corp\.test$/m);
    assert.match(mime, /^Reply-To: lead@corp\.test$/m);
    assert.match(mime, /Pilot mode: this email was meant for owner@corp\.test/);

    // A revoked sign-in: nothing sent, nothing marked as delivered.
    globalThis.fetch = async () => Response.json({ error: "invalid_grant", error_description: "Token has been expired or revoked." }, { status: 400 });
    assert.deepEqual(await deliver(emails, { dryRun: false }), []);
  } finally {
    globalThis.fetch = realFetch;
    for (const k of keys) saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]);
  }
});
