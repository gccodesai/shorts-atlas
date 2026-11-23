// Cloudflare Worker: POST /api/search  {q, pageToken?, turnstileToken?}
// The only component that holds the YouTube key. Order of checks:
// method/origin/size -> rate limit -> Turnstile -> guardrails -> cache -> YouTube.
import { validateQuery } from './guardrails.js';
import { searchShorts, QuotaError } from './youtube.js';

const CACHE_TTL_SECONDS = 60 * 60 * 24; // repeat searches cost no quota for a day
const MAX_BODY_BYTES = 2048;
const PAGE_TOKEN = /^[A-Za-z0-9_-]{1,128}$/;
const RATE = { limit: 20, windowMs: 10 * 60 * 1000 }; // per visitor, per Worker instance
const hits = new Map(); // hashed IP -> {count, reset}. In memory only, never logged.

export default {
  async fetch(request, env, ctx) {
    return handle(request, env, ctx);
  },
};

export async function handle(request, env, ctx = { waitUntil() {} }, deps = {}) {
  const started = Date.now();
  const origin = request.headers.get('Origin') || '';
  const cors = corsHeaders(origin, env);
  const url = new URL(request.url);

  // Setup check, safe to open in a browser: says whether the key is present, never what it is.
  if (url.pathname === '/api/health' && request.method === 'GET') {
    return json({
      ok: Boolean(env.YOUTUBE_API_KEY),
      youtubeKeySet: Boolean(env.YOUTUBE_API_KEY),
      turnstileOn: Boolean(env.TURNSTILE_SECRET),
      allowedOrigins: (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
    }, 200, cors);
  }
  if (url.pathname !== '/api/search') return json({ code: 'not_found' }, 404, cors);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (request.method !== 'POST') return json({ code: 'method' }, 405, cors);
  if (!cors['Access-Control-Allow-Origin']) return json({ code: 'origin', message: 'Origin not allowed.' }, 403, cors);

  const len = Number(request.headers.get('Content-Length') || 0);
  if (len > MAX_BODY_BYTES) return json({ code: 'too_large' }, 413, cors);
  let body;
  try {
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) return json({ code: 'too_large' }, 413, cors);
    body = JSON.parse(text);
  } catch {
    return json({ code: 'bad_json', message: 'Bad request.' }, 400, cors);
  }

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const visitor = await sha256(ip + (env.RATE_SALT || ''));
  if (!allow(visitor, deps.now?.() ?? Date.now())) {
    return json({ code: 'rate_limited', message: 'Too many searches. Try again in a few minutes.' }, 429, cors);
  }

  if (env.TURNSTILE_SECRET) {
    const ok = await verifyTurnstile(body.turnstileToken, ip, env.TURNSTILE_SECRET, deps.fetch || fetch);
    if (!ok) return json({ code: 'bot_check', message: 'Please complete the check and try again.' }, 403, cors);
  }

  const v = validateQuery(body.q);
  if (!v.ok) {
    log({ outcome: 'blocked', code: v.code, ms: Date.now() - started });
    return json({ code: v.code, message: v.message }, 400, cors);
  }

  // "Load more": YouTube's opaque page token. Only its own alphabet is accepted.
  const pageToken = body.pageToken ?? null;
  if (pageToken !== null && (typeof pageToken !== 'string' || !PAGE_TOKEN.test(pageToken))) {
    return json({ code: 'bad_page', message: 'Bad request.' }, 400, cors);
  }

  const cache = deps.cache ?? globalThis.caches?.default;
  const cacheKey = new Request(`https://cache.shorts-atlas/v2/${await sha256(v.key + '\n' + (pageToken || ''))}`);
  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) {
      const data = await hit.json();
      log({ outcome: 'ok', cached: true, n: data.results.length, ms: Date.now() - started });
      return json({ ...data, cached: true }, 200, cors);
    }
  }

  if (!env.YOUTUBE_API_KEY) return json({ code: 'config', message: 'The search service is not configured.' }, 500, cors);
  try {
    const { results, nextPageToken } = await searchShorts(v.query, { apiKey: env.YOUTUBE_API_KEY, fetchImpl: deps.fetch || fetch, pageToken });
    const data = { query: v.query, results, nextPageToken, fetchedAt: new Date().toISOString() };
    if (cache) {
      ctx.waitUntil(cache.put(cacheKey, new Response(JSON.stringify(data), {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${CACHE_TTL_SECONDS}` },
      })));
    }
    log({ outcome: 'ok', cached: false, n: results.length, ms: Date.now() - started });
    return json({ ...data, cached: false }, 200, cors);
  } catch (e) {
    if (e instanceof QuotaError) {
      log({ outcome: 'quota', ms: Date.now() - started });
      return json({ code: 'quota', message: "Today's free YouTube quota is used up. Cached searches still work; new ones will be back tomorrow." }, 503, cors);
    }
    log({ outcome: 'error', error: String(e?.message || e).slice(0, 120), ms: Date.now() - started });
    return json({ code: 'upstream', message: 'YouTube did not respond. Please try again.' }, 502, cors);
  }
}

function corsHeaders(origin, env) {
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const base = { 'Vary': 'Origin', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' };
  if (origin && allowed.includes(origin)) {
    return { ...base, 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400' };
  }
  return base;
}

function allow(visitor, now) {
  const h = hits.get(visitor);
  if (!h || now > h.reset) {
    hits.set(visitor, { count: 1, reset: now + RATE.windowMs });
    if (hits.size > 10000) for (const [k, val] of hits) if (now > val.reset) hits.delete(k);
    return true;
  }
  h.count += 1;
  return h.count <= RATE.limit;
}

async function verifyTurnstile(token, ip, secret, fetchImpl) {
  if (typeof token !== 'string' || !token || token.length > 2048) return false;
  try {
    const res = await fetchImpl('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body: new URLSearchParams({ secret, response: token, remoteip: ip }),
      signal: AbortSignal.timeout(5000),
    });
    return (await res.json()).success === true;
  } catch {
    return false;
  }
}

async function sha256(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function json(data, status, headers) {
  return new Response(JSON.stringify(data), { status, headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' } });
}

// Outcomes only: never the query text or the visitor's IP.
function log(fields) {
  console.log(JSON.stringify(fields));
}

export const _test = { hits };
