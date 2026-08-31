-- PatchBook vote store (Cloudflare D1 / SQLite).
--
-- One row per (post, GitHub user). The composite primary key is what enforces
-- "one vote per user per post" — a second vote from the same account UPSERTs
-- over the first rather than adding a tally. Voter names are read live from
-- this table on every page load; there is no copy of it in the repo.

CREATE TABLE IF NOT EXISTS votes (
  post_id    TEXT    NOT NULL,          -- e.g. _posts/2026-08-29-cve-....md
  user_id    INTEGER NOT NULL,          -- GitHub numeric id: stable across renames
  login      TEXT    NOT NULL,          -- GitHub username, refreshed on every vote
  verdict    TEXT    NOT NULL CHECK (verdict IN ('valid', 'ai-slop')),
  note       TEXT,
  created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  PRIMARY KEY (post_id, user_id)
);

-- The hot query is "all votes for one post" (counts + voter list in one read).
CREATE INDEX IF NOT EXISTS idx_votes_post ON votes (post_id);
