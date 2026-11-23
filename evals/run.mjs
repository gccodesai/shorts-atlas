// Geocoder evals: rules vs AI vs hybrid on a hand-labelled case set.
//
//   node evals/run.mjs                      rules only (offline, no keys)
//   node evals/run.mjs --ai                 + AI and hybrid (needs CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN)
//   node evals/run.mjs --ai --models a,b    compare several Workers AI models
//
// Writes evals/results/latest.md and latest.json.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { locate } from '../worker/src/geocode.js';
import { aiGeocode, restRunner, resolveAiPlace, DEFAULT_MODEL } from '../worker/src/aigeo.js';

const args = process.argv.slice(2);
const withAI = args.includes('--ai');
const models = (args[args.indexOf('--models') + 1] && args.includes('--models'))
  ? args[args.indexOf('--models') + 1].split(',').map((s) => s.trim()).filter(Boolean)
  : [process.env.AI_MODEL || DEFAULT_MODEL];
const BATCH = 25; // production sends up to 50 per call; smaller batches keep eval runs robust
const CITY_KM = 50;

// Neurons per million tokens [input, output], from the Workers AI pricing page (Nov 2026).
const NEURONS_PER_M = {
  '@cf/meta/llama-3.1-8b-instruct-fp8-fast': [4119, 34868],
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast': [26668, 204805],
  '@cf/qwen/qwen3-30b-a3b-fp8': [4625, 30475],
  '@cf/meta/llama-4-scout-17b-16e-instruct': [24545, 77273],
  '@cf/mistralai/mistral-small-3.1-24b-instruct': [31876, 50488],
  '@cf/google/gemma-3-12b-it': [31371, 50560],
};

export const CASES = readFileSync(new URL('./cases.jsonl', import.meta.url), 'utf8')
  .split('\n').filter(Boolean).map((l) => JSON.parse(l));

/** Expected position for a case, from the same place lists the app uses. */
export function expectedPlace(c) {
  if (!c.expect) return null;
  return resolveAiPlace(c.expect.city ?? null, c.expect.country);
}

function km(a, b) {
  const r = (d) => (d * Math.PI) / 180;
  const h = Math.sin(r(b.lat - a.lat) / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(r(b.lon - a.lon) / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(h));
}

/** correct | country_only | wrong | missed | false_place | correct_none */
export function judge(c, place) {
  const exp = expectedPlace(c);
  if (!exp) return place ? 'false_place' : 'correct_none';
  if (!place) return 'missed';
  if (c.expect.city) {
    if (km(exp, place) <= CITY_KM) return 'correct';
    return place.cc === exp.cc ? 'country_only' : 'wrong';
  }
  return place.cc === exp.cc ? 'correct' : 'wrong';
}

function rulesPlace(c) {
  return locate({ title: c.title, tags: c.tags, description: c.description });
}

async function aiPlaces(cases, run, model) {
  const out = new Map();
  const usage = { prompt_tokens: 0, completion_tokens: 0 };
  let calls = 0, ms = 0, errors = 0;
  const rejected = { evidence: 0, unresolved: 0, invalid: 0 };
  for (let i = 0; i < cases.length; i += BATCH) {
    const batch = cases.slice(i, i + BATCH);
    const { places, stats } = await aiGeocode(batch.map((c) => ({ title: c.title, tags: c.tags, description: c.description })), { run, model, timeoutMs: 60000 });
    calls++; ms += stats.ms;
    if (stats.error) { errors++; console.error(`  batch ${i / BATCH + 1}: ${stats.error}`); }
    for (const k of Object.keys(rejected)) rejected[k] += stats.rejected[k];
    usage.prompt_tokens += stats.usage?.prompt_tokens || 0;
    usage.completion_tokens += stats.usage?.completion_tokens || 0;
    for (const [k, place] of places) out.set(batch[k].id, place);
  }
  const rate = NEURONS_PER_M[model];
  const neurons = rate ? Math.round((usage.prompt_tokens * rate[0] + usage.completion_tokens * rate[1]) / 1e6) : null;
  return { places: out, meta: { calls, ms, errors, usage, neurons, rejected } };
}

function score(name, cases, placeOf, meta = null) {
  const verdicts = cases.map((c) => ({ c, place: placeOf(c), verdict: null }));
  for (const v of verdicts) v.verdict = judge(v.c, v.place);
  const located = verdicts.filter((v) => v.c.expect);
  const none = verdicts.filter((v) => !v.c.expect);
  const placed = located.filter((v) => v.place);
  const count = (arr, ...k) => arr.filter((v) => k.includes(v.verdict)).length;
  const pct = (a, b) => (b ? Math.round((100 * a) / b) : 0);
  const byCategory = {};
  for (const v of verdicts) {
    const b = (byCategory[v.c.category] ||= { n: 0, good: 0 });
    b.n++;
    if (v.verdict === 'correct' || v.verdict === 'correct_none') b.good++;
  }
  return {
    name,
    metrics: {
      usefulPins: pct(count(located, 'correct'), located.length), // right place, as a share of all videos that have one
      coverage: pct(placed.length, located.length),
      precision: pct(count(placed, 'correct'), placed.length),
      countryRight: pct(count(placed, 'correct', 'country_only'), placed.length),
      falsePlacements: pct(count(none, 'false_place'), none.length),
    },
    counts: { located: located.length, none: none.length, placed: placed.length },
    byCategory,
    failures: verdicts.filter((v) => !['correct', 'correct_none'].includes(v.verdict))
      .map((v) => ({ id: v.c.id, title: v.c.title, verdict: v.verdict, got: v.place?.label ?? null, evidence: v.place?.evidence ?? null })),
    meta,
  };
}

async function main() {
  const reports = [];
  const rules = new Map(CASES.map((c) => [c.id, rulesPlace(c)]));
  reports.push(score('Rules only', CASES, (c) => rules.get(c.id)));

  if (withAI) {
    const { CLOUDFLARE_ACCOUNT_ID: accountId, CLOUDFLARE_API_TOKEN: apiToken } = process.env;
    if (!accountId || !apiToken) throw new Error('Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN for --ai');
    const run = restRunner({ accountId, apiToken });
    for (const model of models) {
      console.error(`AI: ${model}`);
      const ai = await aiPlaces(CASES, run, model);
      const short = model.split('/').pop();
      reports.push(score(`AI only (${short})`, CASES, (c) => ai.places.get(c.id) || null, ai.meta));
      // Hybrid = production: rules first; AI for misses and country-level rules answers.
      const needsAI = (p) => !p || p.level === 'country';
      const todo = CASES.filter((c) => needsAI(rules.get(c.id)));
      const hy = await aiPlaces(todo, run, model);
      reports.push(score(`Hybrid (${short})`, CASES, (c) => {
        const r = rules.get(c.id);
        const a = hy.places.get(c.id);
        if (!a) return r;
        if (r && a.level !== 'city') return r;
        return a;
      }, { ...hy.meta, aiShare: `${todo.length}/${CASES.length} cases sent to AI` }));
    }
  }

  mkdirSync(new URL('./results/', import.meta.url), { recursive: true });
  writeFileSync(new URL('./results/latest.json', import.meta.url), JSON.stringify({ ranAt: new Date().toISOString(), cases: CASES.length, reports }, null, 2));
  writeFileSync(new URL('./results/latest.md', import.meta.url), toMarkdown(reports));
  console.log(toMarkdown(reports));
}

function toMarkdown(reports) {
  const L = [];
  L.push(`# Geocoder eval results`, '', `${CASES.length} hand-labelled cases · run ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`, '');
  L.push('| Pipeline | Useful pins | Coverage | Precision | Right country | False placements | AI calls | Neurons | AI time |');
  L.push('|---|---|---|---|---|---|---|---|---|');
  for (const r of reports) {
    const m = r.metrics;
    L.push(`| ${r.name} | **${m.usefulPins}%** | ${m.coverage}% | ${m.precision}% | ${m.countryRight}% | ${m.falsePlacements}% | ${r.meta?.calls ?? 0} | ${r.meta?.neurons ?? (r.meta ? '?' : 0)} | ${r.meta ? (r.meta.ms / 1000).toFixed(1) + ' s' : '–'} |`);
  }
  L.push('', '- **Useful pins**: placed at the right spot, as a share of all videos that name a place (the headline number).',
    '- **Coverage**: placed at all. **Precision**: placed correctly (within 50 km, or right country when only a country is named).',
    '- **False placements**: videos with no real place (incl. look-alike names and injection attempts) that got a pin anyway. Lower is better.', '');
  const cats = Object.keys(reports[0].byCategory);
  L.push('## By category (share handled correctly)', '', `| Category | n | ${reports.map((r) => r.name).join(' | ')} |`, `|---|---|${reports.map(() => '---').join('|')}|`);
  for (const k of cats) {
    L.push(`| ${k} | ${reports[0].byCategory[k].n} | ${reports.map((r) => `${r.byCategory[k].good}/${r.byCategory[k].n}`).join(' | ')} |`);
  }
  for (const r of reports) {
    L.push('', `## Misses: ${r.name}`, '');
    if (r.meta?.rejected) L.push(`AI proposals rejected by validation: ${JSON.stringify(r.meta.rejected)}${r.meta.errors ? ` · failed calls: ${r.meta.errors}` : ''}${r.meta.aiShare ? ` · ${r.meta.aiShare}` : ''}`, '');
    if (!r.failures.length) { L.push('None.'); continue; }
    L.push('| Case | Title | Verdict | Got |', '|---|---|---|---|');
    for (const f of r.failures) L.push(`| ${f.id} | ${f.title.replace(/\|/g, '\\|').slice(0, 60)} | ${f.verdict} | ${f.got ?? '–'}${f.evidence ? ` (from “${f.evidence}”)` : ''} |`);
  }
  return L.join('\n') + '\n';
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
