import { test } from "node:test";
import assert from "node:assert/strict";
import { buildEmails, deliver } from "../src/notify.mjs";
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
    const emails = [{ to: ["lead1@corp.test", "lead2@corp.test"], subject: "2 new issues", text: "body", html: "<p>body</p>", fps: ["a"] }];
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
    assert.match(mime, /Content-Type: multipart\/alternative/, "HTML with a plain-text copy");
    assert.match(mime, /Content-Type: text\/html/);

    // Without the pilot redirect, one email goes to every tech lead.
    calls.length = 0;
    await deliver(emails, { dryRun: false });
    const mime2 = Buffer.from(JSON.parse(calls.at(-1).init.body).raw, "base64url").toString();
    assert.match(mime2, /^To: lead1@corp\.test, lead2@corp\.test$/m);

    // A revoked sign-in: nothing sent, nothing marked as delivered.
    globalThis.fetch = async () => Response.json({ error: "invalid_grant", error_description: "Token has been expired or revoked." }, { status: 400 });
    assert.deepEqual(await deliver(emails, { dryRun: false }), []);
  } finally {
    globalThis.fetch = realFetch;
    for (const k of keys) saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]);
  }
});

test("one email to all tech leads: HTML, critical first, links to the push and the files, everything escaped", () => {
  const sha = "a".repeat(40);
  const prev = "b".repeat(40);
  const now = "2026-11-25T10:17:00.000Z";
  const state = {
    repos: {
      "github:1": {
        name: "acme/web",
        webUrl: "https://github.com/acme/web",
        branches: { "dev/chat": sha },
        tips: { "dev/chat": { sha, prevSha: prev, author: "Dev One", date: "2026-11-25T10:00:00+00:00", subject: "add <chat>", scannedAt: now } },
      },
    },
  };
  const f = (fp, severity, extra) => ({ fp, repoKey: "github:1", severity, title: `${severity} <issue>`, advice: "do it", status: "open", ...extra });
  const findings = [
    f("1", "low", { branches: { "dev/chat": ["app/a.ts:3"] } }),
    f("2", "critical", { branches: { "dev/chat": ["app/api/x/route.ts:12"] } }),
    f("3", "critical", { repoLevel: true, detail: "line 4, commit 1a2b3c4d by Dev on 2026-11-01" }),
  ];
  const settings = { recipients: ["l1@corp.test", "l2@corp.test", "l3@corp.test"], redirectTo: "me@corp.test" };
  const { emails } = buildEmails(findings, { state, kind: "immediate", settings, now, stillOpen: 4 });
  assert.equal(emails.length, 1);
  const [e] = emails;
  assert.deepEqual(e.to, settings.recipients);
  assert.equal(e.subject, "[Security] New issues in acme/web: 2 critical, 1 low");
  const h = e.html;
  assert.ok(h.indexOf("critical &lt;issue&gt;") < h.indexOf("low &lt;issue&gt;"), "critical first");
  assert.doesNotMatch(h, /<issue>|<chat>/, "titles and commit messages are escaped");
  assert.match(h, /Pilot mode: this email was meant for l1@corp\.test, l2@corp\.test, l3@corp\.test/);
  assert.ok(h.includes(`https://github.com/acme/web/compare/${prev}...${sha}`), "link to the changes pushed");
  assert.ok(h.includes(`https://github.com/acme/web/blob/${sha}/app/api/x/route.ts#L12`), "link to the file and line");
  assert.ok(h.includes("https://github.com/acme/web/commit/1a2b3c4d"), "history findings link their commit");
  assert.ok(h.includes("Still open from earlier scans: <b>4</b>"));
  assert.match(e.text, /^\[Pilot mode/);
  assert.ok(e.text.indexOf("=== CRITICAL (2)") < e.text.indexOf("=== LOW (1)"));

  // Nobody to send to: nothing built, every finding reported as undeliverable.
  const none = buildEmails(findings, { state, kind: "immediate", settings: { recipients: [] }, now });
  assert.deepEqual([none.emails.length, none.undeliverable.length], [0, 3]);
});
