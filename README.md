# AITM security agent (Phase 1 prototype)

Scans every branch of every repository in the company's GitHub organisation for exposed secrets,
and emails the repository's tech lead. It runs on GitHub Actions and only reads the repositories.
(GitLab support is built in, behind `SOURCE=gitlab`, for a later phase.)

It never runs a scanned repository's code (no install, build or test), and never puts a secret value
in an email, a log or its saved state. Rules come from the `ai-to-market-security` skill.

## What Phase 1 checks

| Check | Where | Severity |
|---|---|---|
| `NEXT_PUBLIC_*` variables against [`config/public-env-allowlist.json`](config/public-env-allowlist.json) | every branch | critical / high by name pattern, low if deprecated, "to be validated" if unknown |
| `NEXT_PUBLIC_*` values in committed `.env` files that look like secrets (`sk-`, `sb_secret_`, service_role JWT...) | every branch | critical |
| `.env` files committed | every branch | critical |
| `.env` files deleted but still in history | full history | critical |
| Root `.gitignore` does not exclude `.env*` | every branch | high |
| `next.config` `env` key (copies values into the browser) | every branch | high |
| Secrets anywhere in history (gitleaks, default rules) | full history | critical |

The same issue on several branches is a single alert that lists the branches. Archived repos and
forks are skipped, and so is the agent's own repository (its tests plant fake issues on purpose).

## Who gets the email

For each repository, the first source that gives an answer wins:

1. `CODEOWNERS` on the default branch (`CODEOWNERS`, `.github/`, `docs/`). Write emails directly
   (`* firstname.lastname@company`) or `@username`. `@org/team` entries are not expanded yet.
2. People given **admin** or **maintain** rights directly on the repository (team access is not expanded yet).
3. The most active committer of the last 90 days. The email asks them to add a `CODEOWNERS` file.
4. `FALLBACK_EMAIL`, if set.

GitHub usernames become work emails through, in order: the public profile email,
[`config/user-emails.json`](config/user-emails.json) (username → work email), then the email in their commits.
Commits made with a private GitHub email (`…@users.noreply.github.com`) need the `user-emails.json` entry.

**The simplest setup is a one-line `CODEOWNERS` file with an email in each repo.**

## When emails are sent

| Run | Schedule | Emails |
|---|---|---|
| scan | hourly | new **critical** findings, immediately |
| full | nightly | same as scan, but rescans every branch (picks up allowlist changes) |
| digest | Monday 07:00 UTC | every open finding per owner, plus what was fixed |
| inventory | manual | none: lists every `NEXT_PUBLIC_` name in use (in the job summary), to build the allowlist |

## Testing

Step-by-step test on a personal GitHub account, with a sample repo full of planted issues: [docs/TESTING.md](docs/TESTING.md).

## Try it locally

```sh
npm ci --ignore-scripts
npm test                                    # unit + end-to-end tests on a generated repo
node test/make-fixture.mjs ./tmp-fixture    # repo with planted issues on 3 branches
node src/index.mjs --local ./tmp-fixture --dry-run --state ./tmp-state.json
# emails are written to out/emails/ instead of being sent
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
   owned by the organisation, stored as the secret `GITHUB_SCAN_TOKEN`. The App is preferred: it does not
   belong to a person and its tokens last one hour.

3. **Email account.** The company `support@` account (a real Workspace user, not a group) with
   2-Step Verification on, then an App Password for it. The normal password does not work. Alerts show
   up in support@'s Sent folder; `MAIL_REPLY_TO` sends replies elsewhere.

4. **GitHub environment.** In the agent's repo: Settings > Environments > New `security-scan`,
   deployment branches: `main` only. Add to it:

   | Name | Type | Value |
   |---|---|---|
   | `SCAN_APP_CLIENT_ID` | variable | the App's Client ID |
   | `SCAN_APP_PRIVATE_KEY` | secret | the App's private key |
   | `SMTP_PASS` | secret | App Password |
   | `SMTP_USER` | variable | `support@aitomarketgroup.com` |
   | `MAIL_FROM` | variable | `AITM Security Agent <support@aitomarketgroup.com>` |
   | `MAIL_REPLY_TO` | variable | optional: where replies go, instead of the support inbox |
   | `ALLOWED_EMAIL_DOMAINS` | variable | company domain(s): alerts never go to personal addresses |
   | `FALLBACK_EMAIL` | variable | who gets alerts for repos without an owner |
   | `REDIRECT_EMAILS_TO` | variable | pilot: every email goes to this address, with the intended recipient noted |
   | `SEND_EMAILS` | variable | `true` to send; anything else is a dry run |
   | `REPOS` | variable | optional: comma-separated repos to limit the scan (pilot) |
   | `EXCLUDE_REPOS` | variable | optional: repos never to scan |
   | `SCAN_GITHUB_OWNER` | variable | optional: organisation or account to scan, defaults to the owner of the agent's repo |
   | `ENABLE_SCHEDULE` | variable | `true` turns on the hourly/nightly/weekly runs (otherwise manual runs only) |

5. **Roll out in steps.**
   1. Run *inventory* by hand (Actions > security-scan > Run workflow), review the `NEXT_PUBLIC_` list
      with Khushi and the tech leads, update the allowlist by pull request.
   2. Pilot: `REPOS` = a test repo with planted issues, `REDIRECT_EMAILS_TO` = you, `SEND_EMAILS=true`.
   3. Remove `REPOS` (all repos), keep the redirect for a few days to check the noise.
   4. Remove `REDIRECT_EMAILS_TO`: owners get their alerts.

## How it works

```
GitHub API: org repos + branch tips
   │ only repos whose branch tips changed since the last run
   ▼
bare clone/fetch (token passed through git's env config, never in the URL)
   │
   ├─ per changed branch: git grep / ls-tree / cat-file on the tip commit  (src/checks/branch.mjs)
   └─ per repo: .env files in history + gitleaks over all commits           (src/checks/history.mjs)
   ▼
findings with fingerprints, saved between runs in the Actions cache          (src/state.mjs)
   ▼
owner lookup (src/owners.mjs) → one email per person (src/notify.mjs)
```

Repository sources live in `src/sources/` (`github.mjs`, `gitlab.mjs`), selected with `SOURCE`.

The saved state lives in the GitHub Actions cache. If it is lost (unused for 7 days, or evicted), the
next run rescans everything and re-sends the critical alerts once. Job logs only show counts, because
they are visible to anyone with access to this repository.

## Known limits of the prototype

- `@org/team` in `CODEOWNERS` and team-based repo access are not expanded to people.
- Only the root `.gitignore` is checked (monorepos with per-app `.gitignore` may get a false alert).
- `NEXT_PUBLIC_` values are only checked when committed; values stored in Vercel are not checked.
- Hourly polling of the GitHub API, no webhook (yet).
