# Testing the agent on a personal GitHub account

Goal: run the real workflow on GitHub, against one private sample repository with planted (fake)
issues, with every email going to you. Then move to the organisation.

## 1. Generate the sample project

```sh
cd AITM-security_agent
node test/make-sample-app.mjs ../security-agent-sample-app --owner <your work email>
```

It creates a Next.js repo with 4 branches (`main`, `feature/ai-chat`, `feature/payments`, `feature/clean`)
and a `.github/CODEOWNERS` that routes its alerts to you. All keys are fake, generated at runtime.

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
| `REPOS` | `security-agent-sample-app` |

Do **not** set `ENABLE_SCHEDULE`: during the test the workflow only runs when you start it.
`SCAN_GITHUB_OWNER` is not needed: it defaults to the account that owns the agent's repo.

**Scanning all your repositories instead of only the sample:** create the token with Repository access
**All repositories** (same permission, Contents: Read-only), delete the `REPOS` variable, and add the
variable `FALLBACK_EMAIL` = your email. Repos without a `CODEOWNERS` file may have no owner the agent
can find; without `FALLBACK_EMAIL` their alerts are not sent. Forks, archived repos and the agent's own
repo are skipped. The counts in the table below then include your other repos' findings.

## 6. Run the test scenarios

Actions tab > **security-scan** > Run workflow, choose the mode.

| # | Do | Expected |
|---|---|---|
| 1 | Run **inventory** | Job summary lists 7 `NEXT_PUBLIC_` variables: SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY *allowed*; SUPABASE_ANON_KEY *deprecated*; OPENAI_API_KEY and STRIPE_SECRET_KEY *forbidden (critical)*; DEMO_MODE *forbidden (high)*; POSTHOG_KEY and GA_MEASUREMENT_ID *review*. No email. |
| 2 | Run **scan** | One email within a minute: **8 new critical issues** (list below). |
| 3 | Run **scan** again | Log says `0/1 repos ... scanned`, no email. |
| 4 | Run **digest** | One email: all **14 open issues** (8 critical, 3 high, 1 low, 2 to be validated). |
| 5 | Fix one: on `feature/payments`, change `NEXT_PUBLIC_STRIPE_SECRET_KEY` to `STRIPE_SECRET_KEY` in `lib/stripe.ts`, push, run **scan** | No email (fixes are not alerted immediately). |
| 6 | Run **digest** | 13 open issues, and "Fixed since the last digest: NEXT_PUBLIC_STRIPE_SECRET_KEY". |
| 7 | New problem: create a branch, add `const k = process.env.NEXT_PUBLIC_ANTHROPIC_KEY;` to any `.ts` file, push, run **scan** | One email with **only** that new critical issue. |

**The 8 critical issues of scenario 2**

| Issue | Where |
|---|---|
| `NEXT_PUBLIC_OPENAI_API_KEY` exposed in the browser | feature/ai-chat: `.env`, `components/chat.tsx` |
| `.env` file committed | feature/ai-chat |
| `NEXT_PUBLIC_STRIPE_SECRET_KEY` exposed in the browser | feature/payments: `lib/stripe.ts` |
| `.env.local` still in git history | main history |
| gitleaks: OpenAI key | `.env` (feature/ai-chat) |
| gitleaks: Anthropic key | `lib/summarize.ts` (feature/payments) |
| gitleaks: GitHub token | `.env.local` (history) |
| gitleaks: generic API key (the fake Supabase secret) | `.env.local` (history) |

**High (3):** `.gitignore` does not exclude `.env` (3 branches), `next.config.mjs` `env` key (3 branches),
`NEXT_PUBLIC_DEMO_MODE`. **Low (1):** legacy `NEXT_PUBLIC_SUPABASE_ANON_KEY`.
**To be validated (2):** `NEXT_PUBLIC_POSTHOG_KEY`, `NEXT_PUBLIC_GA_MEASUREMENT_ID`.
`feature/clean` must not add any issue.

If no email arrives, open the run's log: `cannot sign in to Gmail API ... invalid_grant` means the sign-in
was cancelled (password change, access removed) or the token was pasted wrongly: redo step 4b;
`no sender configured` or `GMAIL_CLIENT_ID ... missing` means a secret or variable name is wrong.
Nothing is marked as sent in either case, so the next run retries.

Check in every email: it starts with "[Pilot mode: this email was meant for ...]", "Why you" says
`.github/CODEOWNERS`, and **no key value appears anywhere**.

## 7. Move to the organisation

1. Delete the test token (Settings > Developer settings) and the variable `REPOS` and the secret `SCAN_TOKEN`.
2. Move the agent's repo into the organisation (Settings > Transfer) or push it to a new private org repo.
3. An org admin creates the GitHub App (Contents: read, Metadata: read), installs it on all repositories,
   and you set `SCAN_APP_CLIENT_ID` (variable) and `SCAN_APP_PRIVATE_KEY` (secret).
4. Move secrets into an environment `security-scan` restricted to `main`; protect `main`.
5. Keep support@ as the sender (move the `GMAIL_*` values into the `security-scan` environment), set
   `ALLOWED_EMAIL_DOMAINS` and `FALLBACK_EMAIL`.
6. Run **inventory**, review the list with Khushi, update the allowlist.
7. Keep `REDIRECT_EMAILS_TO` for a few days with all repos, then remove it and set `ENABLE_SCHEDULE=true`.
