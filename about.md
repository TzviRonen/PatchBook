---
layout: default
title: About
---
<div class="page">
  <div class="page-header">
    <h1>About PatchBook</h1>
    <p>A collaborative library of Windows kernel patch analysis - AI drafts it, the community makes it trustworthy.</p>
  </div>
  <article class="prose" markdown="1">

## The vision

PatchBook is building a shared, growing library of patch analyses for Windows
kernel CVEs - one where every entry gets better over time instead of going
stale the day it's published.

The AI-generated report, from [kernel-cve-pipeline](https://github.com/tzvironen/kernel-cve-pipeline),
is just the first draft. A model that has never run the exploit isn't ground
truth. **The value of this project isn't the AI output - it's what the
community does to it afterward.**

## Why AI-first, not AI-only

Automating the first pass is what makes it possible to cover CVEs at all -
nobody is going to hand-diff every kernel patch Microsoft ships. But it also
means every post is a hypothesis, not a verdict. That's why every post ships
with the tools to challenge it, right on the page:

- **Validate** - confirm a post holds up.
- **AI-slop** - flag one that doesn't, with a note on what's wrong.
- **Suggest a change** - propose a fix, as a note or a direct pull request.

## What "collaborative" means here

No accounts, no backend, no moderation queue. Every action opens a prefilled
GitHub issue; a GitHub Action records the mark straight into the post's
frontmatter. The Community check tally is a running scoreboard of how much
the community trusts that entry, and it's meant to move.

Over time, the library should be defined less by what the pipeline produced
and more by what readers corrected, confirmed, or rewrote. The AI gets the
first entry on the page. The community gets the last word.

  </article>
</div>
