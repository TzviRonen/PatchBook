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
#    ⚠ that command suggests `binding = "patchbook"`. Keep `binding = "DB"` —
#      the binding is the name the code sees as env.DB, not the database name.
#      Getting this wrong makes every request 500 with Cloudflare error 1101.
#      The id goes in TWO places: [[d1_databases]] and [[env.dev.d1_databases]].
npx wrangler d1 execute patchbook --remote --file=schema.sql

# 2. GitHub OAuth app  (github.com/settings/developers → New OAuth App)
#    Homepage URL:               https://tzvironen.github.io/PatchBook
#    Authorization callback URL: https://patchbook-votes.tzvironen.workers.dev/auth/callback
npx wrangler secret put GITHUB_CLIENT_ID --env=""
npx wrangler secret put GITHUB_CLIENT_SECRET --env=""
openssl rand -base64 48 | npx wrangler secret put TOKEN_SECRET --env=""
#    ^ piping keeps the secret out of your shell history and terminal scrollback

# 3. Ship  (--env="" targets the top-level, i.e. production, environment)
npx wrangler deploy --env=""
```

Then set `votes_api` in `../_config.yml` to the deployed Worker URL
(currently `https://patchbook-votes.tzvironen.workers.dev`).

## Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/api/votes?report=<path>` | optional | counts + voter list (+ your own vote) |
| `POST` | `/api/vote` | required | cast or change a vote |
| `DELETE` | `/api/vote?report=<path>` | required | retract your vote |
| `GET` | `/api/me` | optional | who the current token belongs to |
| `GET` | `/auth/login?return=<url>` | — | start GitHub OAuth |
| `GET` | `/auth/callback` | — | finish OAuth, redirect back with token in the URL fragment |

## Design notes

- **One vote per user** is a database constraint, not application logic:
  `PRIMARY KEY (report_id, user_id)` plus an UPSERT. A second vote replaces the
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
- **Sign-in failures explain themselves.** GitHub returns `{error,
  error_description}` on a failed exchange and redirects to the callback with
  `?error=` when consent is refused. Both are reported, along with the exact
  `redirect_uri` we sent, because a mismatched callback URL is the usual cause
  and is invisible until after consent. Those values are reflected from a URL
  anyone can craft, so the page is `text/plain` + `nosniff` + `DENY`-framed,
  with control characters stripped and length capped.
- **The GitHub base URLs are injectable** (`GITHUB_AUTH_BASE`,
  `GITHUB_API_BASE`) so `test_oauth.mjs` can drive the full round trip against a
  double. They are readable only from deployment config, never from a request;
  production sets neither, and `test.mjs` fails if either appears in
  `wrangler.toml`.

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

Easier still, from the site root: `../scripts/start_dev.sh` brings up this
Worker and the site together and wires `votes_api` between them.

Three things about `npm run dev` are load-bearing, and all three are already in
the script:

- **`--env dev`.** The preview server's `127.0.0.1` / `localhost` origins are
  only in the `[env.dev]` allowlist, deliberately. Production accepts redirects
  to `https://tzvironen.github.io` and nothing else, and `test.mjs` fails if a
  localhost, wildcard, or non-HTTPS origin ever reaches the production vars.
- **`--ip 0.0.0.0`.** `wrangler dev` binds loopback by default, and this repo's
  `container.sh` publishes ports with `docker run -p`, which cannot reach a
  loopback-bound socket inside the container. The site would load while every
  vote failed — and `curl` from inside the container would show the API perfectly
  healthy the whole time.
- **`--local`.** Keeps writes in `.wrangler/`. Without it you would be voting
  against the production database.

A second OAuth app is needed to test sign-in locally, with callback
`http://127.0.0.1:3003/auth/callback` — GitHub matches host and port exactly.
See `../DEVELOPMENT.md`.

## Tests

```bash
npm test              # 23 cases — no dependencies, no network
npm run test:oauth    # 25 cases — full OAuth round trip against a GitHub double
```

Front-end behaviour (counts, popover, optimistic updates, offline recovery) is
covered separately by `../test/ui.test.mjs`, which stubs this API entirely.
