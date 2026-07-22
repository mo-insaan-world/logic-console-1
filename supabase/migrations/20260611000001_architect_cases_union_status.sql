-- Auto-build pipeline: union-build status tracking on architect_cases.
--
-- union_status reflects the candidate-action-union pipeline state:
--   union_pending  saved, build not started
--   union_building generate-responses / build-action-union in progress
--   union_ready    clusters written to case_action_union
--   union_failed   pipeline error (union_error holds the message)
-- union_content_hash = SHA-256 of the generation-relevant fields (scenario,
-- vitals, constraints, specialty) at the last build, so re-saves with no
-- material change don't re-spend on the providers.
--
-- Written only by the auto-build-union orchestrator (service role). The
-- consultant browser reads union_status/union_error (anon SELECT granted).

ALTER TABLE public.architect_cases
  ADD COLUMN IF NOT EXISTS union_status text NOT NULL DEFAULT 'union_pending',
  ADD COLUMN IF NOT EXISTS union_error text,
  ADD COLUMN IF NOT EXISTS union_content_hash text;

ALTER TABLE public.architect_cases
  DROP CONSTRAINT IF EXISTS architect_cases_union_status_check;
ALTER TABLE public.architect_cases
  ADD CONSTRAINT architect_cases_union_status_check
  CHECK (union_status IN ('union_pending','union_building','union_ready','union_failed'));

GRANT SELECT (union_status, union_error, union_content_hash) ON public.architect_cases TO anon;

-- Backfill: any architect case that already has a union built (via the
-- prior manual curl path) is union_ready, not pending.
UPDATE public.architect_cases ac
SET union_status = 'union_ready'
WHERE EXISTS (SELECT 1 FROM public.case_action_union cau WHERE cau.case_id = ac.id::text);
