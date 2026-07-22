// transcribe-audio — CONSUMER-TIER Edge Function.
//
// Called from the consultant + architect browsers (p1Dictate / archDictate in
// index.html) to transcribe a captured audio blob via Groq Whisper. Replaces
// a previous browser-side direct call to api.groq.com that exposed the
// GROQ_API_KEY as a client-side JavaScript constant.
//
// SECURITY MODEL — adapted from parse-actions for a binary upload surface:
//   1. INPUT CAP   — 10 MB upload (audio blob); typical clip is < 1 MB
//   2. RATE LIMIT  — 60 req/min per client IP (transcription is fast and
//                     consultants generate multiple dictations per case)
//   3. MODEL CHOICE — whisper-large-v3 + temperature=0 + language=en
//                     (anti-hallucination params set SERVER-SIDE so the
//                     browser cannot weaken or override them)
//   4. SPEND CAP   — Groq account-level monthly cap, set in console
//
// What stays in the browser: the short-clip guard (MIN_DICTATION_MS /
// MIN_DICTATION_BYTES) and the Whisper-hallucination denylist. Those are
// UI-level — the architect sees an inline "clip too short" notice without
// us needing to round-trip to the Edge Function. Defense-in-depth: even if
// the browser-side guards are bypassed (e.g. someone forges a request with
// curl), the temperature=0 / language=en params here remain enforced, the
// rate limit kicks in, and the input cap stops floods of tiny silent files.

import { CORS_HEADERS, jsonResponse, getClientIP } from '../_shared/cors.ts';
import { isRateLimited } from '../_shared/rate-limit.ts';

const GROQ_API_KEY      = Deno.env.get('GROQ_API_KEY');
const GROQ_URL          = 'https://api.groq.com/openai/v1/audio/transcriptions';
const MODEL             = 'whisper-large-v3';
const MAX_BYTES         = 10 * 1024 * 1024;  // ABUSE-BOUND 1: 10 MB
const RATE_LIMIT_MAX    = 60;                // ABUSE-BOUND 2
const RATE_LIMIT_WIN_MS = 60_000;

async function transcribe(file: File): Promise<string> {
  if (!GROQ_API_KEY) throw new Error('Missing env: GROQ_API_KEY');
  const fwd = new FormData();
  fwd.append('file', file, file.name || 'audio.webm');
  fwd.append('model', MODEL);
  fwd.append('response_format', 'json');
  // Anti-hallucination params — set server-side so the browser cannot weaken
  // them. temperature=0 → greedy decoding; language=en → pin to English.
  fwd.append('temperature', '0');
  fwd.append('language', 'en');
  const res = await fetch(GROQ_URL, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + GROQ_API_KEY },
    body: fwd,
  });
  if (!res.ok) throw new Error(`Groq HTTP ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return (data.text ?? '').toString();
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== 'POST') return jsonResponse({ error: 'method not allowed' }, 405);

  const ip = getClientIP(req);
  if (await isRateLimited('transcribe-audio:' + ip, RATE_LIMIT_MAX, RATE_LIMIT_WIN_MS)) {
    return jsonResponse({ error: 'rate limit exceeded, retry shortly' }, 429);
  }

  // Cheap pre-check on Content-Length before we even read the body. This stops
  // a malicious 1 GB upload from blowing memory before we get to file.size.
  const contentLength = parseInt(req.headers.get('content-length') ?? '0', 10);
  if (contentLength > MAX_BYTES) {
    return jsonResponse(
      { error: `audio too large: ${contentLength} bytes exceeds cap of ${MAX_BYTES}` },
      413,
    );
  }

  let form: FormData;
  try { form = await req.formData(); }
  catch { return jsonResponse({ error: 'invalid multipart body' }, 400); }

  const file = form.get('file');
  if (!(file instanceof File)) return jsonResponse({ error: 'file field required' }, 400);
  if (file.size === 0) return jsonResponse({ error: 'empty audio file' }, 400);
  if (file.size > MAX_BYTES) {
    return jsonResponse(
      { error: `audio too large: ${file.size} bytes exceeds cap of ${MAX_BYTES}` },
      413,
    );
  }

  try {
    const text = await transcribe(file);
    return jsonResponse({ text });
  } catch (err) {
    return jsonResponse({ error: (err as Error).message }, 502);
  }
});
