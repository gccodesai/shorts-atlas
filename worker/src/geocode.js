// Turns video metadata into a map position, with an honest precision label:
//   exact   - the creator set a recording location on the video
//   place   - a city or country named in the title, hashtags or tags
//   country - only the channel's country is known (pinned at its centroid)
//   null    - unplaced; shown in the strip, not on the map
import GAZ from './gazetteer.json' with { type: 'json' };

const norm = (s) => s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();

// name (normalized) -> best entry. Cities are sorted by population, so the
// first city with a name wins ("Paris" is Paris, France, not Paris, Texas).
const CITY = new Map();
for (const [name, lat, lon, cc, pop] of GAZ.cities) {
  const k = norm(name);
  if (!CITY.has(k)) CITY.set(k, { name, lat, lon, cc, pop });
}
const COUNTRY_BY_NAME = new Map();
const COUNTRY_BY_CODE = new Map();
for (const [names, lat, lon, cc, name] of GAZ.countries) {
  const entry = { name, lat, lon, cc };
  COUNTRY_BY_CODE.set(cc, entry);
  for (const n of names) COUNTRY_BY_NAME.set(norm(n), entry);
}
const MAX_NGRAM = 3;

/** Find a place named in free text. Capitalized words and hashtags only. */
export function placeFromText(text) {
  if (!text) return null;
  const candidates = [];

  // Hashtags: #taipei, #MexicoCity, #new_york -> compare with spaces removed.
  for (const m of text.matchAll(/#([\p{L}\p{N}_]{3,40})/gu)) {
    const tag = norm(m[1]).replace(/_/g, '');
    const hit = lookupCompact(tag);
    if (hit) candidates.push(hit);
  }

  // Capitalized word runs: "street food in Mexico City" -> "Mexico City".
  const words = text.split(/[^\p{L}\p{M}'’.-]+/u).filter(Boolean);
  for (let i = 0; i < words.length; i++) {
    if (!/^\p{Lu}/u.test(words[i])) continue;
    for (let n = Math.min(MAX_NGRAM, words.length - i); n >= 1; n--) {
      const phrase = words.slice(i, i + n).join(' ').replace(/[.'’-]+$/, '');
      const hit = lookup(norm(phrase));
      if (hit) { candidates.push(hit); i += n - 1; break; }
    }
  }
  if (!candidates.length) return null;
  // Prefer a city over a country, then the larger city.
  candidates.sort((a, b) => (b.kind === 'city') - (a.kind === 'city') || (b.pop || 0) - (a.pop || 0));
  const best = candidates[0];
  return { lat: best.lat, lon: best.lon, label: best.label, precision: 'place' };
}

function lookup(k) {
  const city = CITY.get(k);
  if (city) return { kind: 'city', ...city, label: cityLabel(city) };
  const country = COUNTRY_BY_NAME.get(k);
  if (country) return { kind: 'country', ...country, label: country.name };
  return null;
}

let COMPACT;
function lookupCompact(tag) {
  if (!COMPACT) {
    COMPACT = new Map();
    for (const [k] of COUNTRY_BY_NAME) COMPACT.set(k.replace(/\s+/g, ''), k);
    for (const [k] of CITY) COMPACT.set(k.replace(/\s+/g, ''), k); // cities override
  }
  const k = COMPACT.get(tag);
  return k ? lookup(k) : null;
}

function cityLabel(c) {
  const country = COUNTRY_BY_CODE.get(c.cc);
  return country ? `${c.name}, ${country.name}` : c.name;
}

/** Label for an exact coordinate: the nearest large city, if within ~150 km. */
export function nearestCityLabel(lat, lon) {
  let best = null;
  let bestD = Infinity;
  for (const c of CITY.values()) {
    const d = haversineKm(lat, lon, c.lat, c.lon);
    if (d < bestD) { bestD = d; best = c; }
  }
  if (!best) return 'Pinned location';
  return bestD < 150 ? `Near ${cityLabel(best)}` : 'Pinned location';
}

export function countryCentroid(cc) {
  const c = cc && COUNTRY_BY_CODE.get(cc.toUpperCase());
  return c ? { lat: c.lat, lon: c.lon, label: c.name, precision: 'country' } : null;
}

/** Pick the best position available for a video. */
export function locate({ recording, title, tags, description, channelCountry }) {
  const loc = recording?.location;
  if (loc && Number.isFinite(loc.latitude) && Number.isFinite(loc.longitude) &&
      Math.abs(loc.latitude) <= 90 && Math.abs(loc.longitude) <= 180 &&
      !(loc.latitude === 0 && loc.longitude === 0)) {
    return { lat: loc.latitude, lon: loc.longitude, label: nearestCityLabel(loc.latitude, loc.longitude), precision: 'exact' };
  }
  const text = [title, (tags || []).map((t) => '#' + t.replace(/\s+/g, '')).join(' '), (description || '').slice(0, 500)].join(' \n ');
  return placeFromText(text) || countryCentroid(channelCountry) || null;
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(a));
}
