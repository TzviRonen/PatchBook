# PatchBook Architecture — serverless community validation

How PatchBook serves a static site **and** processes reader-submitted validations
with no backend server, using only free GitHub services.

## The core idea

GitHub doesn't have a single service that both hosts static files and runs code —
but combining two of its services gives you exactly that:

| Service | Role | Runs code? | Cost |
|---|---|---|---|
| **GitHub Pages** | Hosts the built site (`_site/`) | No — serves static files only | Free (public repos) |
| **GitHub Actions** | Reacts to events (issues, pushes) on throwaway Ubuntu VMs | Yes — Python, Ruby, anything | Free (public repos, generous quota) |

Pages never executes anything at request time. All computation happens
*event-time* on Actions runners, and the result is committed back to the repo,
rebuilt, and redeployed as new static files.

## Data flow: what happens when a reader clicks "Validate"

```
Reader clicks "Validate" on a post
        │  (assets/patchbook.js — pure client-side, no POST)
        ▼
Prefilled GitHub issue opens, labelled `validation`,
body contains a ```yaml block: {type, post, verdict, note}
        │  (reader submits the issue with their GitHub account)
        ▼
.github/workflows/validations.yml triggers on the issue event
        │  GitHub boots a fresh ubuntu-latest VM:
        │    1. actions/checkout clones the repo
        │    2. actions/setup-python installs Python 3.11
        │    3. python scripts/apply_validation.py parses & sanitizes the
        │       issue body (hostile input!) and appends the mark to the
        │       post's `validations:` frontmatter
        │    4. commits & pushes to main, comments on + closes the issue
        │    5. VM is destroyed
        ▼
.github/workflows/pages.yml rebuilds the site
        │  Another throwaway VM: `jekyll build` → upload `_site`
        │  → actions/deploy-pages publishes it
        ▼
Pages serves the new snapshot: the "N valid" badge count and the
marks list update (both rendered by _layouts/post.html from frontmatter)
```

The static host never "pulls" the repo — it receives a freshly built snapshot
after every push. Latency is ~1–2 minutes per validation (Actions run +
rebuild), which is the trade-off for having no server at all.

### Where each piece lives

- `_layouts/post.html` — renders the tally badges and marks from each post's
  `validations:` frontmatter (Liquid `where` filters).
- `assets/patchbook.js` — builds the prefilled issue URLs. Client-side only.
- `scripts/apply_validation.py` — the "handler". Runs **only on Actions
  runners** (or locally for testing) — never on the web host. Treats the issue
  body as hostile: verdict allowlist, path-traversal guard, control-char
  sanitizing, YAML escaping.
- `.github/workflows/validations.yml` — issue → frontmatter-commit bot.
- `.github/workflows/pages.yml` — Jekyll build + Pages deploy.
- `validations:` frontmatter in `_posts/*.md` — the "database". No external
  storage; marks live in git and survive republishing
  (`publish_to_patchbook.py` carries the block forward).

## Setup from scratch

To reproduce this on a new repo:

1. **Public GitHub repo** containing the Jekyll site (public keeps Pages and
   Actions free, and lets anyone open validation issues).
2. **Enable Pages via Actions**: repo → Settings → Pages → Source =
   **GitHub Actions** (not "deploy from branch").
3. **Add `pages.yml`**: triggers on `push` to `main` **and `workflow_dispatch`**
   (the dispatch trigger is load-bearing — see the gotcha below); permissions
   `contents: read`, `pages: write`, `id-token: write`; steps: checkout →
   setup-ruby (bundler-cache) → `jekyll build` → upload-pages-artifact →
   deploy-pages.
4. **Create the issue labels** the bot filters on: `validation` (plus
   `suggestion` and `invalid` for the other flows). Labels must exist before
   prefilled issue URLs can apply them.
5. **Add `validations.yml`**: triggers on `issues: [opened, labeled]`, gated on
   the `validation` label; permissions `contents: write`, `issues: write`
   (and `actions: write` for the rebuild dispatch below). Uses only the
   built-in `GITHUB_TOKEN` — no secrets to create or rotate.
6. **Point the client at the repo**: `_config.yml` keys `github_repo` /
   `github_branch` feed `data-repo` / `data-branch` attributes that
   `patchbook.js` uses to build issue URLs.

## ⚠️ Gotcha: bot pushes don't trigger workflows

GitHub **suppresses workflow runs for events created with the default
`GITHUB_TOKEN`** (to prevent infinite workflow recursion). So the validation
bot's `git push` does *not* fire `pages.yml`'s `on: push` — the mark lands in
the repo but the live site stays stale until the next human push.

The documented exceptions are `workflow_dispatch` and `repository_dispatch`.
The fix: after pushing, `validations.yml` explicitly dispatches the Pages
build —

```yaml
# in the commit step, after `git push`:
gh workflow run pages.yml            # needs `actions: write` permission
```

This works because `pages.yml` already declares `workflow_dispatch:` as a
trigger. (The alternative — pushing with a personal access token so the push
event fires normally — works too, but means creating and rotating a secret,
which this design avoids.)

## Security model

- Anyone on the internet can open an issue, so **the issue body is untrusted
  input**. `apply_validation.py` enforces: verdict allowlist
  (`valid` / `ai-slop` / `needs-fixing`), strict `_posts/*.md` path regex +
  resolved-path containment check, control-character stripping, length caps,
  and double-quoted YAML escaping.
- Identity comes from GitHub itself: submitting requires a GitHub login, and
  the issue *author* (from the trusted event payload, not the body) is who the
  mark is attributed to.
- The workflow runs with the scoped `GITHUB_TOKEN` only — no long-lived
  secrets; a malicious issue can at worst be rejected (commented + labelled
  `invalid`).
