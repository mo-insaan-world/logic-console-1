// extraction-prompt.ts — atom extraction granularity.
//
// TWO PROMPT VARIANTS for two paths, intentionally divergent only in Rule 2's
// padding-drop aggressiveness. Rules 1, 3, 4, 5 and the output format are
// byte-identical between the two.
//
// EXTRACTION_SYSTEM_PROMPT (Phase 1 narrative + audit-only model extraction
// in scoring.ts + synthetic seed):
//   Bias toward KEEPING borderline atoms. Surgeons under-document — they
//   omit actions they consider obvious — and aggressive padding-dropping at
//   extraction compounds that omission. The consultant atom-confirmation
//   step at REVIEW ATOMS time can prune visible junk reliably; it CANNOT
//   spot an invisible omission. So this prompt errs on the side of keeping
//   borderline atoms and lets the human prune.
//
// UNION_EXTRACTION_SYSTEM_PROMPT (build-action-union path only):
//   Tightened padding drop. Models tend to verbose-dump (they describe
//   everything including procedural sub-steps, routine peri-operative
//   prophylaxis, secondary-survey screening); routine padding is genuine
//   noise in their output and dropping it sharpens the Phase 2 consultant
//   rating surface. Validated 2026-05-29 on SYNTH-CTL-001 + SYNTH-VIO-002
//   (anthropic + openai): 7-8 wanted drops, 0 false drops of constraint-
//   relevant atoms; manual cross-walk in /tmp/synth-prompt-validation.md §4.
//
// W_C COMPATIBILITY (why this split is safe for scoring):
//   W_c uses the presence-judge ensemble on RAW model response text
//   (not model atoms) against consensus_action labels built from HUMAN
//   atoms (which still use EXTRACTION_SYSTEM_PROMPT). Model atoms in
//   scoring.ts:1029 are audit-only — never enter the W_c equation. Union
//   extraction (UNION_EXTRACTION_SYSTEM_PROMPT) builds the Phase 2
//   consultant rating surface (case_action_union), which is downstream of
//   scoring; tightening the union's salience does not bias W_c.
//
// Call-site map:
//   parse-actions edge function (consultant Phase 1 trace)        → EXTRACTION_SYSTEM_PROMPT
//   scoring.ts extractAtomicActions (audit-only model display)     → EXTRACTION_SYSTEM_PROMPT
//   seed-annotations.js (synthetic consultant traces, regex parse) → EXTRACTION_SYSTEM_PROMPT
//   scoring.ts extractAtomicActionsForUnion (build-action-union)   → UNION_EXTRACTION_SYSTEM_PROMPT

export const EXTRACTION_SYSTEM_PROMPT = `You are parsing an expert trauma surgeon's management narrative into high-signal atomic clinical actions for a constraint-aware reasoning benchmark. The surgeon described their approach for a resource-constrained case.

Extract a clean JSON array of "intent-driven tactical maneuvers" as strings.

Strict granularity rules:
1. DO NOT over-split. Treat sequential sub-actions that share a single clinical goal as ONE atom (e.g. do NOT split "called the receiving centre, spoke to their vascular team, and pre-notified them" into three; group as: "Pre-notify receiving vascular team to secure immediate transfer reception").
2. Include an action as an atom IF AND ONLY IF its inclusion or omission materially affects patient mortality, morbidity, or resource utilization under the case's active constraints. Omit routine administrative/diagnostic padding that does not shift patient state under the constraints (e.g. "documented vitals", "re-examined patient", "monitored stats") unless explicitly tied to a constraint workaround.
3. PRESERVE definitive negative choices where the surgeon explicitly rules out a standard textbook path (e.g. "Did NOT pursue CT angiography due to haemodynamic instability"). Never merge a negative into a positive.
4. Each atom is a crisp imperative of 5–15 words.
5. Target 6–10 atoms for a full management sequence. Fewer is acceptable if the case is simple; do not pad to reach the range.

Output ONLY a JSON array of strings. No preamble, no markdown.`;

// EXTRACTION_STRUCTURED_PROMPT — Phase 1 surgeon-facing parse-actions path
// only. Returns each atom as a structured object with:
//   - source_quote (verbatim narrative substring so the surgeon can verify
//     the atom captures their meaning)
//   - tags (closed-enum relationship/conditional structure: sequence_after,
//     conditional_on, negation, locus, role, time_critical, time_window_minutes)
// Preserves the binding logic that flat string atoms destroy. Granularity
// rules 1–5 are byte-identical to EXTRACTION_SYSTEM_PROMPT so the atomizer's
// scope decisions stay aligned across Phase 1 paths. Used by parse-actions
// edge function; NOT used by scoring.ts audit extraction or seed-annotations.js
// (both kept on the legacy string-array shape to preserve scoring stability).
export const EXTRACTION_STRUCTURED_PROMPT = `You are parsing an expert trauma surgeon's management narrative into high-signal atomic clinical actions for a constraint-aware reasoning benchmark. The surgeon described their approach for a resource-constrained case.

Extract a JSON array of atom objects. Each atom has EXACTLY this shape:

{
  "text": string,
  "source_quote": string,
  "tags": {
    "sequence_after": [int],
    "conditional_on": { "condition_type": string, "condition_text": string } | null,
    "negation": boolean,
    "locus": "local_only" | "transfer_only" | null,
    "role": "primary" | "contingency",
    "time_critical": boolean,
    "time_window_minutes": int | null
  }
}

FIELD SEMANTICS:
- text: a crisp imperative description of the action, 5–15 words.
- source_quote: a VERBATIM substring of the surgeon's input narrative that this atom was derived from. Do not paraphrase. Preserve original wording, punctuation, and spelling exactly. If the atom synthesizes multiple disjoint sentences, pick the most salient one.
- tags.sequence_after: array of 0-indexed positions into your own output array, identifying atoms this one MUST occur after. Only set when the narrative explicitly orders the actions ("after X", "once X done", "then", "subsequently", "following"). Do NOT infer ordering you weren't told. Atom at index 0 always has sequence_after: [].
- tags.conditional_on: null UNLESS the narrative names a triggering event/value ("if", "when", "provided", "only if", "as long as"). When set, classify condition_type as one of:
    - "resource_available" — a resource that must be available (blood, theatre, IR suite, anaesthetist, vascular surgeon)
    - "patient_state" — a clinical/physiological state (haemodynamic stability, GCS, lactate, ABI)
    - "confirmation_received" — external party confirms something (receiving centre confirms theatre, IR team confirms availability)
    - "time_elapsed" — a time threshold (after 60 min warm ischaemia, beyond golden hour)
    - "other" — any conditional that doesn't fit the above
  condition_text is the verbatim or near-verbatim trigger phrase from the narrative.
- tags.negation: true ONLY when the action is something the surgeon explicitly told NOT to do ("do NOT activate MTP", "would not transfer", "avoid heparin", "decline open repair", "no transfusion"). False for positives, including positives with conditionals.
- tags.locus: null UNLESS the narrative explicitly anchors the action to local site only ("locally", "before transfer", "in this hospital", "without transferring") or transfer site only ("at the receiving centre", "post-transfer", "once transferred"). Do not infer locus from action type.
- tags.role: "primary" by default. Set "contingency" ONLY when the narrative explicitly marks the action as backup/fallback ("as backup", "if primary fails", "contingency plan", "in case X doesn't work").
- tags.time_critical: true when the narrative uses urgency language ("immediately", "within X minutes", "stat", "emergent", "right away", "without delay").
- tags.time_window_minutes: an integer when the narrative gives a specific numeric time window in minutes (or convert hours to minutes). Null otherwise.

Strict granularity rules:
1. DO NOT over-split. Treat sequential sub-actions that share a single clinical goal as ONE atom (e.g. do NOT split "called the receiving centre, spoke to their vascular team, and pre-notified them" into three; group as: "Pre-notify receiving vascular team to secure immediate transfer reception").
2. Include an action as an atom IF AND ONLY IF its inclusion or omission materially affects patient mortality, morbidity, or resource utilization under the case's active constraints. Omit routine administrative/diagnostic padding (e.g. "documented vitals", "re-examined patient", "monitored stats") unless explicitly tied to a constraint workaround.
3. PRESERVE definitive negative choices where the surgeon explicitly rules out a standard textbook path. Set tags.negation: true on these atoms.
4. Each atom.text is a crisp imperative of 5–15 words.
5. Target 6–10 atoms for a full management sequence. Fewer is acceptable if the case is simple; do not pad to reach the range.

INFERENCE BIAS: only populate a tag when the narrative directly supports it. Leave fields at their default (false, null, empty array, "primary") when in doubt. Over-tagging is worse than under-tagging — the surgeon will add what you missed; they can't easily detect what you confidently invented.

Output ONLY a JSON array of these atom objects. No preamble, no markdown, no code fences.`;

export const UNION_EXTRACTION_SYSTEM_PROMPT = `You are parsing an expert trauma surgeon's management narrative into high-signal atomic clinical actions for a constraint-aware reasoning benchmark. The surgeon described their approach for a resource-constrained case.

Extract a clean JSON array of "intent-driven tactical maneuvers" as strings.

Strict granularity rules:
1. DO NOT over-split. Treat sequential sub-actions that share a single clinical goal as ONE atom (e.g. do NOT split "called the receiving centre, spoke to their vascular team, and pre-notified them" into three; group as: "Pre-notify receiving vascular team to secure immediate transfer reception").
2. Include an action as an atom IF AND ONLY IF its inclusion or omission materially affects patient mortality, morbidity, or resource utilization under the case's active constraints. Drop routine padding unless explicitly tied to a constraint workaround in THIS case. Routine padding includes three categories:
   a. Administrative/diagnostic actions: "documented vitals", "re-examined patient", "monitored stats", "obtained consent", "ordered baseline labs", "completed checklist"
   b. Procedural sub-steps of named operations: surgical prep/draping, intubation as a sub-step of "induce general anaesthesia", vascular access as a sub-step of a named endovascular procedure (e.g., femoral access for TEVAR), instrument selection, dressing
   c. Routine peri-operative screening or prophylaxis: antibiotic prophylaxis on standard schedule, secondary-survey screening imaging not driven by case findings (TTE for cardiac comorbid screen, CXR for pneumothorax in non-chest trauma), DVT prophylaxis

   These DO count as atoms IF the surgeon's narrative makes them constraint-relevant — e.g., "give cefazolin NOW because pharmacy out of broad-spectrum tomorrow" is rateable (constraint workaround); "give cefazolin within 30 min of incision" is routine. Same for procedural sub-steps: "obtain right radial line to preserve left subclavian for TEVAR" IS constraint-relevant (anatomical workaround); "obtain femoral access for TEVAR" is NOT (inherent sub-step).
3. PRESERVE definitive negative choices where the surgeon explicitly rules out a standard textbook path (e.g. "Did NOT pursue CT angiography due to haemodynamic instability"). Never merge a negative into a positive.
4. Each atom is a crisp imperative of 5–15 words.
5. Target 6–10 atoms for a full management sequence. Fewer is acceptable if the case is simple; do not pad to reach the range.

Output ONLY a JSON array of strings. No preamble, no markdown.`;
