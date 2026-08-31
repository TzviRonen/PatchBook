# PatchBook — Development Notes

## Two renderers, one content source

PatchBook uses **Jekyll** as its production site generator (for GitHub Pages) but a separate **Flask server** (`serve.py`) for local preview. This is intentional:

- **Jekyll** is GitHub Pages' native build system. Pushing to `main` triggers an automatic build and deploy with no CI/CD configuration needed — that's why it was chosen over Hugo or a custom generator.
- **Flask/serve.py** exists because this project's dev environment doesn't have Ruby, so `bundle exec jekyll serve` isn't available locally.

The two renderers read the same `_posts/*.md` files and apply the same CSS (`assets/main.css`), so local preview is visually equivalent to production.

## Local preview

The whole stack — vote Worker plus site, wired together — in one command:

```bash
./scripts/start_dev.sh            # Flask preview  → :4123, vote API → :3003
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

## Adding posts

Use the publish script from the parent repo:

```bash
python publish_to_patchbook.py              # all posts from data/blogs/
python publish_to_patchbook.py CVE-2024-30088   # one CVE
python publish_to_patchbook.py --commit         # also git commit here
```

Posts land in `_posts/YYYY-MM-DD-cve-XXXX-slug.md` with Jekyll-compatible YAML frontmatter.

## Frontmatter fields

| Field | Required | Notes |
|-------|----------|-------|
| `layout` | yes | always `post` |
| `title` | yes | shown in card and `<title>` |
| `date` | yes | `YYYY-MM-DD`, controls sort order |
| `cve_id` | no | shown as blue badge |
| `cvss` | no | color-coded badge (red ≥9, orange ≥7, yellow ≥4) |
| `excerpt` | no | shown on homepage card |
| `editors` | no | "Edited by" credits; added by PR authors themselves, never generated |

Votes are **not** frontmatter — they live in the database behind `worker/`. See
`ARCHITECTURE.md`.

## Tests

```bash
node worker/test.mjs        # vote API: auth, one-vote-per-user, input validation
                            # no dependencies, no network

python3 serve.py 4123 &     # front-end: counts, voter popover, optimistic updates
npm install jsdom           # point _config.yml's votes_api at http://127.0.0.1:4787 first
node test/ui.test.mjs
```

## Vote backend

`worker/` holds the Cloudflare Worker and D1 schema — deploy steps are in
`worker/README.md`. `_config.yml`'s `votes_api` points the site at it; blank
disables the vote UI, which is what you want if you're running the preview
server without a Worker.
