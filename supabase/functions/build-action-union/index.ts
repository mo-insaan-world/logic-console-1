// build-action-union — ADMIN-TIER Edge Function.
//
// Builds (or rebuilds, on explicit opt-in) the deduplicated UNION of all
// construction-set models' actions for a case, populating case_action_union.
// Consultants then rate this union in Phase 2 instead of the architect-
// verified standard-of-care guideline. Reuses the union-path extraction
// (UNION_EXTRACTION_SYSTEM_PROMPT via extractAtomicActionsForUnion — tightened
// Rule 2 to drop procedural sub-steps / routine peri-operative prophylaxis /
// administrative actions, see extraction-prompt.ts header for the split
// rationale) and the existing clusterer (clusterEquivalentActions) — no
// parallel atomization / dedup logic.
//
// ── FREEZE SEMANTICS ──────────────────────────────────────────────────────
//
//   POST { case_id }                     → BUILD IF MISSING, else 409 with
//                                          existing-union metadata.
//   POST { case_id, force_rebuild: true } → DELETE case's existing union
//                                          rows (cascades to
//                                          phase2_union_ratings, invalidating
//                                          all prior consultant ratings),
//                                          then rebuild. Loud warning in
//                                          response. Intended for deliberate
//                                          benchmark version bumps only.
//
// New models-under-test added to model_responses AFTER first build do NOT
// trigger rebuilds and do NOT invalidate ratings. They're scored against
// the frozen union via the existing judge-ensemble path (separate change).
//
// ── SECURITY MODEL — ADMIN TIER ───────────────────────────────────────────
// Same tier as generate-responses + score-responses: requires
// FUNCTION_INVOKE_SECRET via Authorization: Bearer. NOT browser-reachable.
// The build operation costs N + 1 LLM calls per case (N atomizations + 1
// clusterer call), so it must not be open to anonymous invocation.

import { jsonResponse } from '../_shared/cors.ts';
import { requireInvokeSecret } from '../_shared/auth.ts';
import {
  extractAtomicActionsForUnion,
  clusterEquivalentActions,
  validateClusterCohesion,
  type AtomWithProvenance,
} from '../_shared/scoring.ts';

const COHESION_CONFIDENCE_FLOOR = 0.85;

const SUPABASE_URL              = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const SERVICE_HEADERS = {
  'apikey':        SUPABASE_SERVICE_ROLE_KEY,
  'Authorization': 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY,
};

// v2 adds: (a) post-hoc cohesion validation pass that splits over-merged
// clusters back into single-source clusters, (b) single-source canonicalization
// rule that sets canonical_action to the member atom's text verbatim for any
// cluster with exactly one member. See cohesion_validator block in response
// + console [cohesion-validate] log lines for the audit chain.
const BUILT_BY = 'build-action-union/v2';

interface ModelResponseRow {
  provider: string;
  model_string: string;
  response_text: string;
  error: string | null;
}

interface UnionRowToInsert {
  case_id: string;
  cluster_index: number;
  canonical_action: string;
  contributing_models: string[];
  member_atoms: Array<{ model: string; atom_text: string }>;
  construction_set: string[];
  display_order: number;
  built_by: string;
  synthetic: boolean;
}

async function fetchModelResponses(caseId: string): Promise<ModelResponseRow[]> {
  // Order by created_at desc so the dedupe loop below keeps the most recent
  // row per provider — handles the case where a provider's model_string was
  // upgraded (e.g. gemini-2.5-pro → gemini-3.5-flash 2026-05-29) and the
  // older stale row still exists in model_responses. Without this dedupe,
  // such a provider would appear twice in construction_set, inflating the
  // "X of N" support-count denominator the consultant sees.
  const url = `${SUPABASE_URL}/rest/v1/model_responses`
    + `?case_id=eq.${encodeURIComponent(caseId)}`
    + `&select=provider,model_string,response_text,error,created_at`
    + `&order=created_at.desc`;
  const res = await fetch(url, { headers: SERVICE_HEADERS });
  if (!res.ok) throw new Error(`Fetch model_responses: ${res.status} ${await res.text()}`);
  const allRows: Array<ModelResponseRow & { created_at: string }> = await res.json();
  const seen = new Set<string>();
  const dedupedByProvider: ModelResponseRow[] = [];
  for (const row of allRows) {
    if (seen.has(row.provider)) continue;
    seen.add(row.provider);
    dedupedByProvider.push({
      provider: row.provider,
      model_string: row.model_string,
      response_text: row.response_text,
      error: row.error,
    });
  }
  // Sort alphabetically for deterministic construction_set ordering.
  dedupedByProvider.sort((a, b) => a.provider.localeCompare(b.provider));
  return dedupedByProvider;
}

async function fetchExistingUnion(caseId: string): Promise<Array<{ id: string; cluster_index: number; canonical_action: string }>> {
  const url = `${SUPABASE_URL}/rest/v1/case_action_union`
    + `?case_id=eq.${encodeURIComponent(caseId)}`
    + `&select=id,cluster_index,canonical_action`
    + `&order=cluster_index.asc`;
  const res = await fetch(url, { headers: SERVICE_HEADERS });
  if (!res.ok) throw new Error(`Fetch case_action_union: ${res.status} ${await res.text()}`);
  return res.json();
}

async function deleteExistingUnion(caseId: string): Promise<number> {
  // FK ON DELETE CASCADE propagates to phase2_union_ratings automatically.
  const url = `${SUPABASE_URL}/rest/v1/case_action_union`
    + `?case_id=eq.${encodeURIComponent(caseId)}`;
  const res = await fetch(url, {
    method: 'DELETE',
    headers: { ...SERVICE_HEADERS, 'Prefer': 'return=representation' },
  });
  if (!res.ok) throw new Error(`Delete case_action_union: ${res.status} ${await res.text()}`);
  const rows = await res.json();
  return Array.isArray(rows) ? rows.length : 0;
}

async function insertUnion(rows: UnionRowToInsert[]): Promise<void> {
  if (rows.length === 0) return;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/case_action_union`, {
    method: 'POST',
    headers: { ...SERVICE_HEADERS, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
    body: JSON.stringify(rows),
  });
  if (!res.ok) throw new Error(`Insert case_action_union: ${res.status} ${await res.text()}`);
}

Deno.serve(async (req) => {
  // Security perimeter — must run before any other logic.
  const authError = requireInvokeSecret(req);
  if (authError) return authError;

  if (req.method !== 'POST') return jsonResponse({ error: 'method not allowed' }, 405);

  let body: any;
  try { body = await req.json(); }
  catch { return jsonResponse({ error: 'invalid JSON body' }, 400); }

  const caseId: unknown = body.case_id;
  const forceRebuild: boolean = body.force_rebuild === true;

  if (typeof caseId !== 'string' || !caseId.trim()) {
    return jsonResponse({ error: 'case_id required (non-empty string)' }, 400);
  }

  // ── Freeze check: refuse silent rebuild ─────────────────────────────────
  const existing = await fetchExistingUnion(caseId);
  if (existing.length > 0 && !forceRebuild) {
    return jsonResponse({
      ok: false,
      error: 'union already exists for this case — refusing silent rebuild',
      hint: 'pass force_rebuild: true to delete the existing union (cascades to phase2_union_ratings, invalidates ratings)',
      existing_cluster_count: existing.length,
      existing_clusters: existing.map(r => ({ cluster_index: r.cluster_index, canonical_action: r.canonical_action })),
    }, 409);
  }

  // ── Fetch construction-set responses ────────────────────────────────────
  const responses = await fetchModelResponses(caseId);
  const usable = responses.filter(r => !r.error && r.response_text && r.response_text.trim().length > 0);
  if (usable.length === 0) {
    return jsonResponse({
      ok: false,
      error: 'no usable model_responses rows for this case (all errored or empty)',
      total_responses_rows: responses.length,
    }, 422);
  }

  const constructionSet = usable.map(r => r.provider);

  // ── Atomize per model in parallel ───────────────────────────────────────
  // Uses extractAtomicActionsForUnion (the tightened-Rule-2 variant for the
  // union construction path; see extraction-prompt.ts header for the
  // under-documentation rationale behind the split). Returns [] on parse
  // failure (soft-fail internally). A model that contributes zero atoms
  // just doesn't appear in any cluster's contributing_models — its row in
  // model_responses still informs construction_set.
  const perModelAtoms = await Promise.all(
    usable.map(async (r) => {
      const atoms = await extractAtomicActionsForUnion(r.response_text);
      return { provider: r.provider, atoms };
    }),
  );

  // Flatten with provider as the `annotator` field. The clusterer's prompt
  // uses the term "annotator" but semantically means "source contributor";
  // mapping model index to annotator is a clean dual-use of the same
  // clusterer (no prompt change). Provenance preserved via providerByIdx
  // for the post-cluster mapping back to model names.
  const providerByIdx: string[] = [];
  const flatAtoms: AtomWithProvenance[] = [];
  perModelAtoms.forEach(({ provider, atoms }) => {
    const providerIdx = providerByIdx.length;
    providerByIdx.push(provider);
    atoms.forEach((text) => {
      flatAtoms.push({ idx: flatAtoms.length, annotator: providerIdx, text });
    });
  });

  if (flatAtoms.length === 0) {
    return jsonResponse({
      ok: false,
      error: 'no atoms extracted from any model response',
      construction_set: constructionSet,
    }, 422);
  }

  // ── Cluster the union ───────────────────────────────────────────────────
  const clusters = await clusterEquivalentActions(flatAtoms);
  if (Object.keys(clusters).length === 0) {
    return jsonResponse({
      ok: false,
      error: 'clusterEquivalentActions returned empty (transient LLM failure — retry)',
      raw_atom_count: flatAtoms.length,
      construction_set: constructionSet,
    }, 502);
  }

  // ── Build cluster rows: contributing_models + member_atoms + ordering ──
  type ClusterBuild = {
    canonical_action: string;
    contributing_models: string[];
    member_atoms: Array<{ model: string; atom_text: string }>;
  };
  const initialClusterBuilds: ClusterBuild[] = [];
  for (const [canonical, memberIndices] of Object.entries(clusters)) {
    if (!Array.isArray(memberIndices) || memberIndices.length === 0) continue;
    const validIndices = memberIndices.filter(
      (i: unknown): i is number => Number.isInteger(i) && (i as number) >= 0 && (i as number) < flatAtoms.length,
    );
    if (validIndices.length === 0) continue;
    const memberAtoms = validIndices.map(i => ({
      model: providerByIdx[flatAtoms[i].annotator],
      atom_text: flatAtoms[i].text,
    }));
    const contributingModels = Array.from(new Set(memberAtoms.map(m => m.model))).sort();
    initialClusterBuilds.push({
      canonical_action: canonical.trim(),
      contributing_models: contributingModels,
      member_atoms: memberAtoms,
    });
  }

  // ── Post-hoc cohesion validation ────────────────────────────────────────
  // The clustering pass is one LLM sample under a topic-biased prompt. For
  // every multi-source cluster (contributing_models.length >= 2) run a
  // SEPARATE validator call asking the four-axis test (intervention type,
  // target parameter, target value, mechanism). If the validator returns
  // "no" or confidence < COHESION_CONFIDENCE_FLOOR (0.85), split the cluster
  // back into single-source clusters, each with canonical_action set to
  // its member atom's source text verbatim. Every decision (kept OR split)
  // is logged with the source atoms + confidence + reason so a future
  // auditor can recover the chain of judgment from Supabase function logs.
  type CohesionDecision = {
    canonical: string;
    contributing_models: string[];
    verdict: 'yes' | 'no' | 'error';
    confidence: number;
    reason: string;
    action: 'kept' | 'split' | 'kept_on_error';
  };
  const cohesionLog: CohesionDecision[] = [];
  const clusterBuilds: ClusterBuild[] = [];

  for (const cluster of initialClusterBuilds) {
    if (cluster.contributing_models.length < 2) {
      // Single-source cluster — nothing to validate. Pass through unchanged.
      // (The single-source canonicalization rule — canonical_action ==
      // member atom verbatim — is enforced below in a second pass that
      // applies uniformly to both single-source-from-start clusters and
      // single-source-from-split clusters.)
      clusterBuilds.push(cluster);
      continue;
    }
    const sourceTexts = cluster.member_atoms.map(m => m.atom_text);
    const verdict = await validateClusterCohesion(sourceTexts);
    const shouldSplit = verdict.verdict === 'no' || (verdict.verdict === 'yes' && verdict.confidence < COHESION_CONFIDENCE_FLOOR);
    if (verdict.verdict === 'error') {
      // Validator failed (LLM error / parse error). Conservative choice:
      // keep the cluster as the primary clusterer formed it. Splitting on
      // error would be biased toward over-fragmentation when the validator
      // path is unreliable. The cohesion log records the error explicitly.
      cohesionLog.push({
        canonical: cluster.canonical_action,
        contributing_models: cluster.contributing_models,
        verdict: 'error',
        confidence: 0,
        reason: verdict.reason,
        action: 'kept_on_error',
      });
      console.warn(`[cohesion-validate] KEPT-ON-ERROR cluster "${cluster.canonical_action}" — validator error: ${verdict.reason}`);
      clusterBuilds.push(cluster);
      continue;
    }
    if (shouldSplit) {
      cohesionLog.push({
        canonical: cluster.canonical_action,
        contributing_models: cluster.contributing_models,
        verdict: verdict.verdict,
        confidence: verdict.confidence,
        reason: verdict.reason,
        action: 'split',
      });
      console.warn(`[cohesion-validate] SPLIT cluster "${cluster.canonical_action}" (verdict=${verdict.verdict} conf=${verdict.confidence.toFixed(2)}): ${verdict.reason}`);
      console.warn(`[cohesion-validate]   source atoms being decomposed:`);
      cluster.member_atoms.forEach((m, i) => {
        console.warn(`[cohesion-validate]     [${i}] (${m.model}) ${m.atom_text}`);
      });
      // Split into single-source clusters — one per member atom.
      cluster.member_atoms.forEach((member) => {
        clusterBuilds.push({
          canonical_action: member.atom_text,
          contributing_models: [member.model],
          member_atoms: [member],
        });
      });
    } else {
      cohesionLog.push({
        canonical: cluster.canonical_action,
        contributing_models: cluster.contributing_models,
        verdict: 'yes',
        confidence: verdict.confidence,
        reason: verdict.reason,
        action: 'kept',
      });
      console.log(`[cohesion-validate] KEPT cluster "${cluster.canonical_action}" (conf=${verdict.confidence.toFixed(2)}): ${verdict.reason}`);
      clusterBuilds.push(cluster);
    }
  }

  // Single-source canonicalization rule — for every cluster with exactly
  // one member atom (whether originally single-source or from a split),
  // set canonical_action to the member atom's text verbatim. This removes
  // the LLM-paraphrase divergence from source text that would otherwise
  // make split-out clusters read differently from their original atom and
  // makes per-model attribution unambiguous for the rater.
  for (const c of clusterBuilds) {
    if (c.member_atoms.length === 1) {
      c.canonical_action = c.member_atoms[0].atom_text;
    }
  }

  // Order: most-supported actions first (contributing_models count desc),
  // ties broken by canonical_action alphabetical for determinism. The
  // consultant sees consensus shape immediately and idiosyncratic single-
  // model contributions land at the bottom.
  clusterBuilds.sort((a, b) => {
    if (b.contributing_models.length !== a.contributing_models.length) {
      return b.contributing_models.length - a.contributing_models.length;
    }
    return a.canonical_action.localeCompare(b.canonical_action);
  });

  const synthetic = caseId.startsWith('SYNTH-');
  const rowsToInsert: UnionRowToInsert[] = clusterBuilds.map((c, i) => ({
    case_id: caseId,
    cluster_index: i,
    canonical_action: c.canonical_action,
    contributing_models: c.contributing_models,
    member_atoms: c.member_atoms,
    construction_set: constructionSet,
    display_order: i,
    built_by: BUILT_BY,
    synthetic,
  }));

  // ── force_rebuild path: cascade-delete first, then re-insert ───────────
  let rebuildDeleted = 0;
  if (forceRebuild && existing.length > 0) {
    rebuildDeleted = await deleteExistingUnion(caseId);
  }

  // ── Insert the new union ────────────────────────────────────────────────
  try {
    await insertUnion(rowsToInsert);
  } catch (e) {
    return jsonResponse({ error: 'insert failed: ' + (e as Error).message }, 500);
  }

  // Stamp the architect case union_ready — the function that writes the
  // authoritative artifact records readiness itself, so the status is correct
  // even if the auto-build orchestrator's trailing PATCH is lost (its
  // background task can be killed before the ~3-min chain returns). UUID-
  // guarded + best-effort: synthetic case_ids (SOW-*/SYNTH-*) aren't an
  // architect_cases.id, so this is a no-op for them.
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(caseId)) {
    try {
      await fetch(`${SUPABASE_URL}/rest/v1/architect_cases?id=eq.${encodeURIComponent(caseId)}`, {
        method: 'PATCH',
        headers: { ...SERVICE_HEADERS, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
        body: JSON.stringify({ union_status: 'union_ready', union_error: null }),
      });
    } catch (_e) { /* best-effort — the orchestrator also patches when it survives */ }
  }

  const supportHistogram: Record<number, number> = {};
  for (const c of clusterBuilds) {
    const k = c.contributing_models.length;
    supportHistogram[k] = (supportHistogram[k] ?? 0) + 1;
  }

  return jsonResponse({
    ok: true,
    case_id: caseId,
    construction_set: constructionSet,
    construction_set_size: constructionSet.length,
    raw_atom_count: flatAtoms.length,
    initial_cluster_count: initialClusterBuilds.length,
    cluster_count: rowsToInsert.length,
    cohesion_validator: {
      confidence_floor: COHESION_CONFIDENCE_FLOOR,
      kept: cohesionLog.filter(d => d.action === 'kept').length,
      split: cohesionLog.filter(d => d.action === 'split').length,
      kept_on_error: cohesionLog.filter(d => d.action === 'kept_on_error').length,
      decisions: cohesionLog,
    },
    support_histogram: supportHistogram,
    rebuilt: forceRebuild,
    rebuild_rows_deleted: rebuildDeleted,
    warning: forceRebuild
      ? `Force-rebuild executed: ${rebuildDeleted} prior union rows deleted (and any phase2_union_ratings cascaded). Consultants must re-rate.`
      : null,
    clusters: rowsToInsert.map(r => ({
      cluster_index: r.cluster_index,
      canonical_action: r.canonical_action,
      contributing_models: r.contributing_models,
      support: `${r.contributing_models.length} of ${constructionSet.length}`,
    })),
  });
});
