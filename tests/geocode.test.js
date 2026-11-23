import { test } from 'node:test';
import assert from 'node:assert/strict';
import { placeFromText, locate, countryCentroid, nearestCityLabel } from '../worker/src/geocode.js';

test('finds cities named in titles', () => {
  assert.equal(placeFromText('Best dumplings in Taipei night market').label, 'Taipei, Taiwan');
  assert.equal(placeFromText('Amazing street food in New York City!').label, 'New York City, United States');
  assert.equal(placeFromText('São Paulo pastel de feira').label.startsWith('São Paulo'), true);
});

test('finds cities in hashtags, case-insensitive', () => {
  assert.equal(placeFromText('tacos al pastor #MexicoCity').label, 'Mexico City, Mexico');
  assert.equal(placeFromText('#bangkok #streetfood').label, 'Bangkok, Thailand');
});

test('prefers a city over a country', () => {
  assert.equal(placeFromText('Thai food tour in Bangkok').label, 'Bangkok, Thailand');
});

test('falls back to a country name or demonym', () => {
  const p = placeFromText('Thai street food');
  assert.equal(p.label, 'Thailand');
  assert.equal(p.precision, 'place');
});

test('ignores lowercase words and ambiguous names', () => {
  assert.equal(placeFromText('street food tour new york'), null);
  assert.equal(placeFromText('Nice view of the sea'), null);
  assert.equal(placeFromText('Reading list for summer'), null);
  assert.equal(placeFromText(''), null);
});

test('locate: recording location wins and is labelled exact', () => {
  const p = locate({ recording: { location: { latitude: 25.03, longitude: 121.56 } }, title: 'Paris trip' });
  assert.equal(p.precision, 'exact');
  assert.equal(p.label, 'Near Taipei, Taiwan');
});

test('locate: ignores 0,0 and out-of-range coordinates', () => {
  assert.equal(locate({ recording: { location: { latitude: 0, longitude: 0 } }, title: 'x' }), null);
  assert.equal(locate({ recording: { location: { latitude: 120, longitude: 10 } }, title: 'x' }), null);
});

test('locate: tags, then channel country, then unplaced', () => {
  assert.equal(locate({ title: 'yum', tags: ['street food', 'Hanoi'] }).label, 'Hanoi, Vietnam');
  const c = locate({ title: 'yum', channelCountry: 'IN' });
  assert.deepEqual([c.label, c.precision], ['India', 'country']);
  assert.equal(locate({ title: 'yum' }), null);
  assert.equal(countryCentroid('ZZ'), null);
});

test('exact points far from any large city get a neutral label', () => {
  assert.equal(nearestCityLabel(-75, 0), 'Pinned location');
});
