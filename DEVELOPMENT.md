# PatchBook — Development Notes

## Two renderers, one content source

PatchBook uses **Jekyll** as its production site generator (for GitHub Pages) but a separate **Flask server** (`serve.py`) for local preview. This is intentional:

- **Jekyll** is GitHub Pages' native build system. Pushing to `main` triggers an automatic build and deploy with no CI/CD configuration needed — that's why it was chosen over Hugo or a custom generator.
- **Flask/serve.py** exists because this project's dev environment doesn't have Ruby, so `bundle exec jekyll serve` isn't available locally.

The two renderers read the same `_reports/*.md` files and apply the same CSS (`assets/main.css`), so local preview is visually equivalent to production.

## Local preview

The whole stack — vote Worker plus site, wired together — in one command:

```bash
./scripts/start_dev.sh            # Flask preview  → :3004, vote API → :3003
./scripts/start_dev.sh --jekyll   # the real production renderer instead
```

It points `votes_api` at the local Worker while running and **restores it on
exit**, which matters: committing a localhost `votes_api` would silently break
votes in production.

Site only, no vote backend:

```bash
python patchbook/serve.py 4000    # or, from the parent root:
./scripts/start_patchbook.sh      # picks a free port from $CONTAINER_PORTS
```

## Production deploy (GitHub Pages)

1. Push to the `main` branch of the `patchbook` repo
2. GitHub Actions (`.github/workflows/pages.yml`) builds with Jekyll and deploys to `gh-pages`
3. Enable GitHub Pages in repo Settings → Pages → Source: **GitHub Actions**

## Adding reports

Use the publish script from the parent repo:

```bash
python publish_to_patchbook.py              # all reports from data/blogs/
python publish_to_patchbook.py CVE-2024-30088   # one CVE
python publish_to_patchbook.py --commit         # also git commit here
```

Reports land in `_reports/YYYY-MM-DD-cve-XXXX-slug.md` with Jekyll-compatible YAML frontmatter.

## Frontmatter fields

| Field | Required | Notes |
|-------|----------|-------|
| `layout` | yes | always `report` |
| `title` | yes | shown in card and `<title>` |
| `date` | yes | `YYYY-MM-DD`, controls sort order |
| `cve_id` | no | shown as blue badge |
| `cvss` | no | color-coded badge (red ≥9, orange ≥7, yellow ≥4) |
| `excerpt` | no | shown on homepage card |
| `editors` | no | "Edited by" credits; added by PR authors themselves, never generated |

Votes are **not** frontmatter — they live in the database behind `worker/`. See
`ARCHITECTURE.md`.

## Tests

Three suites. The first two need nothing installed and no network:

```bash
node worker/test.mjs         # 23 — auth, one-vote-per-user, input validation,
                             #      and the production origin allowlist
node worker/test_oauth.mjs   # 25 — the whole OAuth round trip against a
                             #      GitHub double: login → consent → callback →
                             #      code exchange → identity → session → vote

python3 serve.py 3004 &      # 27 — counts, voter popover, optimistic updates,
npm install jsdom            #      offline recovery. Rewrites the page's
node test/ui.test.mjs        #      data-api to its own stub, so it does not
                             #      care what votes_api is set to.
```

`test_oauth.mjs` exists because `handleCallback` is otherwise unreachable
without a human at a consent screen — which is exactly how it stayed broken for
a while. It works by pointing `GITHUB_AUTH_BASE` / `GITHUB_API_BASE` at a local
double; those are deployment-config-only overrides, and `test.mjs` fails if
either ever appears in `wrangler.toml`.

## Vote backend

`worker/` holds the Cloudflare Worker and D1 schema — deploy steps are in
`worker/README.md`. `_config.yml`'s `votes_api` points the site at it; blank
disables the vote UI, which is what you want if you're running the preview
server without a Worker.

Production is deployed at `https://patchbook-votes.tzvironen.workers.dev`.

### A dev OAuth app

Signing in locally needs its own GitHub OAuth app, because GitHub matches the
callback host and port exactly and your production app points at the deployed
Worker. Register a second one:

| Field | Value |
|---|---|
| Authorization callback URL | `http://127.0.0.1:3003/auth/callback` |
| Homepage URL | anything — cosmetic, never redirected to |

Put its id and secret in `worker/.dev.vars` (gitignored). `start_dev.sh` prints
the exact callback URL on every run, since a mismatch is invisible until after
you have already signed in.

To test *voting* without testing *login*, skip all of that: mint a session token
with the HMAC scheme in `worker/src/index.js` and set it as `localStorage`
`pb_token`. That is what the suites do.

## Troubleshooting

Every one of these cost real time at least once.

**Votes don't load, or clicking a vote does nothing.** Open the browser console
— `patchbook.js` logs the API URL and the page's origin on failure. `fetch`
cannot distinguish a dead host from a CORS rejection, so the message names both.

**The API answers `curl` but not the browser.** In this repo's container,
`container.sh` publishes ports with `docker run -p`, which cannot reach a
service bound to loopback *inside* the container. `wrangler dev` binds
`127.0.0.1` by default, so it must be started with `--ip 0.0.0.0` —
`start_dev.sh` does, and warns if the socket came up loopback-only. `curl` from
inside the container succeeds either way, which is what makes this so
confusing.

**`localhost` and `127.0.0.1` are different origins** to a browser, and the
preview servers advertise both. Both forms are in `[env.dev].ALLOWED_ORIGINS`
for this reason. Listing only one means counts fail and login returns 400
depending purely on which URL you typed.

**Sign-in fails after the GitHub consent screen.** The Worker prints the reason,
including the exact `redirect_uri` it sent. Almost always the OAuth app's
registered callback URL.

**`no such column: report_id`.** The database predates the `post_id` → `report_id`
rename and `schema.sql` cannot alter an existing table. Apply
`worker/migrations/0001-post-id-to-report-id.sql`.

**`no such table: votes` locally.** The local D1 is keyed by `database_id`, so
editing `wrangler.toml` orphans it. `npm run db:local` recreates it; it is
idempotent and `start_dev.sh` runs it on every start.

**Every request 500s after a fresh `wrangler d1 create`.** That command suggests
`binding = "patchbook"`, named after the database. The code reads `env.DB`, so
the binding must be `DB` — `database_name` is the part that names the database.
