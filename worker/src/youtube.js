// Minimal YouTube Data API v3 client: three calls per search, no SDK.
//   search.list   -> up to 50 short videos per page (its own 100-calls/day bucket)
//   videos.list   -> duration, embeddable flag, recording location, tags (1 unit)
//   channels.list -> channel country, for the country-level fallback (1 unit)
import { locate, countryCentroid } from './geocode.js';
import { aiGeocode } from './aigeo.js';

const API = 'https://www.googleapis.com/youtube/v3';
const MAX_SHORT_SECONDS = 180; // Shorts can be up to 3 minutes
const TIMEOUT_MS = 8000;

export class QuotaError extends Error {}
export class UpstreamError extends Error {}

export async function searchShorts(query, { apiKey, fetchImpl = fetch, maxResults = 50, pageToken = null, ai = null }) {
  const params = {
    part: 'snippet', type: 'video', videoDuration: 'short', videoEmbeddable: 'true',
    safeSearch: 'strict', maxResults: String(maxResults), q: `${query} #shorts`, key: apiKey,
  };
  if (pageToken) params.pageToken = pageToken;
  const search = await call(fetchImpl, 'search', params);
  const nextPageToken = typeof search.nextPageToken === 'string' ? search.nextPageToken : null;
  const ids = (search.items || []).map((i) => i.id?.videoId).filter(Boolean);
  if (!ids.length) return { results: [], nextPageToken: null, stats: emptyStats() };

  const videos = await call(fetchImpl, 'videos', {
    part: 'snippet,contentDetails,recordingDetails,status', id: ids.join(','), key: apiKey,
  });
  const usable = (videos.items || []).filter((v) =>
    v.status?.embeddable !== false && v.status?.privacyStatus !== 'private' &&
    isoSeconds(v.contentDetails?.duration) <= MAX_SHORT_SECONDS);

  // Channel countries are only needed for videos with no better location.
  const channelIds = [...new Set(usable.map((v) => v.snippet?.channelId).filter(Boolean))];
  const countries = new Map();
  if (channelIds.length) {
    try {
      const ch = await call(fetchImpl, 'channels', { part: 'snippet', id: channelIds.slice(0, 50).join(','), key: apiKey });
      for (const c of ch.items || []) if (c.snippet?.country) countries.set(c.id, c.snippet.country);
    } catch (e) {
      if (e instanceof QuotaError) throw e; // anything else: just skip the fallback
    }
  }

  const results = usable.map((v) => {
    const s = v.snippet || {};
    return {
      id: v.id,
      title: clean(s.title, 140),
      channel: clean(s.channelTitle, 80),
      publishedAt: s.publishedAt,
      thumb: s.thumbnails?.high?.url || s.thumbnails?.medium?.url || null,
      place: locate({
        recording: v.recordingDetails,
        title: s.title,
        tags: s.tags,
        description: s.description,
        channelCountry: countries.get(s.channelId),
      }),
    };
  });
  const stats = emptyStats();

  // Second pass: the AI geocoder (modes compared in evals/results/latest.md).
  //   ai-verified (default): every video without a creator-set location goes to the AI and
  //       its answer is final. If it finds no place, a text-matched rule pin is dropped
  //       (eval run 2: those were look-alikes like "Paris Hilton"); the channel-country pin
  //       stays. If the AI call fails, the rule pins stand.
  //   hybrid: only videos the rules missed or placed at country level.
  if (ai?.run) {
    const verified = ai.mode !== 'hybrid';
    const todo = [];
    results.forEach((r, idx) => {
      if (verified ? r.place?.precision !== 'exact' : (!r.place || r.place.level === 'country')) todo.push(idx);
    });
    if (todo.length) {
      const { places, failed, stats: aiStats } = await aiGeocode(todo.map((idx) => {
        const s = usable[idx].snippet || {};
        return { title: s.title, tags: s.tags, description: s.description };
      }), ai);
      stats.ai = aiStats;
      todo.forEach((idx, k) => {
        const r = results[idx];
        const place = places.get(k);
        if (place) {
          if (r.place && !verified && place.level !== 'city') return; // hybrid: keep a known country
          r.place = place;
        } else if (verified && !failed.has(k) && r.place?.precision === 'place') {
          r.place = countryCentroid(countries.get(usable[idx].snippet?.channelId)) || null;
          stats.droppedByAI++;
        }
      });
    }
  }
  stats.placedByRules = results.filter((r) => r.place && r.place.precision !== 'ai').length;
  stats.placedByAI = results.filter((r) => r.place?.precision === 'ai').length;
  return { results, nextPageToken, stats };
}

function emptyStats() {
  return { placedByRules: 0, placedByAI: 0, droppedByAI: 0, ai: null };
}

async function call(fetchImpl, endpoint, params) {
  const url = `${API}/${endpoint}?${new URLSearchParams(params)}`;
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (res.ok) return res.json();
  let reason = '';
  try { reason = (await res.json())?.error?.errors?.[0]?.reason || ''; } catch { /* ignore */ }
  if (res.status === 403 && /quota|rateLimit/i.test(reason)) throw new QuotaError(reason);
  throw new UpstreamError(`${endpoint} ${res.status} ${reason}`);
}

/** "PT1M5S" -> 65. Unknown formats count as too long, so they are dropped. */
export function isoSeconds(iso) {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(iso || '');
  if (!m) return Infinity;
  const [, d = 0, h = 0, min = 0, s = 0] = m.map((x) => Number(x) || 0);
  return d * 86400 + h * 3600 + min * 60 + s;
}

/** Third-party text: strip control characters and cap length. The browser
 *  still renders it with textContent only, never as HTML. */
function clean(s, max) {
  return String(s || '').replace(/[\p{Cc}\p{Cf}]/gu, '').slice(0, max);
}
