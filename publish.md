---
layout: default
title: Publish
permalink: /publish/
---
<div class="page">
  <div class="page-header">
    <h1>Publish a report</h1>
    <p>Analysed a Windows kernel patch? Fill this in and it becomes a pull request — reviewed before it goes live, like every other change here.</p>
  </div>

  <!-- .community carries repo/branch for the accessors in patchbook.js. No
       data-api: nothing on this page votes. -->
  <div class="community publish-page"
       data-repo="{{ site.github_repo | escape }}"
       data-branch="{{ site.github_branch | default: "main" | escape }}">
    <form class="publish-form" onsubmit="return PatchBookPublish.submit(this)">

      <div class="publish-grid">
        <label class="filter-field">
          <span>CVE number *</span>
          <input type="text" name="cve_id" required placeholder="CVE-2026-33827"
                 pattern="[Cc][Vv][Ee]-[0-9]{4}-[0-9]{4,7}" autocomplete="off"
                 title="Format: CVE-YYYY-NNNN">
        </label>

        <label class="filter-field">
          <span>Release date *</span>
          <input type="date" name="date" required>
        </label>

        <label class="filter-field">
          <span>Platform *</span>
          <select name="platform" required>
            <option value="windows" selected>Windows</option>
            <option value="" disabled>Other platforms — not yet covered</option>
          </select>
        </label>

        <label class="filter-field">
          <span>Severity (CVSS) *</span>
          <span class="severity-input">
            <input type="number" name="cvss" required min="0" max="10" step="0.1" placeholder="8.1">
            <span class="badge muted severity-badge" data-cvss-preview>—</span>
          </span>
        </label>

        <label class="filter-field">
          <span>Affected binary</span>
          <input type="text" name="binary" placeholder="tcpip.sys" autocomplete="off">
        </label>

        <label class="filter-field">
          <span>Patch KB</span>
          <input type="text" name="kb" placeholder="KB5082052" autocomplete="off">
        </label>
      </div>

      <label class="filter-field publish-wide">
        <span>Title *</span>
        <input type="text" name="title" required maxlength="160"
               placeholder="Use-After-Free in the Windows IPv4 Source-Routing Path">
      </label>

      <label class="filter-field publish-wide">
        <span>Excerpt — one or two sentences, shown on the report card</span>
        <textarea name="excerpt" rows="2" maxlength="300"
                  placeholder="A race condition in tcpip.sys let an unauthenticated attacker…"></textarea>
      </label>

      <label class="filter-field publish-wide">
        <span>The analysis</span>
        <textarea name="body" rows="16" spellcheck="false"></textarea>
      </label>

      <p class="publish-error" role="alert" data-publish-error hidden></p>

      <div class="publish-actions">
        <button type="submit" class="btn btn-blue" data-publish-submit>Publish report →</button>
        <span class="muted small" data-publish-filename></span>
      </div>
    </form>

    <section class="publish-output" data-publish-output hidden>
      <h2>Your report</h2>
      <p class="publish-status" role="status" data-publish-status></p>
      <textarea class="publish-file" readonly rows="12" spellcheck="false" data-publish-file></textarea>
      <div class="publish-actions">
        <a class="btn btn-blue" href="#" target="_blank" rel="noopener" data-publish-open>Open GitHub editor →</a>
        <a class="btn btn-muted" download data-publish-download>Download .md</a>
      </div>
      <p class="muted small">
        No GitHub account? Sign up on the page that opens — the filename survives sign-in,
        and your report is on the clipboard. Or download the file and attach it to an issue.
      </p>
    </section>
  </div>
</div>

<script src="{{ '/assets/patchbook.js' | relative_url }}"></script>
