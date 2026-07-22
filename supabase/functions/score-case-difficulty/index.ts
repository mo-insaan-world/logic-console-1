// score-case-difficulty — CONSUMER-TIER Edge Function.
//
// Called from the architect browser at submit time to classify the case
// difficulty (PROTOCOL / FRICTION / TERRA INCOGNITA) before the row is
// written to architect_cases. Replaces a previous browser-side direct call
// to api.anthropic.com that hardcoded the ANTHROPIC_API_KEY as a
// client-side JavaScript constant — the key was scraped from the public
// repo / deployed-site DevTools and auto-revoked. See the key-rotation
// commit thread for context.
//
// SECURITY MODEL — defence in depth, no FUNCTION_INVOKE_SECRET (must never
// reach the browser). Pattern lifted verbatim from parse-actions:
//   1. INPUT CAP   — reject JSON body > 6000 chars (413)
//   2. RATE LIMIT  — 30 req/min per client IP (429), global via rate_limit_hits
//   3. MODEL CHOICE — Sonnet 4.6 (same as the prior browser-side call)
//   4. SPEND CAP   — Anthropic account-level monthly cap, set in console

import { CORS_HEADERS, jsonResponse, getClientIP } from '../_shared/cors.ts';
import { isRateLimited } from '../_shared/rate-limit.ts';

const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY');
const ANTHROPIC_URL     = 'https://api.anthropic.com/v1/messages';
const MODEL             = 'claude-sonnet-4-6';
const INPUT_CAP_CHARS   = 6000;     // ABUSE-BOUND 1
const RATE_LIMIT_MAX    = 30;       // ABUSE-BOUND 2
const RATE_LIMIT_WIN_MS = 60_000;
const MAX_TOKENS        = 512;

// System prompt — moved verbatim from the prior browser-side scoreCaseDifficulty
// (index.html commit 704bf9a). Kept inline rather than in _shared/ because no
// other function references it. Any prompt revision invalidates the implied
// scoring contract — version-pin if the rubric tiers ever shift.
const SYSTEM_PROMPT = `You are a clinical difficulty scoring system for trauma surgery cases. You score cases on a 3-tier scale based on a strict rubric. Respond only with valid JSON — no preamble, no explanation.

Scoring rubric:
PROTOCOL: Standard clinical guidelines apply and are executable given available resources. A medical student could find the answer in UpToDate.

FRICTION: Clinical guidelines exist but resource constraints make them partially or fully inapplicable. Requires expert adaptation of standard protocols. Appears in advanced textbooks but execution requires experience.

TERRA INCOGNITA: The clinical presentation, constraint constellation, or decision space is so rare or complex that no guideline, textbook, or training data covers it. Only encountered in the memory of surgeons with 20+ years at extreme-volume trauma units. Pure expert judgment required. This tier exists exclusively for cases designed by Architect-tier surgeons from direct clinical experience.

Score based on:
- Whether the injury type and management approach is covered in standard references (UpToDate, ATLS, trauma surgery textbooks)
- Number and severity of failing constraints (theatre, blood bank, specialist availability)
- Degree to which constraints render standard protocols non-executable
- Time pressure and physiological instability (vitals, lactate, BE)
- Whether the decision space requires improvisation beyond any documented protocol

Respond with exactly this JSON structure:
{"difficulty_rating":"PROTOCOL or FRICTION or TERRA INCOGNITA","confidence":"HIGH or MEDIUM or LOW","rationale":"One sentence explaining the rating","failing_constraints":["list","of","constraints","that","fail"],"expected_disagreement":"percentage range e.g. 40-60%"}`;

async function scoreDifficulty(payload: unknown): Promise<unknown> {
  if (!ANTHROPIC_API_KEY) throw new Error('Missing env: ANTHROPIC_API_KEY');
  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model:      MODEL,
      max_tokens: MAX_TOKENS,
      system:     SYSTEM_PROMPT,
      messages:   [{ role: 'user', content: JSON.stringify(payload, null, 2) }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic HTTP ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const text = (data.content?.[0]?.text ?? '').trim();
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('Invalid scoring response (no JSON object found)');
  return JSON.parse(m[0]);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== 'POST') return jsonResponse({ error: 'method not allowed' }, 405);

  const ip = getClientIP(req);
  if (await isRateLimited('score-case-difficulty:' + ip, RATE_LIMIT_MAX, RATE_LIMIT_WIN_MS)) {
    return jsonResponse({ error: 'rate limit exceeded, retry shortly' }, 429);
  }

  let raw: string;
  try { raw = await req.text(); }
  catch { return jsonResponse({ error: 'could not read body' }, 400); }

  if (raw.length > INPUT_CAP_CHARS) {
    return jsonResponse(
      { error: `payload too long: ${raw.length} chars exceeds cap of ${INPUT_CAP_CHARS}` },
      413,
    );
  }

  let body: Record<string, unknown>;
  try { body = JSON.parse(raw); }
  catch { return jsonResponse({ error: 'invalid JSON body' }, 400); }

  if (typeof body.case_title !== 'string' || !body.case_title.trim()) {
    return jsonResponse({ error: 'case_title required' }, 400);
  }

  try {
    const result = await scoreDifficulty(body);
    return jsonResponse(result);
  } catch (err) {
    return jsonResponse({ error: (err as Error).message }, 502);
  }
});
