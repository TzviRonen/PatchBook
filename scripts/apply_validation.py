#!/usr/bin/env python3
"""Apply a community validation mark (from a GitHub issue) into a post's frontmatter.

Invoked by .github/workflows/validations.yml when an issue labelled `validation`
is opened. The issue body is expected to contain a fenced ```yaml block produced
by assets/patchbook.js, e.g.:

    ```yaml
    type: validation
    post: _posts/2026-06-08-cve-....md
    verdict: valid
    name: Jane Doe
    contact: https://x.com/jane
    note: optional one-liner
    ```

The script validates and sanitizes every field, then appends an entry to the
post's `validations:` frontmatter list and rewrites the file. Since *anyone* can
open an issue, treat all input as hostile: strict allowlists, length caps, no
path traversal, YAML-escaped strings.

Usage:
    ISSUE_BODY="..." python scripts/apply_validation.py      # body from env
    python scripts/apply_validation.py path/to/body.txt      # body from file
    cat body.txt | python scripts/apply_validation.py        # body from stdin

Exit codes: 0 = applied, 2 = rejected (bad input), 1 = unexpected error.
"""
import os
import re
import sys
from datetime import date
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
POSTS_DIR = (SCRIPT_DIR.parent / "_posts").resolve()

VERDICTS = {"valid", "ai-slop", "needs-fixing"}
MAX = {"name": 80, "contact": 200, "note": 500}
_YAML_BLOCK_RE = re.compile(r"```ya?ml\s*\n(.*?)```", re.DOTALL | re.IGNORECASE)
_FIELD_RE = re.compile(r"^([A-Za-z_]+)\s*:\s*(.*)$")
_POST_NAME_RE = re.compile(r"^_posts/[A-Za-z0-9._-]+\.md$")


def reject(msg: str):
    print(f"REJECT: {msg}", file=sys.stderr)
    sys.exit(2)


def read_body() -> str:
    env = os.environ.get("ISSUE_BODY")
    if env:
        return env
    if len(sys.argv) > 1:
        return Path(sys.argv[1]).read_text(encoding="utf-8")
    return sys.stdin.read()


def parse_block(body: str) -> dict:
    m = _YAML_BLOCK_RE.search(body)
    if not m:
        reject("no ```yaml block found in issue body")
    fields = {}
    for line in m.group(1).splitlines():
        line = line.rstrip()
        if not line.strip():
            continue
        fm = _FIELD_RE.match(line)
        if fm:
            fields[fm.group(1).strip().lower()] = fm.group(2).strip()
    return fields


def sanitize(value: str, limit: int) -> str:
    # collapse any newlines/control chars to spaces, squeeze, trim, cap length.
    value = re.sub(r"[\x00-\x1f\x7f]", " ", value)
    value = re.sub(r"\s+", " ", value).strip()
    return value[:limit]


def yaml_str(value: str) -> str:
    """Double-quoted YAML scalar, escaping backslashes and quotes."""
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


def check_contact(contact: str) -> None:
    """Reject contacts that would become a dangerous link on the rendered page.

    The post template links the contact when it looks like a URL (`scheme://…`).
    Only http/https are allowed there — otherwise a value like
    `javascript://%0aalert(1)` or `data:…` becomes stored XSS. Scheme-less
    handles (e.g. `x.com/jane`, `@jane`) and plain emails are fine: they render
    as text or mailto.
    """
    if "://" in contact:
        scheme = contact.split("://", 1)[0].lower()
        if scheme not in ("http", "https"):
            reject(f"contact URL scheme {scheme!r} not allowed (use http/https, email, or a handle)")
    # block any other URL-ish scheme that a renderer might honour as a link
    elif re.match(r"(?i)\s*(javascript|data|vbscript|file)\s*:", contact):
        reject("contact must be an http(s) URL, an email, or a plain handle")


def build_entry(fields: dict) -> list[str]:
    verdict = fields.get("verdict", "").strip().lower()
    if verdict not in VERDICTS:
        reject(f"invalid verdict {verdict!r}; must be one of {sorted(VERDICTS)}")

    name = sanitize(fields.get("name", ""), MAX["name"])
    contact = sanitize(fields.get("contact", ""), MAX["contact"])
    note = sanitize(fields.get("note", ""), MAX["note"])
    if not name:
        reject("missing name")
    if not contact:
        reject("missing contact")
    check_contact(contact)

    lines = [
        f"  - verdict: {verdict}",
        f"    name: {yaml_str(name)}",
        f"    contact: {yaml_str(contact)}",
        f"    date: {date.today().isoformat()}",
    ]
    if note:
        lines.append(f"    note: {yaml_str(note)}")
    return lines


def resolve_post(post: str) -> Path:
    post = post.strip()
    if not _POST_NAME_RE.match(post):
        reject(f"post path {post!r} is not a plain _posts/*.md path")
    target = (POSTS_DIR.parent / post).resolve()
    # must stay inside _posts/
    if POSTS_DIR not in target.parents:
        reject("post path escapes _posts/")
    if not target.is_file():
        reject(f"post not found: {post}")
    return target


def apply(target: Path, entry: list[str]) -> None:
    text = target.read_text(encoding="utf-8")
    if not text.startswith("---"):
        reject(f"{target.name} has no YAML frontmatter")
    # split frontmatter: lines between the first two '---' delimiters
    lines = text.split("\n")
    end = None
    for i in range(1, len(lines)):
        if lines[i].strip() == "---":
            end = i
            break
    if end is None:
        reject(f"{target.name} frontmatter is not terminated")

    fm = lines[:end]
    rest = lines[end:]

    # insert the new entry right after an existing `validations:` key, else add it.
    key_idx = next((i for i, l in enumerate(fm) if l.strip() == "validations:"), None)
    if key_idx is None:
        fm.append("validations:")
        fm.extend(entry)
    else:
        fm[key_idx + 1:key_idx + 1] = entry

    target.write_text("\n".join(fm + rest), encoding="utf-8")


def main() -> None:
    fields = parse_block(read_body())
    if fields.get("type", "validation").lower() != "validation":
        reject(f"unexpected type {fields.get('type')!r}")
    target = resolve_post(fields.get("post", ""))
    entry = build_entry(fields)
    apply(target, entry)
    print(f"OK: recorded {fields['verdict']} on {target.relative_to(POSTS_DIR.parent)}")


if __name__ == "__main__":
    main()
