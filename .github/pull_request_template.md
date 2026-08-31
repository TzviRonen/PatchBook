Thanks for correcting a post! These analyses are AI-generated, so fixes from
readers who actually know the binary are the point of this whole setup.

## Credit yourself

**Add yourself to the post's `editors:` frontmatter in this same PR** — that
list is what renders as "Edited by" at the bottom of the post. Nothing is
automated, so if you don't add it, you won't be credited.

At the top of the `_posts/*.md` file you changed:

```yaml
---
layout: post
title: "…"
editors:
  - name: your-github-username
    date: 2026-08-29
    note: fixed the offset in the IPP_PATH refcount walkthrough   # optional
---
```

A bare `- your-github-username` works too if you'd rather not add the details.
Add a new entry rather than editing someone else's.

## What changed

<!-- What was wrong, and what you're correcting it to. If you have a reference
     — your own analysis, a disassembly listing, MSDN, a writeup — link it;
     that's what makes the fix reviewable. -->

---

Votes ("valid" / "AI-slop") aren't part of this — those are cast on the site
itself and stored outside the repo. This PR is only about the post's content.
