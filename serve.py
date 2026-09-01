"""Minimal Flask server for PatchBook — serves _reports/*.md as a static blog."""
import re
from pathlib import Path

import markdown as md
from flask import Flask, abort, render_template_string

REPORTS_DIR = Path(__file__).parent / "_reports"
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
    """Accumulate one line of the `editors:` block (see _layouts/report.html).

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
    """Read the handful of `_config.yml` keys the report template needs.

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


def _all_reports() -> list[dict]:
    reports = [_parse(p) for p in sorted(REPORTS_DIR.glob("*.md"), reverse=True)]
    return reports


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
    """Render markdown body, stripping the leading H1 (shown in report header)."""
    # Remove the first H1 heading to avoid duplicate title
    body = re.sub(r"^#[^#][^\n]*\n", "", raw.lstrip(), count=1)
    return md.markdown(body, extensions=["fenced_code", "tables", "toc", "nl2br"])


# ── base template ──────────────────────────────────────────────────────────────

BASE = """<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{% block title %}Reports{% endblock %} — PatchBook</title>
  <style>{{ css }}</style>
</head>
<body>
<nav>
  <a class="nav-brand" href="/">
    <div class="brand-icon">P</div>
    PatchBook
  </a>
  <div class="nav-links">
    <a href="/"{% if active in ("home", "report") %} class="active"{% endif %}>Reports</a>
    <a href="/about"{% if active == 'about' %} class="active"{% endif %}>About</a>
  </div>
</nav>
{% block body %}{% endblock %}
<footer>
  <div class="footer-inner">
    <span>PatchBook — Windows kernel CVE analysis</span>
    <span>AI-drafted, community-corrected</span>
  </div>
</footer>
</body>
</html>"""

# Category chooser — mirrors _layouts/home.html.
HOME_TPL = BASE.replace("{% block title %}Reports{% endblock %}", "Reports").replace(
    "{% block body %}{% endblock %}", """
<div class="page">
  <div class="page-header">
    <h1>CVE Analysis Reports</h1>
    <p>Deep-dives into Windows kernel patches — vulnerability reports with decompilations</p>
  </div>
  <div class="category-grid">
    <a class="category-tile category-windows" href="/windows/">
      <span class="category-art" aria-hidden="true">
        <span class="win-pane"></span><span class="win-pane"></span>
        <span class="win-pane"></span><span class="win-pane"></span>
      </span>
      <span class="category-body">
        <span class="category-name">Windows</span>
        <span class="category-count">{{ reports|length }} report{% if reports|length != 1 %}s{% endif %}</span>
      </span>
    </a>
    <div class="category-tile category-soon" aria-disabled="true">
      <span class="category-body">
        <span class="category-name">More soon</span>
        <span class="category-count">Other platforms are not covered yet</span>
      </span>
    </div>
  </div>
</div>
""")

# Windows report list — mirrors _layouts/reports.html.
REPORTS_TPL = BASE.replace("{% block title %}Reports{% endblock %}", "Windows").replace(
    "{% block body %}{% endblock %}", """
<div class="page">
  <div class="page-header">
    <a class="back-link btn btn-muted" href="/">← All platforms</a>
    <h1>Windows</h1>
    <p>Deep-dives into Windows kernel patches — vulnerability reports with decompilations</p>
  </div>
  {% if reports %}
  <section class="report-filter" data-report-filter>
    <div class="filter-row">
      <label class="filter-field"><span>From</span><input type="date" data-filter-from></label>
      <label class="filter-field"><span>To</span><input type="date" data-filter-to></label>
      <button type="button" class="btn btn-muted" data-filter-reset>Reset</button>
      <span class="filter-summary" role="status" data-filter-summary></span>
    </div>
    <div class="range-slider" data-range>
      <div class="range-track" aria-hidden="true"><div class="range-fill" data-range-fill></div></div>
      <input type="range" data-range-from aria-label="Range start">
      <input type="range" data-range-to aria-label="Range end">
    </div>
  </section>

  <figure class="severity-chart" data-severity-chart hidden>
    <figcaption class="chart-title">Severity over time</figcaption>
    <div class="chart-frame">
      <svg viewBox="0 0 960 220" role="img"
           aria-label="CVSS severity of each report against its publication date"
           data-chart-svg></svg>
      <div class="chart-tip" role="status" data-chart-tip hidden></div>
    </div>
    <figcaption class="chart-note" data-chart-note></figcaption>
  </figure>

  <div class="report-list" data-report-list>
    {% for p in reports %}
    <a class="report-card" href="/reports/{{ p._slug }}"
       data-date="{{ p.date }}"
       {% if p.cvss %}data-cvss="{{ p.cvss }}"{% endif %}
       data-title="{{ p.cve_id or p.title }}">
      <div class="report-card-meta">
        <div class="flex-gap">
          {% if p.cve_id %}<span class="badge blue mono">{{ p.cve_id }}</span>{% endif %}
          {% if p.cvss %}<span class="badge {{ cvss_class(p.cvss) }} severity-badge" title="CVSS base score">{{ p.cvss }}</span>{% endif %}
        </div>
        <span class="report-date">{{ p.date }}</span>
      </div>
      <h2 class="report-card-title">{{ p.title }}</h2>
      {% if p.excerpt %}<p class="report-card-excerpt">{{ strip_md(p.excerpt) }}</p>{% endif %}
      <span class="report-card-link">Read full report →</span>
    </a>
    {% endfor %}
  </div>
  <p class="empty-state filter-empty" data-filter-empty hidden>No reports published in that date range.</p>
  {% else %}
  <div class="empty-state"><div class="empty-icon">📭</div><p>No reports yet.</p></div>
  {% endif %}
</div>
""")

REPORT_TPL = BASE.replace("{% block title %}Reports{% endblock %}", "{{ report.title }}").replace(
    "{% block body %}{% endblock %}", """
<div class="page page-report">
  <div class="report-header">
    <div class="report-header-meta">
      <div class="flex-gap">
        {% if report.cve_id %}<span class="badge blue mono">{{ report.cve_id }}</span>{% endif %}
        {% if report.cvss %}<span class="badge {{ cvss_class(report.cvss) }}">CVSS {{ report.cvss }}</span>{% endif %}
        <span class="muted small">{{ report.date }}</span>
      </div>
      <a href="/" class="btn btn-muted back-link">← All reports</a>
    </div>
    <h1 class="report-title">{{ report.title }}</h1>

    {# Mirrors _layouts/report.html: votes come live from the Worker API, the
       voter list appears only in the popover on the count, and edits go
       through GitHub PRs. #}
    <div class="community community-bar"
         data-report-path="_reports/{{ report._slug }}.md"
         data-cve="{{ report.cve_id or '' }}"
         data-repo="{{ site.github_repo or '' }}"
         data-branch="{{ site.github_branch or 'main' }}"
         data-api="{{ site.votes_api or '' }}">
      <div class="votes" title="Reader fact-check of this AI-generated report">
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
              Reports here are AI-generated and may be wrong. Edit the source directly on
              GitHub — saving opens a pull request. Add yourself to the report's
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

  {% if report.editors %}
  <section class="report-editors">
    <h2>Edited by</h2>
    <ul>
      {% for e in report.editors %}
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

ABOUT_TPL = BASE.replace("{% block title %}Reports{% endblock %}", "About").replace(
    "{% block body %}{% endblock %}", """
<div class="page">
  <div class="page-header"><h1>About PatchBook</h1></div>
  <article class="prose">
    <p>PatchBook publishes deep technical analyses of Windows kernel security patches.
    Each report is generated by
    an automated system that downloads patched and unpatched Windows binaries,
    diffs them with Ghidriff, identifies the changed function via a Claude agent,
    and writes a structured report covering the root cause, patch mechanics, and exploitation primitive.</p>
    <h2>Audience</h2>
    <p>Reports assume familiarity with C, Windows kernel internals, and common vulnerability
    classes (TOCTOU, UAF, pool overflows).</p>
  </article>
</div>
""")

# ── routes ─────────────────────────────────────────────────────────────────────

@app.route("/")
def home():
    reports = _all_reports()
    return render_template_string(HOME_TPL, reports=reports, css=CSS,
                                  active="home", cvss_class=_cvss_class,
                                  strip_md=_strip_md)


@app.route("/windows/")
def windows():
    return render_template_string(REPORTS_TPL, reports=_all_reports(), css=CSS,
                                  active="home", cvss_class=_cvss_class,
                                  strip_md=_strip_md, site=_site_config())


@app.route("/reports/<slug>")
def report(slug: str):
    path = REPORTS_DIR / f"{slug}.md"
    if not path.exists():
        abort(404)
    p = _parse(path)
    body = _render_body(p["_body"])
    return render_template_string(REPORT_TPL, report=p, body=body, css=CSS,
                                  active="report", cvss_class=_cvss_class,
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
