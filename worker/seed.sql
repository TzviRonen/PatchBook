-- Carries the pre-existing frontmatter `validations:` marks into D1.
-- Run once, after schema.sql. user_id values are the real GitHub numeric ids.
--
-- Look an id up with:  curl -s https://api.github.com/users/<login> | jq .id

INSERT OR IGNORE INTO votes (post_id, user_id, login, verdict, created_at, updated_at)
VALUES (
  '_posts/2026-08-29-cve-2026-33827-tcpip-remote-code-execution.md',
  25377928,                             -- TzviRonen's GitHub numeric id
  'TzviRonen',
  'valid',
  '2026-08-29T00:00:00Z',
  '2026-08-29T00:00:00Z'
);
