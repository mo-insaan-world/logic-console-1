// providers.ts — model provider adapter for ICAT-R benchmark.
// Four request shapes cover all five providers. Never throws — returns
// { text, finish_reason, usage, error }. finish_reason + usage are stored
// on model_responses so we can distinguish truncated runs (finish_reason
// in {'length','max_tokens','MAX_TOKENS'}) from genuine stops. Critical
// for reasoning models, whose hidden reasoning_tokens consume the same
// visible-output budget.

export type ProviderShape = 'anthropic' | 'openai-compatible' | 'gemini' | 'reasoning';

export interface ModelRegistryEntry {
  shape: ProviderShape;
  baseURL?: string;
  keyEnvVar: string;
  modelString: string;
  // sendTemperature: whether to include the temperature field in the request body.
  // false → the model runs at provider-default sampling (relevant for benchmark
  // reproducibility documentation: any model with sendTemperature=false is not
  // pinned to temperature 0 and may show run-to-run variability).
  // Currently false for Anthropic (Opus 4.7 deprecated the parameter), OpenAI
  // gpt-5.5 (rejects temperature: 0), and DeepSeek v4-pro (ignores it for
  // reasoning). xAI grok-4.3 accepts temperature: 0 even though it surfaces
  // reasoning_tokens, so it stays sendTemperature: true — orthogonal to shape.
  sendTemperature: boolean;
  // Reasoning-shape only:
  // tokenCapField — OpenAI gpt-5 series rejects 'max_tokens' and requires
  // 'max_completion_tokens'; DeepSeek's OpenAI-compatible endpoint accepts
  // 'max_tokens'. Default 'max_tokens' for non-reasoning shapes.
  tokenCapField?: 'max_tokens' | 'max_completion_tokens';
  // tokenCap — reasoning models need a much larger visible-output budget
  // because hidden reasoning_tokens are billed against the same cap.
  // Default 2000 for non-reasoning shapes.
  tokenCap?: number;
}

export const MODEL_REGISTRY: Record<string, ModelRegistryEntry> = {
  // Opus 4.7 hits the prior 2000 cap on the SOW positive control (4894-char
  // mid-flow output, finish_reason: max_tokens). Raised to match the new
  // reasoning-shape budget. tokenCap applies inside the anthropic branch via
  // `entry.tokenCap ?? 2000` — keeps non-reasoning shapes backwards-safe.
  anthropic: { shape: 'anthropic',         keyEnvVar: 'ANTHROPIC_API_KEY', modelString: 'claude-opus-4-7',         sendTemperature: false, tokenCap: 8000 },
  // gemini-3.5-flash (current-generation production default; replaced
  // gemini-2.5-pro 2026-05-29 because 2.5-pro's per-minute RPM ceiling
  // ~150 was insufficient for the K=5 ensemble burst at typical decision
  // counts — 3.5-flash carries ~1000 RPM on the same tier, comfortably
  // above the K=5 × n_decisions fan-out). Wire shape stays 'gemini' —
  // Google's contents/parts/generationConfig schema is unchanged across
  // versions. tokenCap 8000 kept conservative; 3.5-flash's visible-output
  // budget is not constrained by hidden-thinking like 2.5-pro was, so this
  // cap is generous rather than tight. sendTemperature: false retained
  // for reproducibility documentation parity with the other reasoning-tier
  // entries. thinking_level config knob is left at default; tune that
  // surface if post-switch judge votes look qualitatively under-reasoned.
  gemini:    { shape: 'gemini',            keyEnvVar: 'GOOGLE_API_KEY',                                            modelString: 'gemini-3.5-flash',  sendTemperature: false,                                         tokenCap: 8000  },
  // grok-4.3 surfaces reasoning_tokens (314 of 535 visible-output tokens
  // on the SOW positive control). On the implicit 2000 cap of the prior
  // openai-compatible shape, longer cases would silently truncate. Same
  // wire shape as openai-compatible — only the explicit tokenCap and
  // shape label change. temperature: 0 still works on grok, so
  // sendTemperature stays true.
  xai:       { shape: 'reasoning',         baseURL: 'https://api.x.ai/v1',         keyEnvVar: 'XAI_API_KEY',      modelString: 'grok-4.3',          sendTemperature: true,  tokenCapField: 'max_tokens',            tokenCap: 8000  },
  openai:    { shape: 'reasoning',         baseURL: 'https://api.openai.com/v1',   keyEnvVar: 'OPENAI_API_KEY',   modelString: 'gpt-5.5',           sendTemperature: false, tokenCapField: 'max_completion_tokens', tokenCap: 16000 },
  deepseek:  { shape: 'reasoning',         baseURL: 'https://api.deepseek.com/v1', keyEnvVar: 'DEEPSEEK_API_KEY', modelString: 'deepseek-v4-pro',   sendTemperature: false, tokenCapField: 'max_tokens',            tokenCap: 8000  },
};

// ── Phase 2 generation lineup — DECOUPLED from MODEL_REGISTRY ────────────────
// The fixed, canonical THREE models a surgeon rates in Phase 2, IDENTICAL on
// every case. Deliberately separate from MODEL_REGISTRY: gemini/openai/xai in
// the registry also drive the presence-judge ensemble + dispute classifier
// (score-responses), so the generation set must NOT be read off the same
// strings — bumping a generation model must never move a judge. Wire shape /
// API key / token cap still come from MODEL_REGISTRY[provider]; only the model
// snapshot string is overridden here. Pinned snapshots (no floating "latest")
// for reproducible provenance; the exact resolved id is recorded per row in
// model_responses.model_snapshot at generation time.
//   anthropic → Claude Fable 5
//   openai    → GPT-5.6 Sol
//   gemini    → Gemini 3.1 Pro (the API id is the `-preview` suffix; bare
//               `gemini-3.1-pro` 404s — only `gemini-3.1-pro-preview` exists.
//               NB: there is no 3.5 Pro — the 3.5 family is Flash-only — and
//               3-pro-preview is deprecated, so 3.1 Pro remains the pin.)
export const PHASE2_GEN_MODELS: Record<string, string> = {
  anthropic: 'claude-fable-5',
  openai:    'gpt-5.6-sol',
  gemini:    'gemini-3.1-pro-preview',
};

// The canonical Phase 2 provider lineup. Single source of truth for both the
// generation orchestrator (auto-build-union) and the serving allowlist
// (phase2-model-outputs) so the set is identical on every case — exactly these
// three, no 4th/5th.
export const PHASE2_PROVIDERS = ['anthropic', 'openai', 'gemini'] as const;

export interface CallModelResult {
  text: string | null;
  finish_reason: string | null;
  usage: unknown | null;
  error: string | null;
  model: string | null;   // served model id from the API response (provenance)
}

function err(msg: string): CallModelResult {
  return { text: null, finish_reason: null, usage: null, error: msg, model: null };
}

export async function callModel(
  provider: string,
  modelString: string,
  prompt: string,
  temperature = 0,
): Promise<CallModelResult> {
  const entry = MODEL_REGISTRY[provider];
  if (!entry) return err(`Unknown provider: ${provider}`);

  const apiKey = Deno.env.get(entry.keyEnvVar);
  if (!apiKey) return err(`Missing env: ${entry.keyEnvVar}`);

  try {
    if (entry.shape === 'anthropic') {
      const payload: Record<string, unknown> = {
        model: modelString,
        max_tokens: entry.tokenCap ?? 2000,
        messages: [{ role: 'user', content: prompt }],
      };
      if (entry.sendTemperature) payload.temperature = temperature;
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(payload),
      });
      if (!res.ok) return err(`Anthropic HTTP ${res.status}: ${await res.text()}`);
      const data = await res.json();
      // Reasoning models (Fable 5) return a `thinking` block as content[0] and
      // the visible answer in a later `text` block — scan for the text block
      // rather than assuming content[0]. Falls back to content[0].text for
      // non-thinking models whose sole block is text.
      const text = (Array.isArray(data.content)
        ? data.content.find((b: any) => b?.type === 'text')?.text
        : null) ?? data.content?.[0]?.text ?? null;
      return {
        text,
        finish_reason: data.stop_reason ?? null,
        usage: data.usage ?? null,
        error: text ? null : 'No text in Anthropic response: ' + JSON.stringify(data).slice(0, 500),
        model: data.model ?? null,
      };
    }

    if (entry.shape === 'openai-compatible' || entry.shape === 'reasoning') {
      // Shared OpenAI-API chat-completions wire shape.
      // reasoning: OpenAI gpt-5.5, DeepSeek v4-pro, xAI grok-4.3 — per-entry
      // overrides for the token-cap field name and a much larger budget so
      // hidden reasoning_tokens don't starve visible output.
      // openai-compatible: kept as a distinct shape for future non-reasoning
      // OpenAI-API providers; no MODEL_REGISTRY entry uses it today.
      const tokenCapField = entry.tokenCapField ?? 'max_tokens';
      const tokenCap = entry.tokenCap ?? 2000;
      const payload: Record<string, unknown> = {
        model: modelString,
        messages: [{ role: 'user', content: prompt }],
        [tokenCapField]: tokenCap,
      };
      if (entry.sendTemperature) payload.temperature = temperature;
      const res = await fetch(`${entry.baseURL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + apiKey,
        },
        body: JSON.stringify(payload),
      });
      if (!res.ok) return err(`${provider} HTTP ${res.status}: ${await res.text()}`);
      const data = await res.json();
      const choice = data.choices?.[0];
      const text = choice?.message?.content ?? null;
      return {
        text,
        finish_reason: choice?.finish_reason ?? null,
        usage: data.usage ?? null,
        error: text ? null : `No text in ${entry.shape} response: ` + JSON.stringify(data).slice(0, 500),
        model: data.model ?? null,
      };
    }

    if (entry.shape === 'gemini') {
      const generationConfig: Record<string, unknown> = { maxOutputTokens: entry.tokenCap ?? 2000 };
      if (entry.sendTemperature) generationConfig.temperature = temperature;
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelString}:generateContent?key=${apiKey}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig,
        }),
      });
      if (!res.ok) return err(`Gemini HTTP ${res.status}: ${await res.text()}`);
      const data = await res.json();
      const candidate = data.candidates?.[0];
      const text = candidate?.content?.parts?.[0]?.text ?? null;
      return {
        text,
        finish_reason: candidate?.finishReason ?? null,
        usage: data.usageMetadata ?? null,
        error: text ? null : 'No text in Gemini response: ' + JSON.stringify(data).slice(0, 500),
        model: data.modelVersion ?? null,
      };
    }

    return err(`Unhandled shape: ${(entry as ModelRegistryEntry).shape}`);
  } catch (e) {
    return err((e as Error).message);
  }
}
