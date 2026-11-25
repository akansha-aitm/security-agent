// Builds and sends alert emails: one email per run, to every tech lead, as HTML with a plain-text copy.
// Emails contain locations and fixes, never secret values.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createMailer } from "./mailer.mjs";
import { DEADLINE, SEVERITIES, SEVERITY_LABEL, bySeverity, log, warn } from "./util.mjs";

const MAX_BRANCHES_SHOWN = 5;
const SHORT = { critical: "critical", high: "high", medium: "medium", low: "low", review: "to check" };

// Severity colours (text on badge passes WCAG AA).
const SEV = {
  critical: { fg: "#FFFFFF", bg: "#B0212B" },
  high: { fg: "#FFFFFF", bg: "#C2410C" },
  medium: { fg: "#4A3200", bg: "#F5B83D" },
  low: { fg: "#FFFFFF", bg: "#2F6690" },
  review: { fg: "#FFFFFF", bg: "#5B6B60" },
};
const C = { forest: "#163D26", green: "#185F00", line: "#E0DCD3", muted: "#5B6B60", pale: "#E8EDE4", page: "#F4F5F2" };
const FONT = "Montserrat,'Segoe UI',Arial,sans-serif";

/**
 * kind: "immediate" (findings not emailed yet) or "digest" (everything open, plus what was fixed).
 * settings: { recipients[], redirectTo }. Returns { emails, undeliverable }: at most one email.
 */
export function buildEmails(findings, { state, kind, settings, resolvedSince = [], stillOpen = 0, now = new Date().toISOString() }) {
  const recipients = settings.recipients ?? [];
  if (!findings.length && !(kind === "digest" && resolvedSince.length)) return { emails: [], undeliverable: [] };
  if (!recipients.length && !settings.redirectTo) return { emails: [], undeliverable: findings };
  const m = {
    kind,
    state,
    now,
    stillOpen,
    findings: [...findings].sort((a, b) => bySeverity(a, b) || repoName(state, a).localeCompare(repoName(state, b)) || a.title.localeCompare(b.title)),
    fixed: resolvedSince,
    pilot: settings.redirectTo ? `Pilot mode: this email was meant for ${recipients.join(", ") || "the tech leads (ALERT_EMAILS is not set yet)"}` : null,
  };
  m.counts = countBy(m.findings);
  m.subject = subjectFor(m);
  return {
    emails: [{ to: recipients, subject: m.subject, text: renderText(m), html: renderHtml(m), fps: findings.map((f) => f.fp) }],
    undeliverable: [],
  };
}

// ---------- shared helpers

const repoOf = (state, f) => state.repos[f.repoKey] ?? { name: f.repoKey, branches: {} };
const repoName = (state, f) => repoOf(state, f).name;
const countBy = (list) => Object.fromEntries(SEVERITIES.map((s) => [s, list.filter((f) => f.severity === s).length]));
const countText = (counts) => SEVERITIES.filter((s) => counts[s]).map((s) => `${counts[s]} ${SHORT[s]}`).join(", ");
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const day = (iso) => (iso ? String(iso).slice(0, 10) : "");
const when = (iso) => `${String(iso).slice(0, 16).replace("T", " ")} UTC`;

function subjectFor(m) {
  const repos = [...new Set(m.findings.map((f) => repoName(m.state, f)))];
  const where = repos.length <= 2 ? repos.join(", ") : `${repos.length} repos`;
  if (m.kind === "immediate") return `[Security] New issues in ${where}: ${countText(m.counts)}`;
  const n = m.findings.length;
  return `[Security] Weekly digest: ${plural(n, "open issue")}${n ? ` (${countText(m.counts)})` : ""}`;
}

/** Links into GitHub or GitLab, or null for local repos (testing). */
function linker(repoKey, webUrl) {
  if (!webUrl || !/^https?:\/\//.test(webUrl)) return null;
  const base = webUrl.replace(/\/$/, "") + (repoKey.startsWith("gitlab:") ? "/-" : "");
  const path = (p) => p.split("/").map(encodeURIComponent).join("/");
  return {
    repo: webUrl,
    commit: (sha) => `${base}/commit/${sha}`,
    compare: (from, to) => `${base}/compare/${from}...${to}`,
    branch: (b) => `${base}/tree/${path(b)}`,
    file: (sha, p, line) => `${base}/blob/${sha}/${path(p)}${line ? `#L${line}` : ""}`,
  };
}

/** "app/api/x/route.ts:12" -> { path, line } */
const parseLoc = (loc) => {
  const m = String(loc).match(/^(.*?):(\d+)$/);
  return m ? { path: m[1], line: Number(m[2]) } : { path: String(loc), line: null };
};

/** Branches (sorted, capped) with their locations for a branch-level finding. */
function branchesOf(f) {
  const all = Object.entries(f.branches ?? {}).sort(([a], [b]) => a.localeCompare(b));
  return { shown: all.slice(0, MAX_BRANCHES_SHOWN), more: Math.max(0, all.length - MAX_BRANCHES_SHOWN) };
}

/** Branch tips scanned in this run, for the repos in this email. */
function pushedThisRun(m) {
  const out = [];
  for (const key of new Set(m.findings.map((f) => f.repoKey))) {
    const repo = m.state.repos[key];
    const tips = Object.entries(repo?.tips ?? {}).filter(([, t]) => t.scannedAt === m.now);
    if (tips.length) out.push({ key, repo, tips: tips.sort(([a], [b]) => a.localeCompare(b)) });
  }
  return out;
}

// ---------- plain text (for mail apps that do not show HTML)

function renderText(m) {
  const out = [];
  if (m.pilot) out.push(`[${m.pilot}]`, "");
  out.push("Hello,", "");
  out.push(
    m.kind === "immediate"
      ? "The security agent found new issues in the latest pushes to dev/ branches. The most urgent come first."
      : "Here is the weekly list of open security issues in the dev/ branches.",
  );
  out.push("Secret values are never included in these emails.", "");
  if (m.findings.length) out.push(`Summary: ${countText(m.counts)}`);
  if (m.kind === "immediate" && m.stillOpen) out.push(`Still open from earlier scans: ${m.stillOpen} (listed in Monday's digest)`);
  out.push("");

  if (m.kind === "immediate") {
    const pushed = pushedThisRun(m);
    if (pushed.length) out.push("=== What was pushed");
    for (const { key, repo, tips } of pushed) {
      const link = linker(key, repo.webUrl);
      for (const [branch, t] of tips) {
        out.push(`${repo.name}  ${branch}  ${t.sha.slice(0, 7)} "${t.subject}" by ${t.author}, ${day(t.date)}`);
        if (link) out.push(`  ${t.prevSha ? link.compare(t.prevSha, t.sha) : link.commit(t.sha)}`);
      }
    }
    if (pushed.length) out.push("");
  }

  for (const sev of SEVERITIES) {
    const list = m.findings.filter((f) => f.severity === sev);
    if (!list.length) continue;
    out.push(`=== ${SEVERITY_LABEL[sev]} (${list.length}) - fix ${DEADLINE[sev]}`, "");
    for (const f of list) {
      const repo = repoOf(m.state, f);
      out.push(`[${SEVERITY_LABEL[sev]}] ${f.title}`);
      out.push(`  Repo: ${repo.name}${repo.webUrl ? `  (${repo.webUrl})` : ""}`);
      if (f.repoLevel) out.push(`  Where: git history, ${f.detail}`);
      else {
        const { shown, more } = branchesOf(f);
        out.push(`  Where: ${shown.map(([b, locs]) => `${b}: ${locs.join(", ")}`).join(" | ")}${more ? ` | and ${plural(more, "more branch")}` : ""}`);
      }
      out.push(`  What to do: ${f.advice}`, "");
    }
  }
  if (m.fixed.length) {
    out.push("=== Fixed since the last digest (thank you)");
    for (const f of m.fixed) out.push(`  - ${repoName(m.state, f)}: ${f.title}`);
    out.push("");
  }
  out.push("-- AITM security agent (automated email). Reply to this email if a finding is wrong.");
  return out.join("\n");
}

// ---------- HTML (inline styles only: mail apps drop <style> blocks and scripts)

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const a = (href, text, style = "") =>
  href ? `<a href="${esc(href)}" style="color:${C.green};text-decoration:underline;${style}">${esc(text)}</a>` : esc(text);
const code = (text) =>
  `<span style="font-family:Consolas,Menlo,monospace;font-size:12px;background:${C.pale};border-radius:3px;padding:1px 4px">${esc(text)}</span>`;
const h2 = (text) => `<p style="margin:26px 0 10px;font-size:12px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:${C.green}">${esc(text)}</p>`;
const badge = (sev) =>
  `<span style="display:inline-block;background:${SEV[sev].bg};color:${SEV[sev].fg};font-size:10px;font-weight:700;letter-spacing:.6px;border-radius:10px;padding:2px 8px">${esc(SEVERITY_LABEL[sev])}</span>`;

function renderHtml(m) {
  const title = m.kind === "immediate" ? "New security issues" : "Weekly security digest";
  const parts = [];
  if (m.pilot)
    parts.push(`<p style="margin:0 0 16px;padding:10px 12px;background:#FBE9C6;color:#8A5A00;border-radius:6px;font-size:13px">${esc(m.pilot)}</p>`);
  parts.push(
    `<p style="margin:0 0 6px;font-size:14px;line-height:1.5">${
      m.kind === "immediate"
        ? "The security agent found new issues in the latest pushes to <b>dev/</b> branches. The most urgent come first."
        : "Every open security issue in the <b>dev/</b> branches, most urgent first, and what was fixed this week."
    }</p>`,
    `<p style="margin:0 0 18px;font-size:12px;color:${C.muted}">Secret values are never included in these emails, only where they are.</p>`,
  );
  if (m.findings.length) parts.push(summaryRow(m));
  if (m.kind === "immediate" && m.stillOpen)
    parts.push(`<p style="margin:10px 0 0;font-size:12px;color:${C.muted}">Still open from earlier scans: <b>${m.stillOpen}</b> (listed in Monday's digest).</p>`);
  if (m.kind === "immediate") parts.push(pushedHtml(m));
  else parts.push(reposHtml(m));

  for (const sev of SEVERITIES) {
    const list = m.findings.filter((f) => f.severity === sev);
    if (!list.length) continue;
    parts.push(
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:26px 0 10px"><tr>` +
        `<td style="background:${SEV[sev].bg};color:${SEV[sev].fg};padding:8px 12px;border-radius:6px;font-size:13px;font-weight:700;letter-spacing:.5px">` +
        `${esc(SEVERITY_LABEL[sev])} &middot; ${list.length}<span style="font-weight:400"> &nbsp;&middot;&nbsp; fix ${esc(DEADLINE[sev])}</span></td></tr></table>`,
    );
    for (const f of list) parts.push(findingCard(m, f));
  }

  if (m.fixed.length) {
    parts.push(h2(`Fixed since the last digest (${m.fixed.length}), thank you`));
    parts.push(
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.pale};border-radius:6px"><tr><td style="padding:10px 14px;font-size:13px;line-height:1.7">` +
        m.fixed.map((f) => `<span style="color:${C.green};font-weight:700">&#10003;</span> ${esc(repoName(m.state, f))}: ${esc(f.title)}`).join("<br>") +
        `</td></tr></table>`,
    );
  }

  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(m.subject)}</title></head>
<body style="margin:0;padding:0;background:${C.page}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.page}"><tr><td align="center" style="padding:20px 10px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:680px;background:#FFFFFF;border:1px solid ${C.line};border-radius:8px;font-family:${FONT};color:#1D2A22">
<tr><td style="background:${C.forest};border-radius:8px 8px 0 0;padding:18px 24px">
<p style="margin:0;font-size:11px;font-weight:700;letter-spacing:1px;color:#B9CDB5">AITM SECURITY AGENT</p>
<p style="margin:4px 0 0;font-size:22px;font-weight:700;color:#FFFFFF">${esc(title)}</p>
<p style="margin:4px 0 0;font-size:12px;color:#B9CDB5">${esc(when(m.now))}</p>
</td></tr>
<tr><td style="padding:22px 24px 8px">
${parts.join("\n")}
</td></tr>
<tr><td style="padding:16px 24px 22px;font-size:11px;color:${C.muted};border-top:1px solid ${C.line}">
Automated email from the AITM security agent. Reply to this email if a finding is wrong.
</td></tr>
</table>
</td></tr></table>
</body></html>
`;
}

/** Five coloured count tiles; severities with no issue are greyed out. */
function summaryRow(m) {
  const cells = SEVERITIES.map((s) => {
    const n = m.counts[s];
    const style = n ? `background:${SEV[s].bg};color:${SEV[s].fg}` : `background:${C.pale};color:#9AA59D`;
    return (
      `<td width="20%" style="padding:0 3px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>` +
      `<td align="center" style="${style};border-radius:6px;padding:10px 4px">` +
      `<div style="font-size:22px;font-weight:700;line-height:1.1">${n}</div>` +
      `<div style="font-size:10px;font-weight:700;letter-spacing:.5px;text-transform:uppercase">${esc(SHORT[s])}</div>` +
      `</td></tr></table></td>`
    );
  }).join("");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>${cells}</tr></table>`;
}

/** Immediate email: the branches pushed, with links to the commit and to the changes since the last scan. */
function pushedHtml(m) {
  const pushed = pushedThisRun(m);
  if (!pushed.length) return "";
  const rows = [];
  for (const { key, repo, tips } of pushed) {
    const link = linker(key, repo.webUrl);
    for (const [branch, t] of tips) {
      const changes = link ? (t.prevSha ? a(link.compare(t.prevSha, t.sha), "View changes") : a(link.commit(t.sha), "View commit")) : "";
      rows.push(
        `<tr><td style="padding:10px 12px;border-top:1px solid ${C.line};font-size:13px;line-height:1.5">` +
          `<b>${a(link?.repo, repo.name, "color:#163D26;text-decoration:none")}</b> &middot; ${link ? a(link.branch(branch), branch) : code(branch)}<br>` +
          `${link ? a(link.commit(t.sha), t.sha.slice(0, 7), "font-family:Consolas,Menlo,monospace") : code(t.sha.slice(0, 7))} ` +
          `&ldquo;${esc(t.subject)}&rdquo;<br>` +
          `<span style="font-size:12px;color:${C.muted}">by ${esc(t.author)}, ${esc(day(t.date))}${t.prevSha ? "" : " &middot; new branch"}</span>` +
          (changes ? ` &nbsp;<span style="font-size:12px">${changes}</span>` : "") +
          `</td></tr>`,
      );
    }
  }
  return (
    h2("What was pushed") +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${C.line};border-top:0;border-radius:6px">${rows.join("")}</table>`
  );
}

/** Digest: open issues per repo. */
function reposHtml(m) {
  const per = new Map();
  for (const f of m.findings) {
    const e = per.get(f.repoKey) ?? { repo: repoOf(m.state, f), list: [] };
    e.list.push(f);
    per.set(f.repoKey, e);
  }
  if (!per.size) return "";
  const rows = [...per.entries()]
    .sort(([, x], [, y]) => y.list.length - x.list.length)
    .map(([key, { repo, list }]) => {
      const c = countBy(list);
      const pills = SEVERITIES.filter((s) => c[s])
        .map((s) => `<span style="display:inline-block;background:${SEV[s].bg};color:${SEV[s].fg};font-size:11px;font-weight:700;border-radius:10px;padding:1px 8px;margin:2px 2px 2px 0">${c[s]} ${esc(SHORT[s])}</span>`)
        .join("");
      return `<tr><td style="padding:8px 12px;border-top:1px solid ${C.line};font-size:13px;font-weight:700">${a(linker(key, repo.webUrl)?.repo, repo.name, "color:#163D26;text-decoration:none")}</td><td align="right" style="padding:8px 12px;border-top:1px solid ${C.line}">${pills}</td></tr>`;
    });
  return (
    h2("Open issues per repo") +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${C.line};border-top:0;border-radius:6px">${rows.join("")}</table>`
  );
}

function findingCard(m, f) {
  const repo = repoOf(m.state, f);
  const link = linker(f.repoKey, repo.webUrl);
  let where;
  if (f.repoLevel) {
    // History findings name a commit in their detail: link it.
    const detail = esc(`git history, ${f.detail ?? ""}`);
    where = link ? detail.replace(/\bcommit ([0-9a-f]{7,40})\b/, (_, sha) => `commit ${a(link.commit(sha), sha)}`) : detail;
  } else {
    const { shown, more } = branchesOf(f);
    where = shown
      .map(([branch, locs]) => {
        const sha = repo.branches?.[branch];
        const files = locs.map((loc) => {
          const { path, line } = parseLoc(loc);
          return link && sha ? a(link.file(sha, path, line), loc) : code(loc);
        });
        return `${link ? a(link.branch(branch), branch) : code(branch)}: ${files.join(", ")}`;
      })
      .join("<br>");
    if (more) where += `<br><span style="color:${C.muted}">and ${plural(more, "more branch")}</span>`;
  }
  return (
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 10px;border:1px solid ${C.line};border-left:4px solid ${SEV[f.severity].bg};border-radius:6px"><tr>` +
    `<td style="padding:12px 14px">` +
    `<p style="margin:0 0 4px;font-size:11px;color:${C.muted}">${badge(f.severity)} &nbsp;${a(link?.repo, repo.name, `color:${C.muted}`)}</p>` +
    `<p style="margin:0 0 8px;font-size:15px;font-weight:700;line-height:1.35;color:${C.forest}">${esc(f.title)}</p>` +
    `<p style="margin:0 0 6px;font-size:13px;line-height:1.55"><b>Where:</b> ${where}</p>` +
    `<p style="margin:0;font-size:13px;line-height:1.55"><b>What to do:</b> ${esc(f.advice)}</p>` +
    `</td></tr></table>`
  );
}

// ---------- delivery

/** Sends through the Gmail API or Gmail SMTP (see mailer.mjs), or writes the emails to disk in dry-run mode.
 * MAIL_FROM can carry a display name; MAIL_REPLY_TO keeps replies out of the sending mailbox.
 * redirectTo (pilot) sends everything to one address instead. Returns the delivered emails. */
export async function deliver(emails, { dryRun, outDir, redirectTo }) {
  if (!emails.length) return [];
  const toOf = (e) => redirectTo || [].concat(e.to).join(", ");
  if (dryRun) {
    const dir = join(outDir, "emails");
    mkdirSync(dir, { recursive: true });
    emails.forEach((e, i) => {
      const name = join(dir, String(i + 1).padStart(2, "0"));
      writeFileSync(`${name}.txt`, `To: ${toOf(e)}\nSubject: ${e.subject}\n\n${e.text}\n`);
      if (e.html) writeFileSync(`${name}.html`, e.html);
    });
    log(`dry run: ${emails.length} email(s) written to ${dir}`);
    return emails;
  }
  const mailer = await createMailer();
  if (mailer.error) {
    warn(`SEND_EMAILS is true but ${mailer.error}: ${emails.length} email(s) not sent`);
    return [];
  }
  try {
    await mailer.verify();
  } catch (err) {
    warn(`cannot sign in to ${mailer.name}: ${err.message}. ${emails.length} email(s) not sent`);
    return [];
  }
  const from = process.env.MAIL_FROM || process.env.SMTP_USER;
  const replyTo = process.env.MAIL_REPLY_TO || undefined;
  const sent = [];
  for (const e of emails) {
    const to = toOf(e);
    try {
      await mailer.send({ from, replyTo, to, subject: e.subject, text: e.text, ...(e.html ? { html: e.html } : {}) });
      sent.push(e);
    } catch (err) {
      warn(`email to ${to} failed: ${err.message}`);
    }
  }
  log(`${sent.length}/${emails.length} email(s) sent through ${mailer.name}`);
  return sent;
}
