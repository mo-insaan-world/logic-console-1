// generate-responses — POST { case_id, case_data, providers?, temperature? }
// Defaults providers to ['anthropic'] only — five-provider invoke must be opt-in
// to enforce Anthropic-only validation-first per ICAT-R deployment plan.
//
// 2026-06-21: prompt moved to _shared/redteam-prompt.ts (the neutral,
// facility-aware "red-team" prompt). Each row now records generation
// provenance: generated_at, model_snapshot (served model id), prompt_version,
// prompt_sha256. On a provider error we DO NOT upsert — so a failed
// (re)generation never blanks or half-writes an existing output row.

import { callModel, MODEL_REGISTRY, PHASE2_GEN_MODELS } from '../_shared/providers.ts';
import { requireInvokeSecret } from '../_shared/auth.ts';
import { buildPrompt, PROMPT_VERSION, sha256hex } from '../_shared/redteam-prompt.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

async function upsertModelResponse(row: {
  case_id: string; provider: string; model_string: string; temperature: number;
  response_text: string | null; error: string | null;
  finish_reason: string | null; usage: unknown | null;
  generated_at: string; model_snapshot: string | null;
  prompt_version: string; prompt_sha256: string;
}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/model_responses?on_conflict=case_id,provider,model_string`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_SERVICE_ROLE_KEY,
      'Authorization': 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY,
      'Prefer': 'resolution=merge-duplicates,return=representation',
    },
    body: JSON.stringify(row),
  });
  if (!res.ok) throw new Error(`Upsert model_responses failed: ${res.status} ${await res.text()}`);
  return res.json();
}

Deno.serve(async (req) => {
  // Security perimeter — must run before any other logic. See _shared/auth.ts.
  const authError = requireInvokeSecret(req);
  if (authError) return authError;

  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  let body: any;
  try { body = await req.json(); }
  catch { return new Response(JSON.stringify({ error: 'Invalid JSON body' }), { status: 400, headers: { 'Content-Type': 'application/json' } }); }

  const { case_id, case_data, providers, temperature = 0 } = body;
  if (!case_id) return new Response(JSON.stringify({ error: 'case_id required' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  if (!case_data) return new Response(JSON.stringify({ error: 'case_data required (no cases table; pass inline)' }), { status: 400, headers: { 'Content-Type': 'application/json' } });

  const providerList: string[] = Array.isArray(providers) && providers.length > 0 ? providers : ['anthropic'];

  const prompt = buildPrompt(case_data);
  const promptSha = await sha256hex(prompt);

  // Run providers in parallel. Sequential blew through the 150s gateway
  // idle-timeout when openai + deepseek (reasoning models, ~30s each) were
  // both in the list. Each provider's handler swallows its own errors —
  // callModel never throws, and the upsert is wrapped — so Promise.all
  // never rejects.
  const results = await Promise.all(providerList.map(async (provider) => {
    const entry = MODEL_REGISTRY[provider];
    if (!entry) {
      return { provider, model_string: null, status: 'error', error: `Unknown provider: ${provider}` };
    }
    // Generation model snapshot is DECOUPLED from MODEL_REGISTRY (which also
    // feeds the judge ensemble). Use the pinned PHASE2_GEN_MODELS string; the
    // registry still supplies wire shape / key / token cap inside callModel.
    const genModelString = PHASE2_GEN_MODELS[provider] ?? entry.modelString;
    const { text, error, finish_reason, usage, model } = await callModel(provider, genModelString, prompt, temperature);
    // NEVER blank/half-write an existing output: on failure, do NOT upsert.
    // The prior good row (if any) is left untouched; the failure is reported.
    if (!text) {
      return { provider, model_string: genModelString, status: 'error', error: error || 'empty response', text_length: 0, finish_reason };
    }
    const row = {
      case_id,
      provider,
      model_string: genModelString,
      temperature,
      response_text: text,
      error: null,
      finish_reason,
      usage,
      generated_at:   new Date().toISOString(),
      model_snapshot: model || entry.modelString,
      prompt_version: PROMPT_VERSION,
      prompt_sha256:  promptSha,
    };
    try {
      await upsertModelResponse(row);
      return {
        provider,
        model_string: entry.modelString,
        status: 'ok',
        model_snapshot: row.model_snapshot,
        text_length: text.length,
        finish_reason,
        usage,
      };
    } catch (dbErr) {
      return { provider, model_string: genModelString, status: 'db_error', error: (dbErr as Error).message };
    }
  }));

  return new Response(JSON.stringify({ case_id, providers_invoked: providerList, prompt_version: PROMPT_VERSION, results }, null, 2), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
});
