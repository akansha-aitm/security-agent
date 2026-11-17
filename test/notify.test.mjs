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
