import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { handle, _test } from '../worker/src/index.js';
import { isoSeconds } from '../worker/src/youtube.js';

const ORIGIN = 'https://shorts-atlas.pages.dev';
const ENV = { ALLOWED_ORIGINS: ORIGIN, YOUTUBE_API_KEY: 'test-key' };

// A fake YouTube API: records calls, returns canned data.
function fakeYouTube({ quota = false } = {}) {
  const calls = [];
  const fetch = async (url) => {
    const u = new URL(url);
    calls.push(u);
    if (quota) return Response.json({ error: { errors: [{ reason: 'quotaExceeded' }] } }, { status: 403 });
    if (u.pathname.endsWith('/search')) {
      return Response.json({ items: ['aaaaaaaaaaa', 'bbbbbbbbbbb', 'ccccccccccc', 'ddddddddddd'].map((videoId) => ({ id: { videoId } })) });
    }
    if (u.pathname.endsWith('/videos')) {
      return Response.json({ items: [
        { id: 'aaaaaaaaaaa', snippet: { title: 'Dumplings', channelId: 'c1', channelTitle: 'One' }, contentDetails: { duration: 'PT45S' }, status: { embeddable: true },
          recordingDetails: { location: { latitude: 25.03, longitude: 121.56 } } },
        { id: 'bbbbbbbbbbb', snippet: { title: 'Tacos in Mexico City <b>wow</b>\u0007', channelId: 'c2', channelTitle: 'Two' }, contentDetails: { duration: 'PT1M' }, status: { embeddable: true } },
        { id: 'ccccccccccc', snippet: { title: 'Snack', channelId: 'c3', channelTitle: 'Three' }, contentDetails: { duration: 'PT2M30S' }, status: { embeddable: true } },
        { id: 'ddddddddddd', snippet: { title: 'Too long', channelId: 'c1' }, contentDetails: { duration: 'PT12M' }, status: { embeddable: true } },
      ] });
    }
    if (u.pathname.endsWith('/channels')) return Response.json({ items: [{ id: 'c3', snippet: { country: 'NG' } }] });
    throw new Error('unexpected ' + url);
  };
  return { fetch, calls };
}

function memoryCache() {
  const store = new Map();
  return {
    store,
    match: async (req) => store.get(req.url)?.clone(),
    put: async (req, res) => { store.set(req.url, res); },
  };
}

const req = (body, { origin = ORIGIN, method = 'POST', ip = '1.2.3.4' } = {}) => new Request('https://api.example/api/search', {
  method,
  headers: { 'Content-Type': 'application/json', Origin: origin, 'CF-Connecting-IP': ip },
  body: method === 'POST' ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
});
const ctx = () => { const p = []; return { waitUntil: (x) => p.push(x), done: () => Promise.all(p) }; };

beforeEach(() => _test.hits.clear());

test('returns Shorts with honest location precision', async () => {
  const yt = fakeYouTube();
  const res = await handle(req({ q: 'street food' }), ENV, ctx(), { fetch: yt.fetch, cache: memoryCache() });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  const data = await res.json();
  assert.deepEqual(data.results.map((r) => r.id), ['aaaaaaaaaaa', 'bbbbbbbbbbb', 'ccccccccccc']); // 12-minute video dropped
  assert.deepEqual(data.results.map((r) => r.place?.precision), ['exact', 'place', 'country']);
  assert.equal(data.results[1].title, 'Tacos in Mexico City <b>wow</b>'); // control chars stripped; HTML left as text for textContent
  const search = yt.calls[0];
  assert.equal(search.searchParams.get('safeSearch'), 'strict');
  assert.equal(search.searchParams.get('q'), 'street food #shorts');
  assert.equal(search.searchParams.get('videoDuration'), 'short');
});

test('repeat searches are served from cache without calling YouTube', async () => {
  const yt = fakeYouTube();
  const cache = memoryCache();
  const c = ctx();
  await handle(req({ q: 'Street   Food' }), ENV, c, { fetch: yt.fetch, cache });
  await c.done();
  const n = yt.calls.length;
  const res = await handle(req({ q: 'street food' }), ENV, ctx(), { fetch: yt.fetch, cache });
  assert.equal((await res.json()).cached, true);
  assert.equal(yt.calls.length, n);
  // the cache key is a hash, never the query text
  for (const key of cache.store.keys()) assert.equal(key.includes('street'), false);
});

test('blocks bad input before spending quota', async () => {
  const yt = fakeYouTube();
  for (const q of ['me@example.com', "x' OR 1=1", '<script>', 'a'.repeat(65), '']) {
    const res = await handle(req({ q }), ENV, ctx(), { fetch: yt.fetch, cache: memoryCache() });
    assert.equal(res.status, 400, q);
  }
  assert.equal(yt.calls.length, 0);
});

test('rejects unknown origins, wrong methods, bad JSON and big bodies', async () => {
  const deps = { fetch: fakeYouTube().fetch, cache: memoryCache() };
  assert.equal((await handle(req({ q: 'x' }, { origin: 'https://evil.example' }), ENV, ctx(), deps)).status, 403);
  assert.equal((await handle(req(null, { method: 'GET' }), ENV, ctx(), deps)).status, 405);
  assert.equal((await handle(req('{not json'), ENV, ctx(), deps)).status, 400);
  assert.equal((await handle(req({ q: 'x'.repeat(5000) }), ENV, ctx(), deps)).status, 413);
  const pre = await handle(req(null, { method: 'OPTIONS' }), ENV, ctx(), deps);
  assert.equal(pre.status, 204);
});

test('rate limits a single visitor', async () => {
  const deps = { fetch: fakeYouTube().fetch, cache: memoryCache(), now: () => 1000 };
  let last;
  for (let i = 0; i < 21; i++) last = await handle(req({ q: 'nope@x.io' }), ENV, ctx(), deps);
  assert.equal(last.status, 429);
  const other = await handle(req({ q: 'nope@x.io' }, { ip: '5.6.7.8' }), ENV, ctx(), deps);
  assert.equal(other.status, 400);
});

test('reports a used-up quota clearly', async () => {
  const res = await handle(req({ q: 'street food' }), ENV, ctx(), { fetch: fakeYouTube({ quota: true }).fetch, cache: memoryCache() });
  assert.equal(res.status, 503);
  assert.equal((await res.json()).code, 'quota');
});

test('requires Turnstile when a secret is configured', async () => {
  const yt = fakeYouTube();
  const fetch = async (url, init) => {
    if (String(url).includes('turnstile')) return Response.json({ success: init.body.get('response') === 'good' });
    return yt.fetch(url, init);
  };
  const env = { ...ENV, TURNSTILE_SECRET: 's' };
  assert.equal((await handle(req({ q: 'street food' }), env, ctx(), { fetch, cache: memoryCache() })).status, 403);
  assert.equal((await handle(req({ q: 'street food', turnstileToken: 'bad' }), env, ctx(), { fetch, cache: memoryCache() })).status, 403);
  assert.equal((await handle(req({ q: 'street food', turnstileToken: 'good' }), env, ctx(), { fetch, cache: memoryCache() })).status, 200);
});

test('logs outcomes, never the query or IP', async () => {
  const lines = [];
  const orig = console.log;
  console.log = (s) => lines.push(String(s));
  try {
    await handle(req({ q: 'secret phrase' }, { ip: '9.9.9.9' }), ENV, ctx(), { fetch: fakeYouTube().fetch, cache: memoryCache() });
    await handle(req({ q: 'me@example.com' }, { ip: '9.9.9.9' }), ENV, ctx(), { fetch: fakeYouTube().fetch, cache: memoryCache() });
  } finally { console.log = orig; }
  assert.ok(lines.length >= 2);
  for (const l of lines) {
    assert.equal(/secret|example|9\.9\.9\.9/.test(l), false, l);
  }
});

test('health check reports setup without revealing the key', async () => {
  const res = await handle(new Request('https://api.example/api/health'), ENV, ctx());
  const body = await res.text();
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(body).youtubeKeySet, true);
  assert.equal(body.includes('test-key'), false);
  assert.ok(JSON.parse(body).bindingNames.includes('"YOUTUBE_API_KEY"'));
  const missing = await handle(new Request('https://api.example/api/health'), { ALLOWED_ORIGINS: ORIGIN }, ctx());
  assert.equal((await missing.json()).youtubeKeySet, false);
});

test('parses ISO durations', () => {
  assert.equal(isoSeconds('PT45S'), 45);
  assert.equal(isoSeconds('PT1M5S'), 65);
  assert.equal(isoSeconds('PT3M'), 180);
  assert.equal(isoSeconds('P0D'), 0);
  assert.equal(isoSeconds('bogus'), Infinity);
});
