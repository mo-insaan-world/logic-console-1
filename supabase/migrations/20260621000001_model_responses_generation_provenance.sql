-- model_responses: generation provenance for the neutral red-team prompt
-- (2026-06-21). created_at stays "first seen"; generated_at records each
-- (re)generation. model_snapshot is the served model id from the provider
-- response (falls back to the requested model_string). prompt_version is a
-- stable tag; prompt_sha256 is the sha256 of the exact rendered prompt sent.
--
-- model_responses is RLS-on with NO policies (anon cannot read — this enforces
-- output masking); writes are service-role only. Adding columns inherits that
-- posture, so no policy/grant changes are needed.

ALTER TABLE public.model_responses
  ADD COLUMN IF NOT EXISTS generated_at    timestamptz,
  ADD COLUMN IF NOT EXISTS model_snapshot  text,
  ADD COLUMN IF NOT EXISTS prompt_version  text,
  ADD COLUMN IF NOT EXISTS prompt_sha256   text;
