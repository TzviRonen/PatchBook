"""Minimal Flask server for PatchBook — serves _posts/*.md as a static blog."""
import re
from pathlib import Path

import markdown as md
from flask import Flask, abort, render_template_string

POSTS_DIR = Path(__file__).parent / "_posts"
CSS = (Path(__file__).parent / "assets" / "main.css").read_text()

app = Flask(__name__)

# ── frontmatter parsing ────────────────────────────────────────────────────────

_FM_RE = re.compile(r"^---\s*\n(.*?)\n---\s*\n", re.DOTALL)
_MD_STRIP_RE = re.compile(r"(\*\*|__|\*|_|`)")  # strip inline markdown from plain-text fields


def _strip_md(text: str) -> str:
    """Remove common inline markdown syntax for use in plain-text contexts."""
    return _MD_STRIP_RE.sub("", text)


def _parse(path: Path) -> dict:
    text = path.read_text(encoding="utf-8")
    fm: dict = {"editors": []}
    m = _FM_RE.match(text)
    if m:
        in_editors = False
        for line in m.group(1).splitlines():
            indented = line[:1] in (" ", "\t")
            if not indented:
                in_editors = line.strip() == "editors:"
                if in_editors:
                    continue
                if ":" in line:
                    k, _, v = line.partition(":")
                    fm[k.strip()] = v.strip().strip('"')
            elif in_editors:
                _parse_editor_line(fm["editors"], line)
        body = text[m.end():]
    else:
        body = text
    fm["_body"] = body
    fm["_slug"] = path.stem
    return fm


def _parse_editor_line(editors: list, line: str) -> None:
    """Accumulate one line of the `editors:` block (see _layouts/post.html).

    Handles both accepted shapes: a bare `- username`, and a mapping starting
    with `- name: username` whose `date` / `note` keys follow on later lines.
    """
    item = line.strip()
    new_entry = item.startswith("-")
    if new_entry:
        item = item[1:].strip()
    if ":" in item:
        k, _, v = item.partition(":")
        if new_entry:
            editors.append({})
        if editors:
            editors[-1][k.strip()] = v.strip().strip('"')
    elif new_entry and item:
        editors.append({"name": item.strip('"')})


def _site_config() -> dict:
    """Read the handful of `_config.yml` keys the post template needs.

    Deliberately a regex over top-level `key: value` lines rather than a YAML
    parse — this preview server has no PyYAML dependency and needs none.
    """
    cfg: dict = {}
    path = Path(__file__).parent / "_config.yml"
    if path.exists():
        for line in path.read_text(encoding="utf-8").splitlines():
            m = re.match(r"^(votes_api|github_repo|github_branch):\s*(.*)$", line)
            if m:
                cfg[m.group(1)] = m.group(2).strip().strip('"')
    return cfg


def _all_posts() -> list[dict]:
    posts = [_parse(p) for p in sorted(POSTS_DIR.glob("*.md"), reverse=True)]
    return posts


def _cvss_class(cvss: str) -> str:
    try:
        v = float(cvss)
        if v >= 9: return "red"
        if v >= 7: return "orange"
        if v >= 4: return "yellow"
    except (ValueError, TypeError):
        pass
    return "muted"


def _render_body(raw: str) -> str:
    """Render markdown body, stripping the leading H1 (shown in post header)."""
    # Remove the first H1 heading to avoid duplicate title
    body = re.sub(r"^#[^#][^\n]*\n", "", raw.lstrip(), count=1)
    return md.markdown(body, extensions=["fenced_code", "tables", "toc", "nl2br"])


# ── base template ──────────────────────────────────────────────────────────────

BASE = """<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{% block title %}Posts{% endblock %} — PatchBook</title>
  <style>{{ css }}</style>
</head>
<body>
<nav>
  <a class="nav-brand" href="/">
    <div class="brand-icon">P</div>
    PatchBook
  </a>
  <div class="nav-links">
    <a href="/"{% if active in ('home', 'post') %} class="active"{% endif %}>Posts</a>
    <a href="/about"{% if active == 'about' %} class="active"{% endif %}>About</a>
  </div>
</nav>
{% block body %}{% endblock %}
<footer>
  <div class="footer-inner">
    <span>PatchBook — Windows kernel CVE analysis</span>
    <span>Powered by <a href="https://github.com/tzvironen/kernel-cve-pipeline">kernel-cve-pipeline</a></span>
  </div>
</footer>
</body>
</html>"""

HOME_TPL = BASE.replace("{% block title %}Posts{% endblock %}", "Posts").replace(
    "{% block body %}{% endblock %}", """
<div class="page">
  <div class="page-header">
    <h1>CVE Analysis Posts</h1>
    <p>Deep-dives into Windows kernel patches — binary diffs, decompilation, and exploitation primitives.</p>
  </div>
  {% if posts %}
  <div class="post-list">
    {% for p in posts %}
    <a class="post-card" href="/posts/{{ p._slug }}">
      <div class="post-card-meta">
        <div class="flex-gap">
          {% if p.cve_id %}<span class="badge blue mono">{{ p.cve_id }}</span>{% endif %}
          {% if p.cvss %}<span class="badge {{ cvss_class(p.cvss) }}">CVSS {{ p.cvss }}</span>{% endif %}
        </div>
        <span class="post-date">{{ p.date }}</span>
      </div>
      <h2 class="post-card-title">{{ p.title }}</h2>
      {% if p.excerpt %}<p class="post-card-excerpt">{{ strip_md(p.excerpt) }}</p>{% endif %}
      <span class="post-card-link">Read full post →</span>
    </a>
    {% endfor %}
  </div>
  {% else %}
  <div class="empty-state"><div class="empty-icon">📭</div><p>No posts yet.</p></div>
  {% endif %}
</div>
""")

POST_TPL = BASE.replace("{% block title %}Posts{% endblock %}", "{{ post.title }}").replace(
    "{% block body %}{% endblock %}", """
<div class="page page-post">
  <div class="post-header">
    <div class="post-header-meta">
      <div class="flex-gap">
        {% if post.cve_id %}<span class="badge blue mono">{{ post.cve_id }}</span>{% endif %}
        {% if post.cvss %}<span class="badge {{ cvss_class(post.cvss) }}">CVSS {{ post.cvss }}</span>{% endif %}
        <span class="muted small">{{ post.date }}</span>
      </div>
      <a href="/" class="btn btn-muted back-link">← All posts</a>
    </div>
    <h1 class="post-title">{{ post.title }}</h1>

    {# Mirrors _layouts/post.html: votes come live from the Worker API, the
       voter list appears only in the popover on the count, and edits go
       through GitHub PRs. #}
    <div class="community community-bar"
         data-post-path="_posts/{{ post._slug }}.md"
         data-cve="{{ post.cve_id or '' }}"
         data-repo="{{ site.github_repo or '' }}"
         data-branch="{{ site.github_branch or 'main' }}"
         data-api="{{ site.votes_api or '' }}">
      <div class="votes" title="Reader fact-check of this AI-generated post">
        <span class="community-tally-label">Community check</span>
        {% for verdict, label, cls, symbol in [
             ('valid', 'Valid', 'green', '✓'),
             ('ai-slop', 'AI-slop', 'red', '✗')] %}
        <span class="vote-group" data-verdict="{{ verdict }}">
          <button type="button" class="vote-btn badge {{ cls }}" aria-pressed="false"
                  title="Vote {{ label }}"
                  onclick="return PatchBook.vote(this)">{{ symbol }} {{ label }}</button>
          <button type="button" class="vote-count" aria-haspopup="true" aria-expanded="false"
                  title="Who voted {{ label }}">–</button>
          <span class="voter-popover" role="group" aria-label="Readers who voted {{ label }}">
            <ul class="voter-list"></ul>
          </span>
        </span>
        {% endfor %}
        <span class="vote-status" role="status"></span>
      </div>

      <div class="community-actions">
        <details class="community-box">
          <summary class="btn btn-muted">Suggest change</summary>
          <div class="community-form">
            <p class="muted small">
              Posts here are AI-generated and may be wrong. Edit the source directly on
              GitHub — saving opens a pull request. Add yourself to the post's
              <code>editors:</code> list in the same PR and your name will appear at the
              bottom once it's merged.
            </p>
            <a class="btn btn-blue community-edit" href="#" target="_blank" rel="noopener"
               onclick="return PatchBook.editOnGitHub(this)">✎ Edit on GitHub (opens a PR)</a>
            <form onsubmit="return PatchBook.submitSuggestion(this)">
              <textarea name="suggestion" rows="4" maxlength="2000"
                        placeholder="…or just describe the change and we'll open an issue" required></textarea>
              <button type="submit" class="btn btn-muted">Open suggestion issue →</button>
            </form>
          </div>
        </details>
      </div>
    </div>
  </div>
  <article class="prose">{{ body|safe }}</article>

  {% if post.editors %}
  <section class="post-editors">
    <h2>Edited by</h2>
    <ul>
      {% for e in post.editors %}
      <li>
        <a href="https://github.com/{{ e.name }}" target="_blank" rel="noopener nofollow">{{ e.name }}</a>
        {% if e.date %}<span class="muted small">· {{ e.date }}</span>{% endif %}
        {% if e.note %}<div class="community-note">{{ e.note }}</div>{% endif %}
      </li>
      {% endfor %}
    </ul>
  </section>
  {% endif %}
</div>
<script src="/assets/patchbook.js"></script>
""")

ABOUT_TPL = BASE.replace("{% block title %}Posts{% endblock %}", "About").replace(
    "{% block body %}{% endblock %}", """
<div class="page">
  <div class="page-header"><h1>About PatchBook</h1></div>
  <article class="prose">
    <p>PatchBook publishes deep technical analyses of Windows kernel security patches.
    Each post is generated by
    <a href="https://github.com/tzvironen/kernel-cve-pipeline">kernel-cve-pipeline</a> —
    an automated system that downloads patched and unpatched Windows binaries,
    diffs them with Ghidriff, identifies the changed function via a Claude agent,
    and writes a structured post covering the root cause, patch mechanics, and exploitation primitive.</p>
    <h2>Audience</h2>
    <p>Posts assume familiarity with C, Windows kernel internals, and common vulnerability
    classes (TOCTOU, UAF, pool overflows).</p>
  </article>
</div>
""")

# ── routes ─────────────────────────────────────────────────────────────────────

@app.route("/")
def home():
    posts = _all_posts()
    return render_template_string(HOME_TPL, posts=posts, css=CSS,
                                  active="home", cvss_class=_cvss_class,
                                  strip_md=_strip_md)


@app.route("/posts/<slug>")
def post(slug: str):
    path = POSTS_DIR / f"{slug}.md"
    if not path.exists():
        abort(404)
    p = _parse(path)
    body = _render_body(p["_body"])
    return render_template_string(POST_TPL, post=p, body=body, css=CSS,
                                  active="post", cvss_class=_cvss_class,
                                  strip_md=_strip_md, site=_site_config())


@app.route("/assets/patchbook.js")
def patchbook_js():
    """Served here (rather than inlined like the CSS) so the vote UI works in
    local preview exactly as it does under Jekyll."""
    js = (Path(__file__).parent / "assets" / "patchbook.js").read_text(encoding="utf-8")
    return js, 200, {"Content-Type": "application/javascript; charset=utf-8"}


@app.route("/about")
def about():
    return render_template_string(ABOUT_TPL, css=CSS, active="about",
                                  cvss_class=_cvss_class, strip_md=_strip_md)


if __name__ == "__main__":
    import sys
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 4000
    print(f"[*] PatchBook  →  http://localhost:{port}/")
    app.run(host="0.0.0.0", port=port, debug=False)
