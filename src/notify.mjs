// Builds and sends alert emails. Emails contain locations and fixes, never secret values.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEADLINE, SEVERITY_LABEL, bySeverity, log, warn } from "./util.mjs";

const MAX_BRANCHES_SHOWN = 5;

/** Applies the domain filter and the fallback recipient. Returns [] when nobody can receive it. */
export function recipientsFor(owners, { allowedDomains, fallback }) {
  let emails = owners?.emails ?? [];
  if (allowedDomains.length) emails = emails.filter((e) => allowedDomains.includes(e.split("@")[1]));
  if (emails.length) return { emails, why: owners.why };
  if (fallback)
    return {
      emails: [fallback],
      why: owners?.emails?.length
        ? `you are the fallback recipient: the likely owner (${owners.emails.join(", ")}) is outside the company email domains`
        : "you are the fallback recipient: no owner could be found for this repository",
    };
  return { emails: [], why: "" };
}

/**
 * Groups findings by recipient: one email per person per run, covering all their repos.
 * kind: "immediate" (new critical findings) or "digest" (everything open).
 */
export function buildEmails(findings, { state, kind, settings, resolvedSince = [] }) {
  const perRecipient = new Map();
  const undeliverable = [];
  const add = (f, bucket) => {
    const repo = state.repos[f.repoKey];
    const to = recipientsFor(repo?.owners, settings);
    if (!to.emails.length) return undeliverable.push(f);
    for (const email of to.emails) {
      const entry = perRecipient.get(email) ?? { open: new Map(), fixed: new Map() };
      const list = entry[bucket].get(f.repoKey) ?? { repo, why: to.why, findings: [] };
      list.findings.push(f);
      entry[bucket].set(f.repoKey, list);
      perRecipient.set(email, entry);
    }
  };
  findings.forEach((f) => add(f, "open"));
  resolvedSince.forEach((f) => add(f, "fixed"));

  const emails = [];
  for (const [to, entry] of perRecipient) {
    if (!entry.open.size && kind === "immediate") continue;
    const all = [...entry.open.values()].flatMap((r) => r.findings);
    const critical = all.filter((f) => f.severity === "critical").length;
    const subject =
      kind === "immediate"
        ? `[Security] ${critical} new critical issue${critical === 1 ? "" : "s"} in ${[...entry.open.values()].map((r) => r.repo.name).join(", ")}`
        : `[Security] Weekly digest: ${all.length} open issue${all.length === 1 ? "" : "s"}${critical ? `, ${critical} critical` : ""}`;
    emails.push({ to, subject, text: renderText(kind, entry), fps: all.map((f) => f.fp) });
  }
  return { emails, undeliverable };
}

function renderText(kind, entry) {
  const out = [];
  out.push("Hello,", "");
  out.push(
    kind === "immediate"
      ? "The security agent found new critical issues in repositories you are responsible for. Please act on them now."
      : "Here is the weekly list of open security issues in repositories you are responsible for.",
  );
  out.push("Secret values are never included in these emails.", "");
  for (const { repo, why, findings } of entry.open.values()) {
    out.push(`=== ${repo.name}${repo.webUrl ? `  (${repo.webUrl})` : ""}`);
    out.push(`Why you: ${why}`, "");
    for (const f of [...findings].sort(bySeverity)) {
      out.push(`[${SEVERITY_LABEL[f.severity]}] ${f.title}`);
      out.push(`  Where: ${whereText(f)}`);
      out.push(`  Fix: ${DEADLINE[f.severity]}`);
      out.push(`  What to do: ${f.advice}`, "");
    }
  }
  if (entry.fixed.size) {
    out.push("=== Fixed since the last digest (thank you)");
    for (const { repo, findings } of entry.fixed.values())
      for (const f of findings) out.push(`  - ${repo.name}: ${f.title}`);
    out.push("");
  }
  out.push("-- AITM security agent (automated email). Reply to this email if a finding is wrong.");
  return out.join("\n");
}

function whereText(f) {
  if (f.repoLevel) return `git history, ${f.detail}`;
  const branches = Object.entries(f.branches).sort(([a], [b]) => a.localeCompare(b));
  const shown = branches.slice(0, MAX_BRANCHES_SHOWN).map(([b, locs]) => `${b}: ${locs.join(", ")}`);
  const more = branches.length - shown.length;
  return shown.join(" | ") + (more > 0 ? ` | and ${more} more branch${more === 1 ? "" : "es"}` : "");
}

/** Sends through Gmail SMTP (MAIL_FROM can carry a display name, MAIL_REPLY_TO keeps replies out of the
 * sending mailbox), or writes the emails to disk in dry-run mode. Returns the delivered emails. */
export async function deliver(emails, { dryRun, outDir, redirectTo }) {
  if (!emails.length) return [];
  if (dryRun) {
    const dir = join(outDir, "emails");
    mkdirSync(dir, { recursive: true });
    emails.forEach((e, i) =>
      writeFileSync(join(dir, `${String(i + 1).padStart(2, "0")}-${e.to.replace(/[^\w.@-]/g, "_")}.txt`), `To: ${e.to}\nSubject: ${e.subject}\n\n${e.text}\n`),
    );
    log(`dry run: ${emails.length} email(s) written to ${dir}`);
    return emails;
  }
  const user = process.env.SMTP_USER?.trim();
  const pass = process.env.SMTP_PASS?.replace(/\s+/g, ""); // App Passwords are shown with spaces
  if (!user || !pass) {
    warn(`SEND_EMAILS is true but SMTP_USER or SMTP_PASS is not set: ${emails.length} email(s) not sent`);
    return [];
  }
  const { default: nodemailer } = await import("nodemailer");
  const transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST ?? "smtp.gmail.com",
    port: Number(process.env.SMTP_PORT ?? 465),
    secure: true,
    auth: { user, pass },
  });
  try {
    await transport.verify();
  } catch (err) {
    // Usually: the normal account password was used instead of an App Password (535-5.7.8).
    warn(`cannot sign in to ${process.env.SMTP_HOST ?? "smtp.gmail.com"} as ${user}: ${err.message}. ${emails.length} email(s) not sent`);
    return [];
  }
  const from = process.env.MAIL_FROM || user;
  const replyTo = process.env.MAIL_REPLY_TO || undefined;
  const sent = [];
  for (const e of emails) {
    const to = redirectTo || e.to;
    const text = redirectTo ? `[Pilot mode: this email was meant for ${e.to}]\n\n${e.text}` : e.text;
    try {
      await transport.sendMail({ from, replyTo, to, subject: e.subject, text });
      sent.push(e);
    } catch (err) {
      warn(`email to ${to} failed: ${err.message}`);
    }
  }
  log(`${sent.length}/${emails.length} email(s) sent`);
  return sent;
}
