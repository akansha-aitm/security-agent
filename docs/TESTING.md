# Testing the agent on a personal GitHub account

Goal: run the real workflow on GitHub, against one private sample repository with planted (fake)
issues, with every email going to you. Then move to the organisation.

## 1. Generate the sample project

```sh
cd AITM-security_agent
node test/make-sample-app.mjs ../security-agent-sample-app
```

It creates a Next.js repo with 4 branches (`main`, `dev/ai-chat`, `dev/payments`, `dev/clean`). Only the
`dev/` branches are scanned; `main` is the base they start from. All keys are fake, generated at runtime.

**Already pushed the older sample (with `feature/...` branches)?** Rename them on GitHub, e.g.
`git push origin feature/ai-chat:dev/ai-chat :feature/ai-chat` (same for `payments`, `clean`, `api-routes`).

## 2. Push both repositories to your account (both PRIVATE)

On github.com, create two **private, empty** repositories (no README, no .gitignore):
`security-agent` and `security-agent-sample-app`.

```sh
# the agent
cd AITM-security_agent
git init -b main
git add -A
git commit -m "Security agent prototype"
git remote add origin https://github.com/<your-username>/security-agent.git
git push -u origin main

# the sample app, all branches
cd ../security-agent-sample-app
git remote add origin https://github.com/<your-username>/security-agent-sample-app.git
git push -u origin --all
```

If GitHub refuses the sample-app push with `GH013 ... push cannot contain secrets`, its secret protection
recognised the fake keys. They are fake: open the link in the error message and choose "It's used in tests".

## 3. Create a read-only token for the test

github.com > Settings > Developer settings > Personal access tokens > **Fine-grained tokens** > Generate:

- Name: `security-agent-test`, expiration: 30 days
- Resource owner: you
- Repository access: **Only select repositories** > `security-agent-sample-app`
- Repository permissions: **Contents: Read-only** (Metadata: Read-only is added automatically). Nothing else.

Copy the token (it starts with `github_pat_`).

## 4. Give the agent permission to send as support@ (send-only Google sign-in)

Alerts are sent **from the company support account**, but during the test they all go **to you**
(`REDIRECT_EMAILS_TO`). The agent gets a send-only permission: it cannot read the support mailbox,
and support@ needs no App Password or 2-Step Verification.

**4a. Google Cloud project** (signed in with your own work account, at console.cloud.google.com)

1. Project picker (top bar) > **New project**, name `security-agent`. Organisation: your company domain.
2. APIs & Services > Library > **Gmail API** > Enable.
3. APIs & Services > **OAuth consent screen** (Google Auth Platform) > Get started:
   app name `AITM Security Agent`, support email: yours, audience **Internal**, contact email: yours.
   Internal means only company accounts can sign in, and Google does not need to review the app.
4. **Data access** > Add or remove scopes > tick `.../auth/gmail.send` > Update > Save.
5. **Clients** > Create client > Application type **Desktop app**, name `security-agent` > Create >
   **Download JSON**. Keep the file out of the project folder (e.g. in Downloads).

If "Internal" cannot be selected, the project has no organisation: pick the company organisation when
creating it, or ask the Workspace admin. (Avoid "External" + "Testing": its sign-ins expire after 7 days.)

**4b. Sign in once as support@** (in your own terminal window, not through a chat assistant: it prints secrets)

```sh
cd AITM-security_agent
npm run gmail-auth -- "C:/Users/<you>/Downloads/client_secret_XXXX.json" --account support@aitomarketgroup.com
```

A browser opens: sign in **as support@**, allow "Send email on your behalf". The terminal then prints
three values: `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN`. Copy them into GitHub
(step 5), then close the terminal and delete the downloaded JSON file.

The script refuses to print anything if you signed in with a different account or did not allow sending.

**Good to know**

- If support@'s **password changes**, Google cancels the permission: run step 4b again and replace
  `GMAIL_REFRESH_TOKEN`. The run's log says `invalid_grant` when this happens.
- To stop the agent sending: as support@, myaccount.google.com > Security > Third-party connections >
  AITM Security Agent > Remove access.
- Alerts appear in support@'s **Sent** folder; tell whoever reads that inbox. Replies go to `MAIL_REPLY_TO`.

## 5. Configure the agent's repository

In `security-agent` on GitHub: Settings > Secrets and variables > Actions.

**Secrets**

| Name | Value |
|---|---|
| `SCAN_TOKEN` | the fine-grained token (GitHub does not allow secret names starting with `GITHUB_`) |
| `GMAIL_CLIENT_SECRET` | printed by `npm run gmail-auth` |
| `GMAIL_REFRESH_TOKEN` | printed by `npm run gmail-auth` |

**Variables**

| Name | Value |
|---|---|
| `GMAIL_CLIENT_ID` | printed by `npm run gmail-auth` |
| `MAIL_FROM` | `AITM Security Agent <support@aitomarketgroup.com>` |
| `MAIL_REPLY_TO` | your email (replies come to you, not to the support inbox) |
| `SEND_EMAILS` | `true` |
| `REDIRECT_EMAILS_TO` | your email (safety net: every email comes to you) |
| `ALERT_EMAILS` | optional during the test: the tech leads' emails, comma-separated (shown in the pilot note only) |
| `REPOS` | `security-agent-sample-app` |

Do **not** set `ENABLE_SCHEDULE`: during the test the workflow only runs when you start it.
`SCAN_GITHUB_OWNER` is not needed: it defaults to the account that owns the agent's repo.

**Scanning all your repositories instead of only the sample:** create the token with Repository access
**All repositories** (same permission, Contents: Read-only) and delete the `REPOS` variable. Only repos with `dev/` branches
are scanned. Forks, archived repos and the agent's own
repo are skipped. The counts in the table below then include your other repos' findings.

## 6. Run the test scenarios

Actions tab > **security-scan** > Run workflow, choose the mode.

| # | Do | Expected |
|---|---|---|
| 1 | Run **inventory** | Job summary lists 8 `NEXT_PUBLIC_` variables: SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY *allowed*; SUPABASE_ANON_KEY *deprecated*; OPENAI_API_KEY and STRIPE_SECRET_KEY *forbidden (critical)*; DEMO_MODE *forbidden (high)*; POSTHOG_KEY and GA_MEASUREMENT_ID *review*. No email. |
| 2 | Run **scan** | One HTML email within a minute with all **14 new issues**, critical first: coloured counts 8 critical, 3 high, 1 low, 2 to check; "What was pushed" lists the 3 `dev/` branches with commit links. |
| 3 | Run **scan** again | Log says `0/1 repos ... scanned`, no email. |
| 4 | Run **digest** | One email: all **14 open issues** (8 critical, 3 high, 1 low, 2 to be validated). |
| 5 | Fix one: on `dev/payments`, change `NEXT_PUBLIC_STRIPE_SECRET_KEY` to `STRIPE_SECRET_KEY` in `lib/stripe.ts`, push, run **scan** | No email (fixes are not alerted immediately). |
| 6 | Run **digest** | 13 open issues, and "Fixed since the last digest: NEXT_PUBLIC_STRIPE_SECRET_KEY". |
| 7 | New problem: create a branch `dev/test`, add `const k = process.env.NEXT_PUBLIC_ANTHROPIC_KEY;` to any `.ts` file, push, run **scan** | One email with **only** that new critical issue, and a link to the commit. |

**The 8 critical issues of scenario 2**

| Issue | Where |
|---|---|
| `NEXT_PUBLIC_OPENAI_API_KEY` exposed in the browser | dev/ai-chat: `.env`, `components/chat.tsx` |
| `.env` file committed | dev/ai-chat |
| `NEXT_PUBLIC_STRIPE_SECRET_KEY` exposed in the browser | dev/payments: `lib/stripe.ts` |
| `.env.local` still in git history | main history |
| gitleaks: OpenAI key | `.env` (dev/ai-chat) |
| gitleaks: Anthropic key | `lib/summarize.ts` (dev/payments) |
| gitleaks: GitHub token | `.env.local` (history) |
| gitleaks: generic API key (the fake Supabase secret) | `.env.local` (history) |

**High (3):** `.gitignore` does not exclude `.env` (3 branches), `next.config.mjs` `env` key (3 branches),
`NEXT_PUBLIC_DEMO_MODE`. **Low (1):** legacy `NEXT_PUBLIC_SUPABASE_ANON_KEY`.
**To be validated (2):** `NEXT_PUBLIC_POSTHOG_KEY`, `NEXT_PUBLIC_GA_MEASUREMENT_ID`.
`dev/clean` must not add any issue.

If no email arrives, open the run's log: `cannot sign in to Gmail API ... invalid_grant` means the sign-in
was cancelled (password change, access removed) or the token was pasted wrongly: redo step 4b;
`no sender configured` or `GMAIL_CLIENT_ID ... missing` means a secret or variable name is wrong.
Nothing is marked as sent in either case, so the next run retries.

Check in every email: it starts with "Pilot mode: this email was meant for ..." (the `ALERT_EMAILS` list),
the file links open the right line on GitHub, and **no key value appears anywhere**.

## 7. API endpoint checks

**7a. Add the planted routes to the sample repo** (already done locally if Claude ran it for you)

```sh
cd AITM-security_agent
node test/add-sample-routes.mjs ../security-agent-sample-app
cd ../security-agent-sample-app
git push -u origin dev/api-routes
```

It creates a branch `dev/api-routes` with 18 endpoints: 8 safe, 10 unsafe.

**7b. Run and check** (Actions > security-scan > Run workflow)

| # | Do | Expected |
|---|---|---|
| 8 | Run **scan** | One email with the **22 new endpoint issues**, the 2 critical first: no login check on `/api/ai/generate` (LLM) and `/api/admin/set-role` (uses the Supabase secret key); then 12 high and 8 medium. |
| 9 | Run **inventory** | Job summary, "API endpoints": 18 rows. 0 issues on `/api/chat`, `/api/search`, `/api/summaries`, `/api/webhooks/stripe`, `/api/cron/refresh`, `/api/health`, `server actions in app/actions/profile.ts`, `/functions/v1/hello`. |
| 10 | Run **digest** | The endpoint issues are listed with the others: 2 critical, 12 high and 8 medium more than before. |
| 11 | Fix one: on `dev/api-routes`, delete `app/api/admin/set-role/route.ts`, push, run **scan** | No email. The next digest lists 2 fixed issues for `/api/admin/set-role`. |

Issues expected on the unsafe endpoints (the unit test checks the same list):

| Endpoint | Kind | Issues |
|---|---|---|
| `/api/ai/generate` | LLM | no login (critical), GET handler, no rate limit, model/system from the request (high); no input limit, no maxDuration (medium) |
| `/api/admin/set-role` | other | no login (critical, secret key), user id/role from the request (high) |
| `/api/link-preview` | third-party | user URL fetched (SSRF), key in logs (high); no timeout (medium) |
| `/api/documents/process` | container | user's headers forwarded, user path (SSRF) (high); no timeout (medium) |
| `/api/export` | container (assumed: `REPORTS_URL` is unknown) | no service credential, no timeout (medium) |
| `/api/cron/cleanup` | cron | no `CRON_SECRET` (high) |
| `/api/webhooks/n8n` | webhook | no signature check (high) |
| `/api/profile` | other | GET changes data (medium) |
| `server actions in app/actions/notes.ts` | server action | no login (high) |
| `/functions/v1/send-digest` | Supabase function | `verify_jwt = false` and no login (high); no timeout (medium) |

If the saved state was lost (no run for 7 days), the next scan re-sends every open issue once.

## 8. Move to the organisation

1. Delete the test token (Settings > Developer settings) and the variable `REPOS` and the secret `SCAN_TOKEN`.
2. Move the agent's repo into the organisation (Settings > Transfer) or push it to a new private org repo.
3. An org admin creates the GitHub App (Contents: read, Metadata: read), installs it on all repositories,
   and you set `SCAN_APP_CLIENT_ID` (variable) and `SCAN_APP_PRIVATE_KEY` (secret).
4. Move secrets into an environment `security-scan` restricted to `main`; protect `main`.
5. Keep support@ as the sender (move the `GMAIL_*` values into the `security-scan` environment), set
   `ALERT_EMAILS` to the three tech leads.
6. Run **inventory**, review the list with Khushi, update the allowlist.
7. Keep `REDIRECT_EMAILS_TO` for a few days with all repos, then remove it (the tech leads get the emails) and set `ENABLE_SCHEDULE=true`.
