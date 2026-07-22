-- Pilot-eligible data filter. Source of truth for analysis queries.
-- Base tables retain all rows for audit trail; views define what counts as
-- real-pilot data.
--
-- ── DESIGN ─────────────────────────────────────────────────────────────────
--
-- Three views, one per submission-rooted table. submissions_pilot is the
-- single source of truth for "what counts as a real pilot consultant
-- submission". The other two views derive from it via JOIN, so any rule
-- change propagates from one place.
--
-- ── PILOT-ELIGIBILITY RULES ───────────────────────────────────────────────
--
--   consultant_id IS NOT NULL          — historical pre-pilot rows (created
--                                        before migration 20260530000004
--                                        added the column) had NULL; pilot
--                                        rows have it set via URL ?cid= or
--                                        the one-time prompt.
--   consultant_id NOT LIKE '%TEST%'    — covers the "TESTING" cardiac row
--                                        + any future TEST-prefixed test
--                                        consultants from manual entry.
--   consultant_id NOT LIKE '%MACHINERY%'  — covers MACHINERY_E2E and any
--                                          future MACHINERY_* machinery-
--                                          test cids.
--   machinery_test IS NULL OR machinery_test = false — NULL-permissive
--                                          guard for the post-pilot queue
--                                          item that adds an explicit
--                                          machinery_test boolean to
--                                          submissions. Without that column
--                                          the IS NULL branch matches every
--                                          row; once the column lands, NULL
--                                          and false both qualify.
--                                          See POST_PILOT_QUEUE.md.
--
-- ── WHAT THIS IS NOT ──────────────────────────────────────────────────────
--
-- This is NOT the synthetic-firewall filter (synthetic = false). That
-- filter lives on phase2_union_ratings / case_consensus and is enforced
-- via partial indexes + the rows' own synthetic column. Synthetic firewall
-- + pilot-eligibility are complementary:
--   - synthetic firewall  : excludes machinery-validation cases (SYNTH-*)
--                           and pre-pilot test rows on BRH-2024-0891
--   - pilot-eligibility   : excludes test/machinery consultant_ids on
--                           any case, including the actual pilot case SOW
--                           and any architect-authored case
--
-- A real analytics query that produces publishable rollups should compose
-- both:
--   SELECT ... FROM phase2_union_ratings_pilot WHERE synthetic = false;
--
-- ── DEFENSIVENESS ─────────────────────────────────────────────────────────
--
-- machinery_test column may not exist yet. The CASE expression below
-- inspects information_schema at view-creation time and constructs the
-- predicate accordingly. If a later migration adds the column, this view
-- needs to be re-created via CREATE OR REPLACE VIEW so the predicate picks
-- up the new column. The view body intentionally does NOT reference
-- machinery_test by name unless it exists — referencing a non-existent
-- column would fail view creation outright.

BEGIN;

-- submissions_pilot — the source of truth.
-- The machinery_test guard is conditional on the column existing.
DO $$
DECLARE
  has_machinery_test boolean;
  view_sql           text;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'submissions'
      AND column_name  = 'machinery_test'
  ) INTO has_machinery_test;

  IF has_machinery_test THEN
    view_sql := $v$
      CREATE OR REPLACE VIEW submissions_pilot AS
      SELECT *
      FROM submissions
      WHERE consultant_id IS NOT NULL
        AND consultant_id NOT LIKE '%TEST%'
        AND consultant_id NOT LIKE '%MACHINERY%'
        AND (machinery_test IS NULL OR machinery_test = false);
    $v$;
  ELSE
    view_sql := $v$
      CREATE OR REPLACE VIEW submissions_pilot AS
      SELECT *
      FROM submissions
      WHERE consultant_id IS NOT NULL
        AND consultant_id NOT LIKE '%TEST%'
        AND consultant_id NOT LIKE '%MACHINERY%';
    $v$;
  END IF;

  EXECUTE view_sql;
END
$$;

COMMENT ON VIEW submissions_pilot IS
  'Pilot-eligible submissions. Source of truth for analysis queries. '
  'Base table retains all rows for audit; this view defines real-pilot data. '
  'See migration 20260531000001 for the four-clause rule.';

-- phase2_union_ratings_pilot — joins through submissions_pilot so any rule
-- change in the parent view propagates automatically.
CREATE OR REPLACE VIEW phase2_union_ratings_pilot AS
SELECT r.*
FROM phase2_union_ratings r
JOIN submissions_pilot s ON r.submission_id = s.id;

COMMENT ON VIEW phase2_union_ratings_pilot IS
  'phase2_union_ratings restricted to pilot-eligible submissions. '
  'Compose with synthetic = false for publishable analytics.';

-- phase2_volunteered_lethal_actions_pilot — same pattern.
CREATE OR REPLACE VIEW phase2_volunteered_lethal_actions_pilot AS
SELECT v.*
FROM phase2_volunteered_lethal_actions v
JOIN submissions_pilot s ON v.phase2_submission_id = s.id;

COMMENT ON VIEW phase2_volunteered_lethal_actions_pilot IS
  'phase2_volunteered_lethal_actions restricted to pilot-eligible submissions.';

-- Grants — match the base-table grants. submissions has anon SELECT for the
-- admin panel's count queries; the pilot view inherits the row-shape so
-- anon needs the same SELECT to read it from the browser without rolling
-- privileges. Re-grant explicitly because CREATE VIEW does not inherit
-- privileges.
GRANT SELECT ON submissions_pilot                          TO anon, authenticated;
GRANT SELECT ON phase2_union_ratings_pilot                 TO anon, authenticated;
GRANT SELECT ON phase2_volunteered_lethal_actions_pilot    TO anon, authenticated;

COMMIT;
