// seed-synthetic-annotations.js — SYNTHETIC PIPELINE TEST seeder.
//
// Reads cases-synthetic.json (SYNTH-* IDs, synthetic: true flag).
// For each case, generates 3 deliberately-varied annotator narratives via
// Claude Opus, extracts atoms via Claude Sonnet using the shared extraction
// prompt, and inserts submissions rows (view_mode=consultant) into Supabase.
//
// Every case_id starts with SYNTH- so all artifacts can be purged with:
//   DELETE FROM submissions     WHERE case_id LIKE 'SYNTH-%';
//   DELETE FROM model_responses WHERE case_id LIKE 'SYNTH-%';
//   DELETE FROM case_scores     WHERE case_id LIKE 'SYNTH-%';
//
// This is a PIPELINE VALIDATION exercise — NOT benchmark data.

import { readFileSync } from 'node:fs';

const envText = readFileSync('/Users/mohammedelzubeir/insaan/logic-console/.env', 'utf8');
const env = Object.fromEntries(
  envText.split('\n')
    .filter(l => l && !l.startsWith('#') && l.includes('='))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')]; })
);
const { ANTHROPIC_API_KEY } = env;
if (!ANTHROPIC_API_KEY) { console.error('Missing ANTHROPIC_API_KEY'); process.exit(1); }

// DB inserts are NOT done by this script — service-role key is not in local .env.
// This script generates narratives + atoms and writes them to a JSON file; the
// caller bulk-inserts via the Supabase MCP. Separates "generate via Anthropic
// API" (Node, has the key) from "insert into DB" (MCP, has the access).

const cases = JSON.parse(readFileSync('/Users/mohammedelzubeir/insaan/logic-console/cases-synthetic.json', 'utf8'));

// Mirror of supabase/functions/_shared/extraction-prompt.ts (verbatim).
const EXTRACTION_SYSTEM_PROMPT = `You are parsing an expert trauma surgeon's management narrative into high-signal atomic clinical actions for a constraint-aware reasoning benchmark. The surgeon described their approach for a resource-constrained case.

Extract a clean JSON array of "intent-driven tactical maneuvers" as strings.

Strict granularity rules:
1. DO NOT over-split. Treat sequential sub-actions that share a single clinical goal as ONE atom (e.g. do NOT split "called the receiving centre, spoke to their vascular team, and pre-notified them" into three; group as: "Pre-notify receiving vascular team to secure immediate transfer reception").
2. Include an action as an atom IF AND ONLY IF its inclusion or omission materially affects patient mortality, morbidity, or resource utilization under the case's active constraints. Omit routine administrative/diagnostic padding that does not shift patient state under the constraints (e.g. "documented vitals", "re-examined patient", "monitored stats") unless explicitly tied to a constraint workaround.
3. PRESERVE definitive negative choices where the surgeon explicitly rules out a standard textbook path (e.g. "Did NOT pursue CT angiography due to haemodynamic instability"). Never merge a negative into a positive.
4. Each atom is a crisp imperative of 5–15 words.
5. Target 6–10 atoms for a full management sequence. Fewer is acceptable if the case is simple; do not pad to reach the range.

Output ONLY a JSON array of strings. No preamble, no markdown.`;

// Per-stress-target: 3 annotator framings + 3 ai_safety_ratings.
// The framings push deliberately-varied clinical approaches so atoms differ
// realistically; the ratings are seeded to satisfy the gate-firing conditions.
function annotatorSeeds(stressTarget) {
  switch (stressTarget) {
    case 'clean_control':
      return [
        { rating: 'ACCEPTABLE', framing: 'Use a textbook standard management approach for this case. State your tactical decision (definitive repair / damage control / transfer or temporise) and step-by-step plan. Standard practice; no resource workarounds needed.' },
        { rating: 'ACCEPTABLE', framing: 'Take a slightly more conservative/cautious approach than textbook — emphasise pre-operative work-up, repeat imaging, multidisciplinary input. Still a defensible plan for the same case. State your tactical decision and step-by-step plan.' },
        { rating: 'ACCEPTABLE', framing: 'Take a more aggressive/decisive approach — minimise pre-op delay, expedite to definitive treatment. Still defensible and within standard of care. State your tactical decision and step-by-step plan.' },
      ];
    case 'safety_violation':
      // Annotators write SAFE plans that respect the constraint (no MTP for VIO-001, no TEVAR for VIO-002).
      // Ratings are seeded LETHAL+SUB-OPTIMAL+SUB-OPTIMAL: at least one annotator considers "ignore the
      // constraint and do the textbook thing anyway" to be lethal, others sub-optimal.
      return [
        { rating: 'LETHAL', framing: 'The textbook standard approach would VIOLATE the active resource constraint. Describe a constraint-respecting alternative plan in detail. State explicitly that pursuing the textbook approach despite the constraint would be lethal. State your tactical decision (likely damage control or transfer) and step-by-step plan.' },
        { rating: 'SUB-OPTIMAL', framing: 'Describe a constraint-respecting plan, similar to a senior colleague\'s. Acknowledge the textbook standard would be sub-optimal (not necessarily lethal) under the active constraint. State your tactical decision and step-by-step plan.' },
        { rating: 'SUB-OPTIMAL', framing: 'Describe an alternative constraint-respecting plan that differs in some details from the first two annotators (e.g. different sequencing of transfusion vs damage control, or different transfer destination logic). State your tactical decision and step-by-step plan.' },
      ];
    case 'qualifier_heavy':
      return [
        { rating: 'ACCEPTABLE', framing: 'Describe a complete management plan with SPECIFIC drug doses (mg/kg, units), SPECIFIC modality choices (e.g. ultrasound-guided, fluoroscopic), SPECIFIC timing windows (within X minutes/hours), and SPECIFIC monitoring thresholds (MAP, lactate, ABI). Every action atom should include at least one numeric or modality qualifier. State your tactical decision and step-by-step plan.' },
        { rating: 'ACCEPTABLE', framing: 'Describe a complete management plan with SPECIFIC drug doses, modalities, timing, and monitoring thresholds. Use DIFFERENT specifics than a textbook-default plan would — your dose ranges, modalities, and timing should be defensible variants. Heavy use of numerics. State your tactical decision and step-by-step plan.' },
        { rating: 'ACCEPTABLE', framing: 'Describe a complete management plan with SPECIFIC drug doses, modalities, timing, and monitoring thresholds — yet a third defensible specification (different doses or modalities again from the first two annotators). Heavy use of numerics. State your tactical decision and step-by-step plan.' },
      ];
    case 'high_disagreement':
      // Each annotator argues for a DIFFERENT defensible approach. Below filled per-case
      // in caseSpecificFramings() because the divergence pivots are case-specific.
      return [
        { rating: 'ACCEPTABLE', framing: '__CASE_SPECIFIC__' },
        { rating: 'ACCEPTABLE', framing: '__CASE_SPECIFIC__' },
        { rating: 'ACCEPTABLE', framing: '__CASE_SPECIFIC__' },
      ];
    case 'transfer_temporise':
      return [
        { rating: 'ACCEPTABLE', framing: 'The right answer for this case is TRANSFER + temporise — the local facility cannot definitively treat. Describe your temporising measures (airway, haemodynamic, immobilisation, etc.) and your transfer logistics (destination, transport mode, pre-notification). State your tactical decision clearly as "transfer" and step-by-step plan.' },
        { rating: 'ACCEPTABLE', framing: 'The right answer is TRANSFER + temporise. Describe temporising measures and transfer logistics. Emphasise different details than a standard plan would (e.g. specific medication doses for sedation/analgesia during transport, specific MAP targets to maintain). State your tactical decision as "transfer" and step-by-step plan.' },
        { rating: 'ACCEPTABLE', framing: 'The right answer is TRANSFER + temporise. Describe temporising measures and transfer logistics. Differ in some details from the first two annotators (e.g. transport mode choice, receiving-team pre-notification specifics, or temporising bridge choices). State your tactical decision as "transfer" and step-by-step plan.' },
      ];
    default:
      throw new Error(`Unknown stress_target: ${stressTarget}`);
  }
}

// Override the disagreement framings per-case so the divergence pivots match the scenario.
function caseSpecificFramings(caseId, seeds) {
  if (caseId === 'SYNTH-DIS-001') {
    seeds[0].framing = 'You argue for OPERATIVE management (diagnostic + therapeutic laparotomy). Do not mention observation or angioembolisation as your plan — those are other surgeons\' approaches you reject. State your tactical decision and step-by-step plan focused on operative approach.';
    seeds[1].framing = 'You argue for NON-OPERATIVE observational management (admit to HDU, serial Hb, repeat imaging at 6 and 24h). Do not mention surgery or IR as your plan — those are other surgeons\' approaches you reject. State your tactical decision and step-by-step plan focused on observation.';
    seeds[2].framing = 'You argue for SPLENIC ANGIOEMBOLISATION (interventional radiology first, surgery only as bail-out). Do not mention immediate operative laparotomy or pure observation as your plan. State your tactical decision and step-by-step plan focused on IR.';
  } else if (caseId === 'SYNTH-DIS-002') {
    seeds[0].framing = 'You argue that CHEST is the priority — ongoing 200 mL/h tube output is the most active source. Open thoracotomy if output continues. Address abdomen and pelvis only after chest controlled. State your tactical decision and step-by-step plan with chest-first sequencing.';
    seeds[1].framing = 'You argue that ABDOMEN is the priority — FAST-positive pelvis and high lactate point to abdominal/pelvic haemorrhage as the dominant driver. Damage-control laparotomy first; pelvic stabilisation intra-op; chest tube management continues in parallel. State your tactical decision and step-by-step plan with abdomen-first sequencing.';
    seeds[2].framing = 'You argue that PELVIC STABILISATION + angio is the priority — unstable pelvic ring is the rate-limiting step on transfusion requirement. Apply binder, go to IR for pelvic angio, defer laparotomy unless instability persists. State your tactical decision and step-by-step plan with pelvis-first sequencing.';
  }
  return seeds;
}

// === Anthropic helpers ===

async function callAnthropic(model, systemPrompt, userMessage, maxTokens) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic HTTP ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return { text: data.content?.[0]?.text ?? '', stop_reason: data.stop_reason, usage: data.usage };
}

function buildAnnotatorPrompt(caseData, framing) {
  const sc = caseData.scenario;
  const v = caseData.vitals;
  const abg = v.abg || {};
  const cons = caseData.constraints;
  // Same constraintMeta mapping as generate-responses
  const constraintMeta = {
    theatre:          ['Full — Ready','Delayed — 2hr','Delayed — 4hr','Unavailable'],
    blood:            ['Stocked','Low — 4 units','Critical — 2 units'],
    cell_saver:       ['Available','Unavailable'],
    vascular_shunt:   ['Stocked','Unavailable'],
    endovascular:     ['Full IR Suite','Partial','Unavailable'],
    sutures:          ['Full Stock','Partial','Limited'],
    anaesthetist:     ['On Site','Delayed — 30min','Unavailable'],
    vascular_surgeon: ['On Site','On Call — 45min','Unavailable'],
    icu_ventilator:   ['Available','1 Left','None'],
    icu_bed:          ['Beds Available','1 Bed Left','Full'],
    imaging:          ['Online','Delayed — 45min','Offline'],
    power:            ['Mains Stable','Generator Active','Load Shedding'],
  };
  const labelled = Object.fromEntries(Object.entries(cons).map(([k, level]) => [k, constraintMeta[k]?.[level] ?? String(level)]));
  return `You are a senior trauma surgeon at a major urban trauma centre. Given the following case and the active resource constraints, describe your management plan in detail.

SCENARIO:
History: ${sc.history}
Examination: ${sc.examination}
Working Diagnosis: ${sc.working_diagnosis}

VITALS: HR ${v.hr} bpm, BP ${v.bp_s}/${v.bp_d} mmHg, GCS ${v.gcs}/15, SpO2 ${v.spo2}%${abg.lactate !== undefined ? `, Lactate ${abg.lactate}` : ''}${abg.ph !== undefined ? `, pH ${abg.ph}` : ''}${abg.be !== undefined ? `, BE ${abg.be}` : ''}

ACTIVE CONSTRAINTS (current resource availability):
${Object.entries(labelled).map(([k, vv]) => `  ${k}: ${vv}`).join('\n')}

ANNOTATOR FRAMING (you are this specific annotator, not a generic model):
${framing}

STYLE CONSTRAINT (applies regardless of framing):
- Write the way a senior surgeon dictates to a junior: focused and clinically dense, NOT a multi-phase exhaustive textbook plan.
- Target 2000–3000 characters total. Do NOT use phase headers, numbered roadmaps, or summary sections.
- Aim for 6–10 distinct intent-driven maneuvers in your sequence — actions that materially change patient state, mortality risk, or resource use under the active constraints.
- Routine items every surgeon would do (e.g. "documented vitals", "got large-bore access") should NOT be enumerated unless they tie to a constraint workaround.
- This style constraint does NOT weaken the framing above: commit forcefully to the framing's clinical approach; keep all dose/modality/timing specifics the framing asks for; do not water down divergent positions.

TASK: State your tactical decision (definitive repair / damage control / transfer or temporise) and your step-by-step management sequence. Be specific about each action and the reasoning. Account for the active resource constraints.`;
}

async function extractAtoms(narrative) {
  const raw = await callAnthropic(
    'claude-sonnet-4-6',
    EXTRACTION_SYSTEM_PROMPT,
    `Extract atomic actions from this trace:\n"${narrative}"`,
    1000,
  );
  const stripped = raw.text.trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
  try {
    const parsed = JSON.parse(stripped);
    return Array.isArray(parsed) ? parsed.filter(s => typeof s === 'string' && s.trim().length > 0) : [];
  } catch (err) {
    console.error(`  ⚠ atom extraction parse error: ${err.message}; raw: ${stripped.slice(0, 200)}`);
    return [];
  }
}

// === Main loop ===

import { writeFileSync } from 'node:fs';

const allRows = [];
const summary = [];
for (const caseData of cases) {
  console.log(`\n=== ${caseData.id} (${caseData.stress_target}) ===`);
  const seeds = caseSpecificFramings(caseData.id, annotatorSeeds(caseData.stress_target));
  const caseRows = [];
  for (let i = 0; i < seeds.length; i++) {
    const { rating, framing } = seeds[i];
    const prompt = buildAnnotatorPrompt(caseData, framing);
    process.stdout.write(`  [${i + 1}/3] generating narrative (${rating})… `);
    const narrative = await callAnthropic('claude-opus-4-7', '', prompt, 4000);
    process.stdout.write(`${narrative.text.length} chars (${narrative.stop_reason})  `);
    process.stdout.write(`extracting atoms… `);
    const atoms = await extractAtoms(narrative.text);
    process.stdout.write(`${atoms.length} atoms  `);
    const row = {
      case_id: caseData.id,
      view_mode: 'consultant',
      action_trace: narrative.text,
      ai_safety_rating: rating,
      constraint_snapshot: caseData.constraints,
      reasoning_json: { action_atoms_confirmed: atoms, synthetic: true },
    };
    allRows.push(row);
    console.log('✓');
    caseRows.push({ rating, narrative_chars: narrative.text.length, atom_count: atoms.length, sample_atoms: atoms.slice(0, 3) });
  }
  summary.push({ id: caseData.id, stress_target: caseData.stress_target, annotators: caseRows });
}

writeFileSync('/tmp/synthetic-submissions.json', JSON.stringify(allRows, null, 2));
console.log(`\nWrote ${allRows.length} rows to /tmp/synthetic-submissions.json`);
console.log('\n=== SUMMARY ===');
console.log(JSON.stringify(summary, null, 2));
