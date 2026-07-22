-- Add static_textbook_protocol_rejected_log column to architect_cases.
--
-- Companion to the at-submit-time protocol-review flow (architect drafts
-- ideal-standard steps with cited references, verifies each, may reject
-- some). This column stores the rejected drafts as a structured log for
-- two downstream purposes:
--
-- 1. Feeds the "do not re-suggest these or similar" instruction when the
--    architect uses RE-GENERATE in the protocol-review panel — the LLM
--    sees the rejected step + reference + reason and avoids both the
--    specific step and substantively similar alternatives on the next
--    draft pass.
--
-- 2. Captures LLM failure modes for downstream analysis. Which guidelines
--    does the LLM tend to fabricate? What does the architect consistently
--    reject? The log is the audit trail of the LLM's misses across all
--    architect-submitted cases.
--
-- The complementary static_textbook_protocol column already exists as
-- jsonb. It is upgrading in SHAPE from string[] to object[] (where each
-- object carries {step, reference, provenance.verification_log}); no
-- Postgres-level schema change is needed because jsonb accepts both.
-- buildPhase2 in index.html dual-renders: typeof step === 'string'
-- falls back to the legacy plain-text render, object shape gets the new
-- inline italic reference line beneath each step. Old admin-verified
-- rows stay as string[] forever — no backfill, per architect decision
-- to not retroactively rewrite admin-attested data.
--
-- Shape of the rejected-log entries written by index.html:
--   [
--     {
--       "step": "...",
--       "reference": { "source": "...", "section": "...", "recommendation_grade": "...|null" },
--       "generated_by": "claude-sonnet-4-6",
--       "generated_at": "ISO-8601",
--       "rejected_by": "architect_id",
--       "rejected_at": "ISO-8601",
--       "rejection_reason": "free-text, min 5 chars enforced at submit time"
--     },
--     ...
--   ]
--
-- Status note: an architect who hits SAVE PENDING — NO PROTOCOL writes
-- the case row with status='pending_protocol' (a new status value).
-- The consultant rotation query (architect_cases?status=eq.active)
-- naturally excludes these rows, so pending cases never enter the
-- annotator pipeline until an admin completes the protocol and flips
-- status back to 'active'. adminApproveTextbook in index.html performs
-- the status flip automatically once textbook_approved=true is set on
-- a pending row.

ALTER TABLE public.architect_cases
  ADD COLUMN IF NOT EXISTS static_textbook_protocol_rejected_log jsonb;

COMMENT ON COLUMN public.architect_cases.static_textbook_protocol_rejected_log IS
  'Append-only log of LLM-drafted standard-of-care steps that the architect rejected during at-submit-time review. Each entry carries the proposed step, the proposed reference, the architect_id and rejection_reason. Feeds RE-GENERATE do-not-resuggest and downstream LLM-failure-mode analysis. See supabase/migrations/20260526000001_protocol_rejected_log.sql for the shape.';
