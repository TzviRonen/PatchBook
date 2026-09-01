-- post_id → report_id, and _posts/… → _reports/… in existing keys.
--
-- schema.sql is written with CREATE TABLE IF NOT EXISTS, so it will NOT alter a
-- table that already exists — running it against a pre-rename database leaves
-- post_id in place and every query fails with "no such column: report_id".
--
-- Safe to run more than once: each statement is guarded, and the UPDATE is a
-- no-op once the values are already rewritten.
--
--   wrangler d1 execute patchbook --local --env dev --file=migrations/0001-post-id-to-report-id.sql
--   wrangler d1 execute patchbook --remote           --file=migrations/0001-post-id-to-report-id.sql

ALTER TABLE votes RENAME COLUMN post_id TO report_id;

-- Vote rows are keyed on the source path, which moved with the directory.
-- Without this, existing votes point at files that no longer exist and are
-- rejected by REPORT_RE in src/index.js.
UPDATE votes
   SET report_id = '_reports/' || substr(report_id, length('_posts/') + 1)
 WHERE report_id LIKE '_posts/%';

DROP INDEX IF EXISTS idx_votes_post;
CREATE INDEX IF NOT EXISTS idx_votes_report ON votes (report_id);
