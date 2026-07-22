// parse-actions — CONSUMER-TIER Edge Function.
//
// Called from the consultant browser to extract atomic clinical actions from a
// free-text action_trace. Uses Sonnet-4-6 (Anthropic family — disjoint from
// the judge ensemble per paper Section 4.4). A Haiku-4-5 A/B was tried and
// reverted: short plans worked at 1.93× speedup but a long-plan probe (2054-
// char polytrauma plan) found Haiku over-splits (20 atoms vs Sonnet's 12–13,
// outside the prompt's 6–10 target) and overruns the max_tokens cap, causing
// 3/3 HTTP 502s in production. The consultant Review-Actions click is the
// single most visible interaction in the surgeon's flow; a 502 there is a
// session-ending event, not comparable to a 12s wait. Sonnet stays.
// (Haiku remains in scoring.ts for the bulk extraction paths where occasional
// retries don't affect UX.) These atoms become H_c ground truth in ICAT-R
// scoring, so the family-level invariant — single fixed Anthropic extractor —
// is preserved across both extractor models.
//
// SECURITY MODEL — DIFFERENT FROM admin-tier generate/score functions:
//   - Does NOT use FUNCTION_INVOKE_SECRET (that secret must never reach the
//     browser). The function is reachable by anyone with the URL.
//   - The perimeter is defence in depth via four explicit abuse-bounds:
//       1. INPUT CAP        — reject action_trace > 8000 chars (413)
//       2. RATE LIMIT       — 30 req/min per client IP (429). GLOBAL via the
//                              rate_limit_hits table (service-role-only) — the
//                              earlier per-instance Map could not enforce limits
//                              across Supabase's distributed function instances.
//       3. MODEL CHOICE     — Sonnet 4.6 for reliable extraction quality since
//                              these atoms become H_c ground truth. Volume is
//                              bounded by bounds 2 + 4, not by per-call cost.
//       4. SPEND CAP        — Anthropic account-level monthly cap is the final
//                              backstop. Set in the Anthropic console.
//   - CORS is open (Access-Control-Allow-Origin: *) for now. Lock down to the
//     deployed app origin once the consultant UI is wired up (Slice 2).

// ── Config ────────────────────────────────────────────────────────────────────

import { CORS_HEADERS, jsonResponse, getClientIP } from '../_shared/cors.ts';
import { isRateLimited } from '../_shared/rate-limit.ts';
import { EXTRACTION_STRUCTURED_PROMPT } from '../_shared/extraction-prompt.ts';

const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY');
const ANTHROPIC_URL     = 'https://api.anthropic.com/v1/messages';
// Sonnet-4-6 — Anthropic family. The extractor family must stay disjoint from
// the judge ensemble (gemini / openai / xai); haiku was tried and reverted
// (see header comment). Sonnet is the production extractor for the
// surgeon-facing path; reliability over speed.
const PARSER_MODEL      = 'claude-sonnet-4-6';
const INPUT_CAP_CHARS   = 8000;                  // ABUSE-BOUND 1

// Rate-limit config — global via rate_limit_hits table.
// Keyed on IP. 30/min is abuse-stopping but tolerant of multiple consultants
// behind a shared hospital NAT/proxy. Session-based keying can be layered later
// once consultant auth exists. Bucket prefix "parse-actions:" keeps the quota
// isolated from other consumer-tier functions (e.g. submit-phase2).
const RATE_LIMIT_MAX    = 30;                    // ABUSE-BOUND 2: requests per window
const RATE_LIMIT_WIN_MS = 60_000;                // ABUSE-BOUND 2: window (1 min)

// ── Extraction ────────────────────────────────────────────────────────────────
//
// Extraction prompt is imported from _shared/extraction-prompt.ts so the
// granularity stays identical across consultant parsing (here) and model-
// response scoring (in scoring.ts). Any divergence introduces extraction
// asymmetry into W_c.

// Atom shape returned to the browser. Mirrors the JSON schema described in
// EXTRACTION_STRUCTURED_PROMPT. The browser then renders one card per atom
// with source-quote highlighting + editable tag chips + missing-action gate.
interface AtomTags {
  sequence_after: number[];
  conditional_on: { condition_type: string; condition_text: string } | null;
  negation: boolean;
  locus: 'local_only' | 'transfer_only' | null;
  role: 'primary' | 'contingency';
  time_critical: boolean;
  time_window_minutes: number | null;
}
interface Atom {
  text: string;
  source_quote: string;
  tags: AtomTags;
}

// Default tag values used to backfill any missing tag field on a per-atom
// basis. Belt-and-suspenders against a model that omits a tag key — the
// browser code can rely on every atom having a fully-populated tags object.
const DEFAULT_TAGS: AtomTags = {
  sequence_after: [],
  conditional_on: null,
  negation: false,
  locus: null,
  role: 'primary',
  time_critical: false,
  time_window_minutes: null,
};

function normalizeAtom(raw: unknown, idx: number, atomCount: number): Atom | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const text = typeof r.text === 'string' ? r.text.trim() : '';
  if (!text) return null;
  const source_quote = typeof r.source_quote === 'string' ? r.source_quote : '';
  const rawTags = (r.tags && typeof r.tags === 'object') ? r.tags as Record<string, unknown> : {};
  // Sequence_after: filter out invalid indices (out-of-range, self-reference).
  const seq = Array.isArray(rawTags.sequence_after)
    ? rawTags.sequence_after.filter((n): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n < atomCount && n !== idx)
    : [];
  let cond: AtomTags['conditional_on'] = null;
  if (rawTags.conditional_on && typeof rawTags.conditional_on === 'object') {
    const co = rawTags.conditional_on as Record<string, unknown>;
    const ct = typeof co.condition_type === 'string' ? co.condition_type : '';
    const txt = typeof co.condition_text === 'string' ? co.condition_text : '';
    if (ct && txt) cond = { condition_type: ct, condition_text: txt };
  }
  const locusVal = rawTags.locus;
  const locus: AtomTags['locus'] = (locusVal === 'local_only' || locusVal === 'transfer_only') ? locusVal : null;
  const roleVal = rawTags.role;
  const role: AtomTags['role'] = roleVal === 'contingency' ? 'contingency' : 'primary';
  const time_critical = rawTags.time_critical === true;
  const twm = rawTags.time_window_minutes;
  const time_window_minutes = (typeof twm === 'number' && Number.isFinite(twm) && twm >= 0) ? twm : null;
  return {
    text,
    source_quote,
    tags: { ...DEFAULT_TAGS, sequence_after: seq, conditional_on: cond, negation: rawTags.negation === true, locus, role, time_critical, time_window_minutes },
  };
}

async function extractAtoms(actionTrace: string): Promise<Atom[]> {
  if (!ANTHROPIC_API_KEY) throw new Error('Missing env: ANTHROPIC_API_KEY');
  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model:      PARSER_MODEL,
      // 4000 (was 2500). Long polytrauma plans push Sonnet's structured-atom
      // output to ~2000+ tokens; the prior 2500 cap left only ~25% headroom
      // and a denser case could truncate mid-JSON. 4000 gives comfortable
      // margin without meaningful latency cost.
      max_tokens: 4000,
      system:     EXTRACTION_STRUCTURED_PROMPT,
      messages:   [{ role: 'user', content: `Extract atomic actions from this trace:\n"${actionTrace}"` }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic HTTP ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const raw = (data.content?.[0]?.text ?? '').trim();
  const stripped = raw.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
  const parsed = JSON.parse(stripped);
  if (!Array.isArray(parsed)) throw new Error('Parser did not return a JSON array');
  const atomCount = parsed.length;
  const atoms: Atom[] = [];
  for (let i = 0; i < parsed.length; i++) {
    const a = normalizeAtom(parsed[i], i, atomCount);
    if (a) atoms.push(a);
  }
  return atoms;
}

// ── Handler ───────────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  // CORS preflight
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });

  if (req.method !== 'POST') {
    return jsonResponse({ error: 'method not allowed' }, 405);
  }

  // ABUSE-BOUND 2: rate limit per client IP (global via rate_limit_hits table)
  const ip = getClientIP(req);
  if (await isRateLimited('parse-actions:' + ip, RATE_LIMIT_MAX, RATE_LIMIT_WIN_MS)) {
    return jsonResponse({ error: 'rate limit exceeded, retry shortly' }, 429);
  }

  // Parse body. `mode` is accepted for back-compat with older clients still
  // sending it, but it is no longer required and is not used in extraction —
  // the decision-mode selector was removed pre-pilot (it primed surgeons and
  // had no downstream consumer in scoring/union/judge).
  let body: { action_trace?: unknown };
  try { body = await req.json(); }
  catch { return jsonResponse({ error: 'invalid JSON body' }, 400); }

  const actionTrace = typeof body.action_trace === 'string' ? body.action_trace : '';

  if (!actionTrace.trim()) return jsonResponse({ error: 'action_trace required' }, 400);

  // ABUSE-BOUND 1: input cap (chars, not tokens — char is a cheap deterministic proxy)
  if (actionTrace.length > INPUT_CAP_CHARS) {
    return jsonResponse(
      { error: `action_trace too long: ${actionTrace.length} chars exceeds cap of ${INPUT_CAP_CHARS}` },
      413,
    );
  }

  // Extract via Sonnet (quality-pinned: these atoms become H_c ground truth)
  try {
    const atoms = await extractAtoms(actionTrace);
    return jsonResponse({ atoms });
  } catch (err) {
    return jsonResponse({ error: (err as Error).message }, 502);
  }
});
