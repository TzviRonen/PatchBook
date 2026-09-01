# PatchBook Architecture

How PatchBook serves a static site **and** takes reader feedback on
AI-generated analyses, using GitHub Pages, GitHub pull requests, and one small
Cloudflare Worker.

## The split

Reader feedback comes in two shapes with opposite requirements, so they use two
different backends:

| | Votes (`valid` / `AI-slop`) | Edit suggestions |
|---|---|---|
| **Wants to be** | instant, one per person, attributable | reviewed before it lands |
| **Backend** | Cloudflare Worker + D1 (`worker/`) | GitHub pull requests |
| **Visible** | immediately, on click | only after the PR is merged |
| **Stored in** | the vote database — never the repo | the report's git history |
| **Identity** | GitHub OAuth (login required) | the PR author's GitHub account |

Votes are read/write-hot state that has to be correct per-account, which git
can't express. Report content is versioned prose with a review gate, which is
exactly what git is for. Storing votes in frontmatter instead would mean a
commit and a site rebuild per vote — a minutes-long delay before a count moves,
and no way to stop one person voting twice.

```
                    ┌────────────── votes: instant ──────────────┐
                    │                                            │
Reader ──click──►  Cloudflare Worker  ──►  D1 (SQLite)
       ◄── JSON ──  /api/votes             PRIMARY KEY (report_id, user_id)
       │                                   └─ one vote per GitHub account
       └── GitHub OAuth ──► identity (login required to vote)


Reader ──"Edit on GitHub"──► fork ──► pull request ──► maintainer merges
                                                            │
                                            push to main ───┘
                                                            ▼
                                            pages.yml: jekyll build → Pages
                                            (the edit becomes visible here)
```

## Votes

Everything lives in `worker/` — see `worker/README.md` for deploy steps and the
endpoint table.

- **One vote per user is a database constraint**, not application logic:
  `PRIMARY KEY (report_id, user_id)` plus an UPSERT. Voting again *changes* your
  verdict; it can never double-count. Clicking your current verdict retracts it.
- **Immediacy** comes from two things: the count is fetched client-side on page
  load (`Cache-Control: no-store`, so Pages' static caching is irrelevant), and
  the click updates the number optimistically before the request returns,
  reconciling with the server response when it lands.
- **The voter list is fetched with the counts** in the same response, and
  rendered *only* into the popover anchored to the count — never into the
  article. It's reachable by hover, keyboard focus, and tap.
- **Identity is GitHub OAuth**, requested with no scopes: the consent screen
  grants nothing beyond public identity, and GitHub's access token is discarded
  right after the identity lookup. What we keep is our own HMAC-signed session
  token, returned in the URL *fragment* and held in `localStorage` — not a
  cookie, because the Worker is a different origin from `github.io` and browsers
  block third-party cookies.
- **Votes are not in git.** The deliberate trade: the repo is not the single
  source of truth, in exchange for votes that are instant and countable. The
  database is the record; back it up with `wrangler d1 export`.
- **Degrading is quiet.** If the Worker is unreachable the report still renders
  normally; only the counts fail, with a status message. A click retries once
  before giving up, so one flaky request can't lock a reader out of voting.

## Edit suggestions

Entirely GitHub's:

1. "Edit on GitHub" opens the web editor at the report's source file. For readers
   without write access GitHub forks the repo and opens a pull request on save.
2. `.github/pull_request_template.md` asks the author to add themselves to the
   report's `editors:` frontmatter **in the same PR**.
3. You review and merge. The push to `main` triggers `pages.yml`, Jekyll
   rebuilds, and both the edit and the new credit go live together.

There is no automation anywhere in this path — no bot writes report content and no
bot writes credits. The "Edited by" list at the bottom of a report is exactly the
`editors:` block that a human wrote and a human merged, which is why it can be
trusted at face value.

`publish_to_patchbook.py` carries the `editors:` block forward when the pipeline
republishes a report (`_existing_block`), so re-running the pipeline over a CVE
never wipes contributor credits.

## Testing the parts that hide

Two pieces of this design are structurally hard to test, and both were broken at
some point *because* they were hard to test:

- **The OAuth callback** cannot be reached without a human at a GitHub consent
  screen. `GITHUB_AUTH_BASE` / `GITHUB_API_BASE` make the two GitHub endpoints
  injectable so `worker/test_oauth.mjs` can drive the entire round trip against a
  double — login, consent, callback, code exchange, identity lookup, session,
  and a vote recorded under that identity. The overrides are readable only from
  deployment config, never from a request; production sets neither, and
  `worker/test.mjs` fails if either appears in `wrangler.toml` or if the
  defaults stop pointing at real GitHub.
- **The origin allowlist** is the one setting standing between `/auth/login` and
  an open redirect that leaks session tokens, so `worker/test.mjs` pins it:
  production must be a single HTTPS origin, with no wildcard and no localhost.

Everything else is covered by `worker/test.mjs` (the API) and `test/ui.test.mjs`
(the front end, against a stub). See `DEVELOPMENT.md`.

## Where each piece lives

- `worker/src/index.js` — vote API and OAuth. Runs on Cloudflare, not GitHub.
- `worker/schema.sql` — the vote table and its one-vote-per-user key.
- `worker/test.mjs`, `worker/test_oauth.mjs`, `test/ui.test.mjs` — the three
  suites; none are deployed or published.
- `scripts/start_dev.sh` — brings the Worker and site up together for local work.
- `assets/patchbook.js` — fetches/renders counts and the voter popover, casts
  votes, and builds the GitHub web-editor / suggestion-issue URLs.
- `_layouts/report.html` — the vote bar, the popover markup, and the "Edited by"
  section rendered from `editors:` frontmatter.
- `_config.yml` — `votes_api` (Worker URL; blank disables the vote UI) and
  `github_repo` / `github_branch` (feeds the edit links).
- `.github/workflows/pages.yml` — Jekyll build + Pages deploy on push to `main`.
- `.github/pull_request_template.md` — tells PR authors to credit themselves.

## Security model

- **Vote endpoints treat everything as hostile.** Report ids are matched against
  a strict `_reports/*.md` regex, verdicts against an allowlist, notes are
  whitespace-collapsed and length-capped, and all writes are parameter-bound.
- **`user_id`, not `login`, is the identity.** GitHub usernames can be changed
  and reused; the numeric id can't. `login` is refreshed on every vote so
  displayed names stay current.
- **`return` URLs are validated against `ALLOWED_ORIGINS`.** Without that,
  `/auth/login` would be an open redirect leaking session tokens — the single
  most security-sensitive line in the Worker. Production allows exactly one
  origin; the preview server's localhost origin lives in `[env.dev]` and is
  never deployed. `worker/test.mjs` fails if a wildcard, a localhost, or a
  non-HTTPS origin appears in the production vars. The OAuth `state` parameter
  is HMAC-signed and expires in 10 minutes.
- **The OAuth app requests no scopes and holds no repo access.** A leaked
  client secret cannot read or write this repo, cannot read a reader's private
  data, and cannot mint a token with permissions the app never registered. Report
  content changes through exactly one path: a pull request a human merges.
- **Blast radius of a `TOKEN_SECRET` leak is vote fraud only** — forged sessions
  can cast votes and nothing else. Recovery is rotating the secret, which
  invalidates every session at once. GitHub's own access token is discarded
  immediately after the identity lookup, so there is nothing else to steal.
- **CORS is origin-allowlisted**, not `*`. Production lists exactly one origin;
  the preview server's `localhost` and `127.0.0.1` origins live in `[env.dev]`
  and are never deployed.
- **The sign-in failure page reflects URL parameters**, since anyone can link a
  victim to `/auth/callback?error=…`. It is served `text/plain` with `nosniff`
  and `X-Frame-Options: DENY`, and reflected values are stripped of control
  characters and length-capped, so the output can neither become markup nor
  forge lines that read as our own.
- **No long-lived GitHub credentials exist.** The Worker holds an OAuth client
  secret and a token-signing secret; Pages deployment uses the built-in
  `GITHUB_TOKEN`. Nothing has write access to the repo except you merging PRs.

## ⚠️ Gotcha: bot pushes don't trigger workflows

Worth knowing before adding any automation that commits to this repo.
GitHub suppresses workflow runs for events created with the default
`GITHUB_TOKEN` (recursion prevention), so a bot's `git push` does *not* fire
`pages.yml`'s `on: push`. The documented escape hatches are `workflow_dispatch`
and `repository_dispatch` — which is why `pages.yml` still declares
`workflow_dispatch:`. Human-merged PRs are unaffected.
