# 🌍 Shorts Atlas: where is the world filming it?

Type a word, song title or theme. Shorts Atlas finds YouTube Shorts about it, puts them on a
world map and plays them in place. Every pin says how sure we are about its location.

**Live demo:** _add your Pages link_ · **Cost to run:** $0

## How it works

```
 Browser (Cloudflare Pages, static files)
   ├─ search box: same guardrails as the server, live counter
   ├─ MapLibre + OpenFreeMap tiles, clustered pins
   └─ filmstrip of Shorts; pick one and the map flies to it; play via youtube-nocookie
        │  POST /api/search {q, turnstileToken}
        ▼
 Cloudflare Worker  (the only place the YouTube key lives)
   1. origin check, body size limit, per-visitor rate limit, optional Turnstile
   2. guardrails: length, characters, personal details, injection, unsafe terms
   3. cache (24 h, key = SHA-256 of the query) → repeat searches cost no quota
   4. YouTube: search.list → videos.list → channels.list   (3 calls per new search)
   5. geocoder: recording location → place named in title/tags → channel country → unplaced
```

### Honest locations

| Pin | Where it comes from |
|---|---|
| ● **Exact** | The creator set a recording location on the video |
| ○ **Place name** | A city or country named in the title, hashtags or tags (2,921 cities ≥150k people + 250 countries, from GeoNames) |
| ◌ **Country** | Only the channel's country is known; pinned at the country's centre |
| _Unplaced_ | Shown in the strip, never put on the map at a made-up spot |

The text matcher only looks at capitalized words and hashtags, prefers cities over countries
and larger cities over smaller ones, and skips city names that are also common English words
(Nice, Reading, Mobile…).

## Guardrails

| Check | Where | Action |
|---|---|---|
| Length: 64 characters, 8 words | browser + Worker | block |
| Allowed characters: letters/marks in any script, digits, space, `' & . , ! ? # : / ( ) -` | browser + Worker | block |
| Personal details: emails, @handles, links, 7+ digit numbers (phones, IDs, cards) | browser + Worker | block with a specific message |
| SQL / HTML / prompt injection patterns | browser + Worker | block |
| Obviously unsafe terms (plus YouTube `safeSearch=strict` on every call) | Worker | block |
| Unknown origin, wrong method, bad JSON, body > 2 KB | Worker | 403 / 405 / 400 / 413 |
| 20 searches per 10 minutes per visitor (hashed IP, memory only) | Worker | 429 |
| Bot check (Cloudflare Turnstile, optional) | Worker | 403 |

The browser and Worker share one `guardrails.js` (a test fails if the two copies drift).
There is no database, so there is nothing to inject SQL into; the cache key is a hash.
The real injection risk is third-party text (video titles), so the page only ever writes it
with `textContent`, and a strict Content Security Policy (`web/_headers`) allows scripts from
this site and Turnstile only.

**Privacy:** no accounts, no cookies, no analytics. Logs record outcomes only (`blocked`,
`ok`, `quota`, timing): never the query or the IP. Videos play through
`youtube-nocookie.com`, and fonts and the map library are self-hosted.

**Why 64 characters?** Long enough for nearly every song title, short enough to stop pasted
paragraphs and keep search results relevant. _Next step: derive it from data (the 99th
percentile of title lengths in a public music dataset)._

## Run it locally

```bash
git clone https://github.com/gccodesai/shorts-atlas.git && cd shorts-atlas
npm install
npm test                 # 26 tests, offline, fake YouTube API
npm run serve            # http://localhost:8080 (demo mode: sample places, no API key needed)
```

To search real YouTube locally, run the Worker in a second terminal and point
`web/config.js` at it (`apiUrl: 'http://localhost:8787/api/search'`):

```bash
npx wrangler dev --var YOUTUBE_API_KEY:your-key
```

## Deploy for free

1. **YouTube API key:** [Google Cloud Console](https://console.cloud.google.com/) → new project →
   enable **YouTube Data API v3** → Credentials → **API key**. No billing account needed.
   Restrict the key to the YouTube Data API.
2. **Worker (no local install):** Cloudflare dashboard → Workers & Pages → Create application →
   import this repo, name it `shorts-atlas-api` (must match `wrangler.toml`), Deploy. Then
   Settings → Variables and Secrets → add a **Secret** `YOUTUBE_API_KEY`. Every push redeploys.
   Note the `https://shorts-atlas-api.<you>.workers.dev` URL.
3. **Front end:** Cloudflare dashboard → Workers & Pages → Create → Pages → connect this repo,
   build output directory `web`, no build command. Put your Pages URL in `ALLOWED_ORIGINS`
   in `wrangler.toml` and push.
4. Set `apiUrl` in `web/config.js` to the Worker URL plus `/api/search`, and replace
   `https://*.workers.dev` in `web/_headers` with that exact URL.
5. **(Optional) Turnstile:** create a free widget for your Pages domain, put the site key in
   `web/config.js` and add a `TURNSTILE_SECRET` secret to the Worker.

**Free-tier budget:** YouTube allows 100 new searches a day by default; cached repeats are free.
When the quota runs out the page says so plainly, and cached searches keep working.

## Project structure

```
worker/src/
  index.js        # request handling: origin, size, rate limit, Turnstile, cache, errors
  guardrails.js   # input checks, shared with the browser
  youtube.js      # 3-call YouTube client, Shorts filter (≤ 3 min, embeddable)
  geocode.js      # recording location → place name → channel country
  gazetteer.json  # built by scripts/build-gazetteer.mjs
wrangler.toml     # Worker config (kept at the repo root for one-click Git deploys)
web/
  index.html, styles.css, js/app.js, config.js, _headers, demo-data.json
  vendor/         # MapLibre GL (CSP build), self-hosted
tests/            # node:test, no network
```

## Roadmap

- [ ] Derive the length cap from title-length data
- [ ] Shareable result links with a preview image
- [ ] LLM geocoder for titles the gazetteer misses, measured against the rule-based one
- [ ] Instagram Reels as a second source, if Meta approves API access

## Credits & license

Video data: YouTube Data API. Map: [OpenFreeMap](https://openfreemap.org), © OpenMapTiles,
© OpenStreetMap contributors. Places: GeoNames (CC BY 4.0) via `all-the-cities` and
`world-countries`. Map library: MapLibre GL (BSD-3). Code: MIT.
