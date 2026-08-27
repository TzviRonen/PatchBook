#!/usr/bin/env python3
"""Apply a community validation mark (from a GitHub issue) into a post's frontmatter.

Invoked by .github/workflows/validations.yml when an issue labelled `validation`
is opened. The issue body is expected to contain a fenced ```yaml block produced
by assets/patchbook.js, e.g.:

    ```yaml
    type: validation
    post: _posts/2026-06-08-cve-....md
    verdict: valid
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
MAX = {"note": 500}
_YAML_BLOCK_RE = re.compile(r"```ya?ml\s*\n(.*?)```", re.DOTALL | re.IGNORECASE)
_FIELD_RE = re.compile(r"^([A-Za-z_]+)\s*:\s*(.*)$")
_POST_NAME_RE = re.compile(r"^_posts/[A-Za-z0-9._-]+\.md$")
# GitHub usernames: alphanumeric plus single hyphens, 1–39 chars, no leading hyphen.
_USERNAME_RE = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$")


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
    # Defense in depth against stored XSS: notes are rendered into the post page,
    # so strip anything HTML-like here so hostile markup never enters the repo.
    # (The templates also `| escape` on output — the real fix — but keeping the
    # stored value plain-text means a future template regression can't reintroduce
    # the bug.) Drop tag-like <...> spans, then any stray angle brackets.
    value = re.sub(r"<[^>]*>", " ", value)
    value = value.replace("<", " ").replace(">", " ")
    # collapse any newlines/control chars to spaces, squeeze, trim, cap length.
    value = re.sub(r"[\x00-\x1f\x7f]", " ", value)
    value = re.sub(r"\s+", " ", value).strip()
    return value[:limit]


def yaml_str(value: str) -> str:
    """Double-quoted YAML scalar, escaping backslashes and quotes."""
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


def read_author() -> str:
    """The issue author's GitHub username, from the trusted event payload (not the
    spoofable issue body). Returns '' if absent or not a valid username — in which
    case the mark is recorded anonymously (keeps local/manual runs working)."""
    author = sanitize(os.environ.get("ISSUE_AUTHOR", ""), 39)
    return author if _USERNAME_RE.match(author) else ""


def build_entry(fields: dict, author: str) -> list[str]:
    verdict = fields.get("verdict", "").strip().lower()
    if verdict not in VERDICTS:
        reject(f"invalid verdict {verdict!r}; must be one of {sorted(VERDICTS)}")

    note = sanitize(fields.get("note", ""), MAX["note"])

    lines = [
        f"  - verdict: {verdict}",
        f"    date: {date.today().isoformat()}",
    ]
    if author:
        lines.append(f"    name: {yaml_str(author)}")
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


def _already_recorded(fm: list[str], key_idx: int, verdict: str, author: str) -> bool:
    """True if the existing `validations:` block already holds an entry with this
    exact (name, verdict) pair. An anonymous mark (author == '') is never treated
    as a duplicate. Uses the same simple line-based parse as the rest of the file:
    the block runs from the key until the first non-indented (top-level) line."""
    if not author:
        return False
    cur_verdict = None
    cur_name = ""
    for line in fm[key_idx + 1:]:
        if line and not line[0].isspace():
            break  # next top-level frontmatter key ends the block
        stripped = line.strip()
        if stripped.startswith("- "):
            # a new list entry begins — reset accumulators
            cur_verdict, cur_name = None, ""
            stripped = stripped[2:].strip()
        m = _FIELD_RE.match(stripped)
        if not m:
            continue
        k, v = m.group(1).strip().lower(), m.group(2).strip()
        if k == "verdict":
            cur_verdict = v.lower()
        elif k == "name":
            cur_name = v.strip('"').replace('\\"', '"').replace("\\\\", "\\")
        if cur_verdict == verdict and cur_name == author:
            return True
    return False


def apply(target: Path, entry: list[str], verdict: str, author: str) -> None:
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
        if _already_recorded(fm, key_idx, verdict, author):
            print(f"OK: already recorded {verdict} by {author} on "
                  f"{target.relative_to(POSTS_DIR.parent)}")
            sys.exit(0)
        fm[key_idx + 1:key_idx + 1] = entry

    target.write_text("\n".join(fm + rest), encoding="utf-8")


def main() -> None:
    fields = parse_block(read_body())
    if fields.get("type", "validation").lower() != "validation":
        reject(f"unexpected type {fields.get('type')!r}")
    target = resolve_post(fields.get("post", ""))
    author = read_author()
    entry = build_entry(fields, author)
    verdict = fields["verdict"].strip().lower()
    apply(target, entry, verdict, author)
    who = f" by {author}" if author else ""
    print(f"OK: recorded {verdict}{who} on {target.relative_to(POSTS_DIR.parent)}")


if __name__ == "__main__":
    main()
