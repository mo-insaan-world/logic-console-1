-- Pre-pilot cleanup: flag BRH-2024-0891 pre-pilot test rows as synthetic
-- so they can't mix into real pilot data via the synthetic-firewall filter
-- (WHERE synthetic = false).
--
-- Pre-pilot state inventory (2026-05-30):
--   phase2_union_ratings:
--     BRH-2024-0891  × 52 rows  synthetic=false  ← test data, should be true
--     (no other case has phase2_union_ratings rows yet)
--   case_consensus:
--     BRH-2024-0891  × 1 row    synthetic=false  ← test data, should be true
--     SOW-2024-1562  × 1 row    synthetic=false  ← REAL pilot scaffolding,
--                                                  the cluster set the pilot
--                                                  consultant will rate.
--                                                  LEAVE FALSE.
--     SYNTH-*        × 10 rows  synthetic=true   ← already correct
--
-- Why not also flag SOW: SOW-2024-1562 is the actual pilot case. Its
-- case_consensus row + case_action_union rows are the rateable surface the
-- real pilot consultant will engage with. Flagging it would suppress real
-- pilot data from publishable rollups.
--
-- Identifying pilot vs pre-pilot consultant submissions:
--   submissions.consultant_id (added in companion migration 20260530000004)
--   is the canonical pilot-vs-pre-pilot discriminator. Historical rows have
--   it as NULL; pilot rows have it set via the URL ?cid= param or the
--   one-time prompt. The synthetic flag covers tables that derive from
--   submissions; consultant_id covers submissions itself.

BEGIN;

UPDATE phase2_union_ratings
  SET synthetic = true
  WHERE case_id = 'BRH-2024-0891' AND synthetic = false;

UPDATE case_consensus
  SET synthetic = true
  WHERE case_id = 'BRH-2024-0891' AND synthetic = false;

COMMIT;
