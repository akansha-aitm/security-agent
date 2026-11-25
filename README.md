# AITM security agent (prototype)

Scans the `dev/` branches of every repository in the company's GitHub organisation for exposed secrets and
unprotected API endpoints, and emails the tech leads. It runs on GitHub Actions and only reads the repositories.
(GitLab support is built in, behind `SOURCE=gitlab`, for a later phase.)

It never runs a scanned repository's code (no install, build or test), and never puts a secret value
in an email, a log or its saved state. Rules come from the `ai-to-market-security` skill.

## What it checks

| Check | Where | Severity |
|---|---|---|
| `NEXT_PUBLIC_*` variables against [`config/public-env-allowlist.json`](config/public-env-allowlist.json) | every `dev/` branch | critical / high by name pattern, low if deprecated, "to be validated" if unknown |
| `NEXT_PUBLIC_*` values in committed `.env` files that look like secrets (`sk-`, `sb_secret_`, service_role JWT...) | every `dev/` branch | critical |
| `.env` files committed | every `dev/` branch | critical |
| `.env` files deleted but still in history | history of the `dev/` branches | critical |
| Root `.gitignore` does not exclude `.env*` | every `dev/` branch | high |
| `next.config` `env` key (copies values into the browser) | every `dev/` branch | high |
| Secrets anywhere in history (gitleaks, default rules) | history of the `dev/` branches | critical |
| API endpoints: login checks and rules per kind (below) | every `dev/` branch | critical to medium |

### API endpoint checks

Every endpoint is found and sorted by what it calls, reading the route and the local code it uses:

- **JavaScript** (from the file layout): `app/**/route.ts`, `pages/api/**`, `"use server"` files, `supabase/functions/*`.
- **Python** (from the code, in `.py` files outside `tests/`): Flask, Quart and Sanic (`@app.route`, `@bp.get`,
  `add_url_rule`), FastAPI and Starlette (`@router.post`, `add_api_route`, `Route`), aiohttp
  (`@routes.get`, `app.router.add_post`) and Azure Functions (`@app.route(route=...)`). As for JavaScript, the
  agent reads the handler, the same-file code it uses and the local modules it imports (two levels).

Categories:
**LLM** (AI libraries or AI hosts), **third-party** (Stripe, SerpApi, Resend... or any outside URL),
**container** (our own services: URLs from settings like `WORKER_URL`), or **other**.
Rules live in [`config/endpoints.json`](config/endpoints.json): approved public routes, login-helper
names, URL settings, with per-repo additions.

| Kind | Checks |
|---|---|
| all | login check on the endpoint, unless approved public (critical if it calls an LLM or uses the Supabase secret key); user id/role taken from the request; user-supplied URL fetched (SSRF); keys in logs; GET that changes data |
| cron / webhook | `CRON_SECRET` check / signature verification instead of a login |
| LLM | rate limit; model, system prompt or settings taken from the request; input size limit; `maxDuration`; no GET |
| third-party / container | timeout on outgoing calls |
| container | sends a service credential, never the user's headers |
| Supabase function | `verify_jwt = false` without a login check |
| Python | login decorators, `Depends(...)`/`Security(...)` (FastAPI security schemes included), router `dependencies=`, Flask `before_request`, aiohttp auth middlewares and the Bot Framework adapter (Teams bots) count as a login check; Azure Functions: `auth_level=ANONYMOUS` without a login check (function keys count as a check) |

These read the source text: "no login check found" means a person should look. A project's own login
helper (e.g. `requireUser()`, `check_caller()`) must be added to `authHelpers`, or its routes are reported.
Python endpoints are named with their methods (`POST /api/messages`).

The same issue on several branches is a single alert that lists the branches. Archived repos and
forks are skipped, and so is the agent's own repository (its tests plant fake issues on purpose).

## Which branches

Only branches whose name starts with `dev/` (any capitalisation: `dev/chat-export`, `Dev/Login`) are
scanned. Devs push their work there; `main`, `feature/...` and other branches are ignored. The history
checks cover every commit reachable from the `dev/` branches, which includes the history of `main` they
started from. When a `dev/` branch is deleted (merged), its issues are closed. Change the scope with the
variable `SCAN_BRANCH_PREFIXES` (comma-separated prefixes, `*` = every branch).

## Who gets the email

Every email goes to all the tech leads listed in the variable `ALERT_EMAILS` (one email per run, all
of them in "To"). While testing, `REDIRECT_EMAILS_TO` sends every email to one address instead, with a
note naming the intended recipients.

The email is HTML (with a plain-text copy): coloured counts per severity at the top, then every issue,
critical first, with links to the commit, to the changes since the last scan and to each file and line.

## When emails are sent

| Run | Schedule | Emails |
|---|---|---|
| scan | hourly | every **new** finding (all severities), in one email; nothing when there is nothing new |
| full | nightly | same as scan, but rescans every `dev/` branch (picks up allowlist changes) |
| digest | Monday 07:00 UTC | every open finding, plus what was fixed |
| inventory | manual | none: lists every `NEXT_PUBLIC_` name and every API endpoint with its kind and access (job summary, `out/*.csv` locally), to build the allowlists |

## Testing

Step-by-step test on a personal GitHub account, with a sample repo full of planted issues: [docs/TESTING.md](docs/TESTING.md).

## Try it locally

```sh
npm ci --ignore-scripts
npm test                                    # unit + end-to-end tests on a generated repo
node test/make-fixture.mjs ./tmp-fixture    # repo with planted issues: 2 dev/ branches, 2 ignored
node src/index.mjs --local ./tmp-fixture --dry-run --state ./tmp-state.json
# emails are written to out/emails/ (.txt and .html: open the .html in a browser) instead of being sent
```

gitleaks must be on the PATH (or set `GITLEAKS_BIN`), otherwise the secret scan is skipped with a warning.
Get it from the [gitleaks releases](https://github.com/gitleaks/gitleaks/releases) (v8.30.1 is the pinned version).

To try it on a real repository you already have locally, point `--local` at it (remote-tracking branches
are scanned too, so `git fetch --all` first).

## Setup on GitHub

1. **Create a private repository in the organisation** and push this folder. Protect `main`
   (pull request + review required), because whoever can change `main` controls a job that reads every repo.

2. **Create a GitHub App owned by the organisation** (Organisation settings > Developer settings > GitHub Apps):
   - Webhook: off. Repository permissions: **Contents: read**, **Metadata: read**. Nothing else.
   - Install it on the organisation, on **All repositories**.
   - Note the Client ID and generate a private key.

   Alternative for a quick pilot: a fine-grained personal access token with the same two read permissions,
   owned by the organisation, stored as the secret `SCAN_TOKEN`. The App is preferred: it does not
   belong to a person and its tokens last one hour.

3. **Email account.** Alerts are sent from the company `support@` account through the Gmail API, with a
   send-only Google sign-in (cannot read the mailbox): a Google Cloud project with an internal OAuth app,
   then `npm run gmail-auth` once, signed in as support@. Step by step: [docs/TESTING.md](docs/TESTING.md#4-give-the-agent-permission-to-send-as-support-send-only-google-sign-in).
   Alerts show up in support@'s Sent folder; `MAIL_REPLY_TO` sends replies elsewhere.
   (Gmail SMTP with an App Password still works: set `SMTP_USER` and `SMTP_PASS` instead of the `GMAIL_*` values.)

4. **GitHub environment.** In the agent's repo: Settings > Environments > New `security-scan`,
   deployment branches: `main` only. Add to it:

   | Name | Type | Value |
   |---|---|---|
   | `SCAN_APP_CLIENT_ID` | variable | the App's Client ID |
   | `SCAN_APP_PRIVATE_KEY` | secret | the App's private key |
   | `GMAIL_CLIENT_ID` | variable | printed by `npm run gmail-auth` |
   | `GMAIL_CLIENT_SECRET` | secret | printed by `npm run gmail-auth` |
   | `GMAIL_REFRESH_TOKEN` | secret | printed by `npm run gmail-auth` |
   | `MAIL_FROM` | variable | `AITM Security Agent <support@aitomarketgroup.com>` |
   | `MAIL_REPLY_TO` | variable | optional: where replies go, instead of the support inbox |
   | `ALERT_EMAILS` | variable | the tech leads' emails, comma-separated: every alert goes to all of them |
   | `REDIRECT_EMAILS_TO` | variable | pilot: every email goes to this address, with the intended recipients noted |
   | `SCAN_BRANCH_PREFIXES` | variable | optional: branches in scope, default `dev/` (`*` = all) |
   | `SEND_EMAILS` | variable | `true` to send; anything else is a dry run |
   | `REPOS` | variable | optional: comma-separated repos to limit the scan (pilot) |
   | `EXCLUDE_REPOS` | variable | optional: repos never to scan |
   | `SCAN_GITHUB_OWNER` | variable | optional: organisation or account to scan, defaults to the owner of the agent's repo |
   | `ENABLE_SCHEDULE` | variable | `true` turns on the hourly/nightly/weekly runs (otherwise manual runs only) |

5. **Roll out in steps.**
   1. Run *inventory* by hand (Actions > security-scan > Run workflow), review the `NEXT_PUBLIC_` list and the
      endpoint list with Khushi and the tech leads, update both config files by pull request.
   2. Pilot: `REPOS` = a test repo with planted issues, `REDIRECT_EMAILS_TO` = you, `SEND_EMAILS=true`.
   3. Remove `REPOS` (all repos), keep the redirect for a few days to check the noise.
   4. Set `ALERT_EMAILS` to the tech leads and remove `REDIRECT_EMAILS_TO`.

## How it works

```
GitHub API: org repos + branch tips, keeping only dev/ branches
   │ only repos whose dev/ branch tips changed since the last run
   ▼
bare fetch of the dev/ branches only (token passed through git's env config, never in the URL)
   │
   ├─ per changed branch: git grep / ls-tree / cat-file on the tip commit  (src/checks/branch.mjs,
   │                      API endpoints in src/checks/endpoints.mjs)
   └─ per repo: .env files in history + gitleaks over the dev/ branches' commits (src/checks/history.mjs)
   ▼
findings with fingerprints, saved between runs in the Actions cache          (src/state.mjs)
   ▼
one HTML email to the tech leads (src/notify.mjs, sent by src/mailer.mjs)
```

Repository sources live in `src/sources/` (`github.mjs`, `gitlab.mjs`), selected with `SOURCE`.

The saved state lives in the GitHub Actions cache. If it is lost (unused for 7 days, or evicted), the
next run rescans everything and re-sends the open issues once. Job logs only show counts, because
they are visible to anyone with access to this repository.

## Known limits of the prototype

- Only the root `.gitignore` is checked (monorepos with per-app `.gitignore` may get a false alert).
- `NEXT_PUBLIC_` values are only checked when committed; values stored in Vercel are not checked.
- Hourly polling of the GitHub API: a new issue is found within the hour, not at push time; the "changes"
  link covers everything pushed since the last scan. Scanning on
  every push is planned for later (GitHub App webhook, so no file is needed in each repo).
- Endpoint checks are text heuristics: custom login helpers, wrappers or URLs built at runtime need
  `config/endpoints.json` entries. Whether a container is itself reachable from the internet is not checked
  (cloud setting, outside the repo). Object ownership ("is this the user's own record?") is not checked.
  Django URL confs are not read yet, and a login check added by the hosting platform (Azure App Service
  authentication, an API gateway) is invisible in the code: those endpoints are reported and need a person.
