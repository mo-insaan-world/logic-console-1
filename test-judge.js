const fs = require('fs');

const cases = JSON.parse(fs.readFileSync('./cases.json', 'utf8'));
const c = cases.find(x => x.id === 'BRH-2024-0891');

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const systemPrompt = `You are a clinical difficulty scoring system for trauma surgery cases. You score cases on a 3-tier scale based on a strict rubric. Respond only with valid JSON — no preamble, no explanation.

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
const labelledConstraints = {};
Object.entries(c.constraints).forEach(([k, level]) => {
  labelledConstraints[k] = (constraintMeta[k] && constraintMeta[k][level]) || level;
});

const userMsg = JSON.stringify({
  case_title: c.case_title || c.id,
  scenario: c.scenario,
  vitals: c.vitals,
  constraints: labelledConstraints
}, null, 2);

async function run() {
  if (!ANTHROPIC_API_KEY) throw new Error('Missing env: ANTHROPIC_API_KEY');

  console.log('Case:', c.id);
  console.log('Calling claude-sonnet-4-20250514...\n');

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 512,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMsg }]
    })
  });

  if (!res.ok) {
    const err = await res.text();
    console.error('API error', res.status, err);
    process.exit(1);
  }

  const data = await res.json();
  const text = data.content[0].text.trim();
  const parsed = JSON.parse(text.match(/\{[\s\S]*\}/)[0]);
  console.log(JSON.stringify(parsed, null, 2));
}

run().catch(e => { console.error(e); process.exit(1); });
