-- Granularity-of-raw-text metrics for both annotation roles.
--
-- Motivation: alongside the phase-level timing instrumentation
-- (20260527000001), we want a content-richness signal for the pilot
-- analysis. Gemini's "granularity gap" concern is whether surgeon-
-- produced data is rich enough to score against verbose model output;
-- without measurement we'd be reasoning from impressions.
--
-- All eight metrics are PURE DERIVATIONS from data already stored:
--   action_trace_raw         → char/word counts, decline-line count
--   reasoning_trace          → char/word counts
--   action_atoms_confirmed   → count, mean word length per atom,
--                              constraint-tagged atom count
--
-- This is denormalization for analytics convenience, NOT new data
-- capture. The source of truth remains the raw fields above; if the
-- numbers were ever wrong, they could be recomputed from source. No
-- UI change visible to the surgeon; no thresholds enforced anywhere.
-- Captured at POST time on Phase 1 (consultant) and architect submit.

-- ── CONSULTANT side: per-submission metrics ────────────────────────────
ALTER TABLE public.submissions
  ADD COLUMN IF NOT EXISTS action_trace_char_count      integer,
  ADD COLUMN IF NOT EXISTS action_trace_word_count      integer,
  ADD COLUMN IF NOT EXISTS reasoning_trace_char_count   integer,
  ADD COLUMN IF NOT EXISTS reasoning_trace_word_count   integer,
  ADD COLUMN IF NOT EXISTS confirmed_atom_count         integer,
  ADD COLUMN IF NOT EXISTS atom_mean_word_length        numeric,
  ADD COLUMN IF NOT EXISTS constraint_tagged_atom_count integer,
  ADD COLUMN IF NOT EXISTS decline_count                integer;

COMMENT ON COLUMN public.submissions.action_trace_char_count IS
  'Length in characters of trimmed action_trace_raw at Phase 1 submit. Derived metric — source of truth is the raw text.';
COMMENT ON COLUMN public.submissions.action_trace_word_count IS
  'Whitespace-delimited word count of trimmed action_trace_raw at Phase 1 submit.';
COMMENT ON COLUMN public.submissions.reasoning_trace_char_count IS
  'Length in characters of trimmed reasoning_trace at Phase 1 submit.';
COMMENT ON COLUMN public.submissions.reasoning_trace_word_count IS
  'Whitespace-delimited word count of trimmed reasoning_trace at Phase 1 submit.';
COMMENT ON COLUMN public.submissions.confirmed_atom_count IS
  'Length of action_atoms_confirmed array at Phase 1 submit — number of atomic actions the surgeon confirmed after review.';
COMMENT ON COLUMN public.submissions.atom_mean_word_length IS
  'Mean word count per confirmed atom. NULL when confirmed_atom_count = 0. Short values may indicate under-specification; long values may indicate the atomizer failed to split a compound action.';
COMMENT ON COLUMN public.submissions.constraint_tagged_atom_count IS
  'Number of confirmed atoms whose text matches /constraint[:\s]/i — i.e. atoms the surgeon tagged with the "Constraint: X" convention from the placeholder format.';
COMMENT ON COLUMN public.submissions.decline_count IS
  'Number of "Would not" entries in action_trace_raw (case-insensitive, line-anchored). Counts surgeon-formatted decline entries per the placeholder format "Would not: [action] — [constraint]."';

-- ── ARCHITECT side: per-case metrics (identical eight) ─────────────────
ALTER TABLE public.architect_cases
  ADD COLUMN IF NOT EXISTS action_trace_char_count      integer,
  ADD COLUMN IF NOT EXISTS action_trace_word_count      integer,
  ADD COLUMN IF NOT EXISTS reasoning_trace_char_count   integer,
  ADD COLUMN IF NOT EXISTS reasoning_trace_word_count   integer,
  ADD COLUMN IF NOT EXISTS confirmed_atom_count         integer,
  ADD COLUMN IF NOT EXISTS atom_mean_word_length        numeric,
  ADD COLUMN IF NOT EXISTS constraint_tagged_atom_count integer,
  ADD COLUMN IF NOT EXISTS decline_count                integer;

COMMENT ON COLUMN public.architect_cases.action_trace_char_count IS
  'Length in characters of trimmed action_trace_raw at architect submit (architect_ground_truth.action_trace_raw). Derived metric — source of truth is the raw text.';
COMMENT ON COLUMN public.architect_cases.action_trace_word_count IS
  'Whitespace-delimited word count of trimmed action_trace_raw at architect submit.';
COMMENT ON COLUMN public.architect_cases.reasoning_trace_char_count IS
  'Length in characters of trimmed reasoning_trace at architect submit.';
COMMENT ON COLUMN public.architect_cases.reasoning_trace_word_count IS
  'Whitespace-delimited word count of trimmed reasoning_trace at architect submit.';
COMMENT ON COLUMN public.architect_cases.confirmed_atom_count IS
  'Length of action_atoms_confirmed array at architect submit.';
COMMENT ON COLUMN public.architect_cases.atom_mean_word_length IS
  'Mean word count per confirmed atom on architect submit. NULL when no atoms.';
COMMENT ON COLUMN public.architect_cases.constraint_tagged_atom_count IS
  'Number of confirmed atoms with the "Constraint:" convention applied at architect submit.';
COMMENT ON COLUMN public.architect_cases.decline_count IS
  'Number of "Would not" entries in architect action_trace_raw, line-anchored, case-insensitive.';
