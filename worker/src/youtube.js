// Minimal YouTube Data API v3 client: three calls per search, no SDK.
//   search.list   -> up to 50 short videos per page (its own 100-calls/day bucket)
//   videos.list   -> duration, embeddable flag, recording location, tags (1 unit)
//   channels.list -> channel country, for the country-level fallback (1 unit)
import { locate } from './geocode.js';

const API = 'https://www.googleapis.com/youtube/v3';
const MAX_SHORT_SECONDS = 180; // Shorts can be up to 3 minutes
const TIMEOUT_MS = 8000;

export class QuotaError extends Error {}
export class UpstreamError extends Error {}

export async function searchShorts(query, { apiKey, fetchImpl = fetch, maxResults = 50, pageToken = null }) {
  const params = {
    part: 'snippet', type: 'video', videoDuration: 'short', videoEmbeddable: 'true',
    safeSearch: 'strict', maxResults: String(maxResults), q: `${query} #shorts`, key: apiKey,
  };
  if (pageToken) params.pageToken = pageToken;
  const search = await call(fetchImpl, 'search', params);
  const nextPageToken = typeof search.nextPageToken === 'string' ? search.nextPageToken : null;
  const ids = (search.items || []).map((i) => i.id?.videoId).filter(Boolean);
  if (!ids.length) return { results: [], nextPageToken: null };

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
  return { results, nextPageToken };
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
