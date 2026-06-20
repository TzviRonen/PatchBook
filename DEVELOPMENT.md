# PatchBook — Development Notes

## Two renderers, one content source

PatchBook uses **Jekyll** as its production site generator (for GitHub Pages) but a separate **Flask server** (`serve.py`) for local preview. This is intentional:

- **Jekyll** is GitHub Pages' native build system. Pushing to `main` triggers an automatic build and deploy with no CI/CD configuration needed — that's why it was chosen over Hugo or a custom generator.
- **Flask/serve.py** exists because this project's dev environment doesn't have Ruby, so `bundle exec jekyll serve` isn't available locally.

The two renderers read the same `_posts/*.md` files and apply the same CSS (`assets/main.css`), so local preview is visually equivalent to production.

## Local preview

```bash
# from the repo root:
./start_patchbook.sh
# → picks a free port from $CONTAINER_PORTS and serves at http://localhost:<port>/
```

Or directly:

```bash
python patchbook/serve.py 4000
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
