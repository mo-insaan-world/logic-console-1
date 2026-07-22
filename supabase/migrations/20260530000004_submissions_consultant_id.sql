-- Add consultant_id to submissions for inter-rater attribution.
--
-- The pilot will involve three consultants rating the same case. Computing
-- inter-rater agreement requires knowing whose ratings are whose, and the
-- submissions table previously had no operator marker (view_mode='consultant'
-- only distinguishes role, not identity).
--
-- Nullable: historical rows have no identifier (pre-existed before this
-- column). Future pilot rows will carry it via the URL ?cid= param or a
-- one-time prompt (UI changes in the same commit).
--
-- Identifier shape: free text. The UI normalises (trim, upper-case,
-- replace non-alphanumerics with underscore) before write. Suggested
-- format: surgeon initials or a study-assigned code (e.g. 'C1', 'MK', etc).
-- No format constraint enforced at the DB level — keep it free so a future
-- pilot using study IDs or full names doesn't hit a constraint mismatch.
--
-- Cross-table propagation: phase2_union_ratings + phase2_volunteered_lethal_actions
-- + case_scores all carry submission_id; the consultant_id reaches them
-- via JOIN, no duplication needed.

BEGIN;

ALTER TABLE submissions
  ADD COLUMN IF NOT EXISTS consultant_id text;

CREATE INDEX IF NOT EXISTS idx_submissions_consultant_id
  ON submissions(consultant_id) WHERE consultant_id IS NOT NULL;

COMMENT ON COLUMN submissions.consultant_id IS
  'Free-text identifier for the rating consultant (initials, study ID, etc). NULL on historical/pre-pilot rows. Populated for pilot rows via the consultant UI''s URL ?cid= param or one-time prompt. Inter-rater agreement: GROUP BY consultant_id, cluster_id.';

COMMIT;
