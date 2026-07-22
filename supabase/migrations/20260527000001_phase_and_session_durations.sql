-- Phase-level + session-level timing instrumentation for both annotation roles.
--
-- Motivation: the existing single end-to-end timer (timerSec / displayed
-- in #timer; persisted as time_to_decision_seconds + time_on_case_seconds)
-- collapses Phase 1 + Phase 2 into one number for consultants, and has no
-- equivalent at all for architects. That means we can't tell:
--
--   (a) was Phase 2 attestation completed in seconds (rubber-stamping —
--       the failure mode Gemini flagged for the architect $100/case flow)
--       versus minutes (engaged review)?
--   (b) did the architect author the case in a hurry but spend real time
--       attesting, or the reverse?
--   (c) was the consultant struggling with Phase 1 prompts, or zipping
--       through them without thinking?
--
-- All three signals are masked by a single roll-up. This migration adds
-- per-phase millisecond durations to BOTH role tables so analytics can
-- separate the patterns.
--
-- NO UI change visible to the surgeon — all timestamps are passive
-- Date.now() captures at existing lifecycle hooks (case open, phase
-- submit, panel reveal, accept submit). Same passive-measurement
-- principle as the existing time_to_decision_seconds capture.

-- ── CONSULTANT side: per-submission durations ──────────────────────────
-- Lives on submissions (one row per consultant case attempt).
ALTER TABLE public.submissions
  ADD COLUMN IF NOT EXISTS phase1_duration_ms        bigint,
  ADD COLUMN IF NOT EXISTS phase2_duration_ms        bigint,
  ADD COLUMN IF NOT EXISTS total_session_duration_ms bigint;

COMMENT ON COLUMN public.submissions.phase1_duration_ms IS
  'Milliseconds from case-open (loadCase + resetTimer) to Phase 1 submit (ground-truth POST sent). Captures action-trace + reasoning capture duration. Anchored by client-side caseOpenMs, persisted to localStorage so multi-session refresh-mid-Phase-1 still captures the original anchor. Independent of network round-trip latency — duration is computed at fetch send time, not at response receipt.';
COMMENT ON COLUMN public.submissions.phase2_duration_ms IS
  'Milliseconds from Phase 2 begin (phase2-section becomes visible after Phase 1 submit) to Phase 2 submit (ratings PATCH sent). Captures the lethality/critique rating duration. Fast values may indicate rubber-stamping; slow values indicate careful per-step review. Session-only — refresh during Phase 2 resets the anchor to the moment-of-refresh, measuring time-on-Phase-2-this-session.';
COMMENT ON COLUMN public.submissions.total_session_duration_ms IS
  'Milliseconds from case-open to Phase 2 submit. gap = total - phase1 - phase2 captures any pause between Phase 1 and Phase 2 (e.g. surgeon closed browser mid-flow, came back later). Single-session gap is ~0; multi-session gap can be hours.';

-- ── ARCHITECT side: per-case durations ─────────────────────────────────
-- Lives on architect_cases. Three phases of the architect's authoring
-- lifecycle, mirroring consultant structure:
--   authoring     — form-fill (title, history, exam, dx, vitals,
--                   constraints, dilemma, GT trace) until Submit Case
--                   to Vault is clicked
--   (gap)         — LLM scoring + protocol drafting (~15s Anthropic
--                   latency, derived as total - authoring - attestation)
--   attestation   — protocol-review panel visible → ACCEPT & SUBMIT
--                   (the rubber-stamping concern lives here)
ALTER TABLE public.architect_cases
  ADD COLUMN IF NOT EXISTS architect_authoring_duration_ms   bigint,
  ADD COLUMN IF NOT EXISTS architect_attestation_duration_ms bigint,
  ADD COLUMN IF NOT EXISTS architect_total_duration_ms       bigint;

COMMENT ON COLUMN public.architect_cases.architect_authoring_duration_ms IS
  'Milliseconds from architect form opened (setViewMode + clearArchForm anchor, persisted by archId in localStorage) to Submit Case to Vault clicked. Captures the case-authoring phase — scenario + vitals + constraints + clinical-dilemma + architect ground-truth action/reasoning trace.';
COMMENT ON COLUMN public.architect_cases.architect_attestation_duration_ms IS
  'Milliseconds from LLM-drafted protocol panel revealed (arch-protocol-review.visible) to ACCEPT & SUBMIT (or SAVE PENDING) clicked. This is the attestation phase — architect reviewing LLM-drafted standard-of-care steps. Fast values flag the rubber-stamping pattern (Gemini concern: $100/case surgeon may click ATTEST without reading); slow values indicate careful per-step review.';
COMMENT ON COLUMN public.architect_cases.architect_total_duration_ms IS
  'Milliseconds from architect form opened to ACCEPT & SUBMIT. gap = total - authoring - attestation captures LLM scoring + drafting latency (~15s typical Anthropic round-trip). Useful as sanity check on whether the gap is reasonable or whether the architect paused mid-flow.';
