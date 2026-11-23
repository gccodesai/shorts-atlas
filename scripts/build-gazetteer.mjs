// Builds worker/src/gazetteer.json and towns.json from GeoNames-derived npm packages.
// Cities with population >= 150k (keeps the Worker bundle small and cuts
// ambiguous small-town names) plus every country with its centroid.
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const cities = require('all-the-cities');
const countries = require('world-countries');

// City names that are also everyday English words: matching them in a video
// title produces far more false pins than true ones.
const AMBIGUOUS = new Set(['Of', 'Mobile', 'Reading', 'Split', 'Bat', 'Sale', 'Ise', 'Nice', 'Bath',
  'Batman', 'Trento', 'Kota', 'Most', 'Mar', 'Sur', 'Gay', 'Bar', 'Male', 'Hope', 'Orange',
  'Independence', 'Concord', 'Victoria', 'Columbia', 'Lincoln', 'Jackson', 'Garden Grove', 'Surprise']);

const MIN_POP = 150000;
const r = (n) => Math.round(n * 1e4) / 1e4;
const out = { cities: [], countries: [] };
for (const c of cities) {
  if (c.population < MIN_POP || AMBIGUOUS.has(c.name)) continue;
  const [lon, lat] = c.loc.coordinates;
  out.cities.push([c.name, r(lat), r(lon), c.country, c.population]);
}
out.cities.sort((a, b) => b[4] - a[4]);
for (const c of countries) {
  const names = new Set([c.name.common, c.name.official, ...(c.altSpellings || []).filter((s) => s.length > 3)]);
  const dem = c.demonyms?.eng?.m;
  if (dem && dem.length > 3) names.add(dem);
  out.countries.push([[...names], r(c.latlng[0]), r(c.latlng[1]), c.cca2, c.name.common]);
}
writeFileSync(new URL('../worker/src/gazetteer.json', import.meta.url), JSON.stringify(out));
console.log(`cities: ${out.cities.length}, countries: ${out.countries.length}`);

// Towns >= 15k people: used only to VALIDATE places the AI geocoder names
// (never for free-text matching, where small-town names cause false hits).
const TOWN_MIN_POP = 15000;
const r3 = (n) => Math.round(n * 1e3) / 1e3;
const towns = cities.filter((c) => c.population >= TOWN_MIN_POP)
  .map((c) => [c.name, r3(c.loc.coordinates[1]), r3(c.loc.coordinates[0]), c.country, c.population])
  .sort((a, b) => b[4] - a[4]);
writeFileSync(new URL('../worker/src/towns.json', import.meta.url), JSON.stringify(towns));
console.log(`towns: ${towns.length}`);
