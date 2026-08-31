# patchbook-votes

The vote backend for PatchBook. Cloudflare Worker + D1, no dependencies.

Content stays in git and only changes through merged pull requests. Votes live
here because they need to be instant, capped at one per GitHub account, and
attributable by name — see `../ARCHITECTURE.md`.

Local development needs none of this — see the bottom of this file. The steps
below are only for putting it live, and each one needs your accounts.

## Deploy

```bash
npm install            # wrangler is a devDependency
npx wrangler login

# 1. Database
npx wrangler d1 create patchbook              # copy the id into wrangler.toml
npx wrangler d1 execute patchbook --remote --file=schema.sql
npx wrangler d1 execute patchbook --remote --file=seed.sql   # optional: old frontmatter marks

# 2. GitHub OAuth app  (github.com/settings/developers → New OAuth App)
#    Homepage URL:               https://tzvironen.github.io/patchbook
#    Authorization callback URL: https://patchbook-votes.tzvironen.workers.dev/auth/callback
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET
npx wrangler secret put TOKEN_SECRET          # openssl rand -base64 48

# 3. Ship
npx wrangler deploy
```

Then set `votes_api` in `../_config.yml` to the deployed Worker URL
(currently `https://patchbook-votes.tzvironen.workers.dev`).

## Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/api/votes?post=<path>` | optional | counts + voter list (+ your own vote) |
| `POST` | `/api/vote` | required | cast or change a vote |
| `DELETE` | `/api/vote?post=<path>` | required | retract your vote |
| `GET` | `/api/me` | optional | who the current token belongs to |
| `GET` | `/auth/login?return=<url>` | — | start GitHub OAuth |
| `GET` | `/auth/callback` | — | finish OAuth, redirect back with token in the URL fragment |

## Design notes

- **One vote per user** is a database constraint, not application logic:
  `PRIMARY KEY (post_id, user_id)` plus an UPSERT. A second vote replaces the
  first; it can never double-count.
- **`user_id`, not `login`, is the identity.** GitHub usernames can be changed
  and reused; the numeric id can't. `login` is refreshed on every vote so
  displayed names stay current.
- **The session token is not a cookie.** The Worker is a different origin from
  `github.io`, and browsers block third-party cookies. It's an HMAC-signed blob
  returned in the URL *fragment* (which never reaches a server or a `Referer`
  header) and held in `localStorage`.
- **No OAuth scopes are requested**, so the consent screen grants nothing
  beyond public identity, and GitHub's access token is discarded immediately
  after the identity lookup — it's never stored.
- **`return` URLs are checked against `ALLOWED_ORIGINS`.** Skipping that would
  make `/auth/login` an open redirect that leaks session tokens.
- **All responses are `Cache-Control: no-store`** — stale counts would defeat
  the point.

## Local development

Runs entirely offline — no Cloudflare account, no login, no deploy. The local D1
is a real SQLite database under `.wrangler/`, and `wrangler dev` runs the same
`workerd` runtime Cloudflare runs in production.

```bash
npm install
cp .dev.vars.example .dev.vars
npm run db:local        # apply schema.sql to the local D1
npm run dev             # → http://127.0.0.1:3003
```

**Use `--env dev`.** The preview server's `http://127.0.0.1:…` origin is only in
the `[env.dev]` allowlist, deliberately — production accepts redirects to
`https://tzvironen.github.io` and nothing else, and `test.mjs` fails the build if
a localhost or wildcard origin ever appears in the production vars.

`npm run dev` serves on `http://127.0.0.1:3003`; point `votes_api` at it and
run the site with `../serve.sh`. You'll need a second OAuth app whose callback
URL is the local Worker, since GitHub matches the callback host exactly.

Front-end behaviour (counts, popover, optimistic updates) can be tested without
any of this — see `../test/ui.test.mjs`, which stubs the API entirely.
