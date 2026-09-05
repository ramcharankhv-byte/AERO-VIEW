/**
 * Bhuvan WMS helpers.
 *
 * Run with:  node --test lib/bhuvan.test.ts
 *
 * These pin the two things that silently break a WMS 1.3.0 integration: the
 * lat,lon axis order of the EPSG:4326 bbox, and the parse of GeoServer's two
 * GetFeatureInfo formats. Both are pure, which is why they live in
 * lib/bhuvan.ts rather than beside the Cesium provider.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildGetFeatureInfoUrl, buildLegendUrl, formatLulcLine, lulcClassLabel,
  parseFeatureInfoHtml, parseFeatureInfoJson,
} from './bhuvan.ts';

const LAYER = 'sisdpv2:AP_Visakhapatnam_lulc_v2';
const LON = 83.31875;
const LAT = 17.723;

test('GetFeatureInfo bbox is south,west,north,east and centred on the point', () => {
  const u = new URL(buildGetFeatureInfoUrl(LAYER, LON, LAT));
  assert.equal(u.searchParams.get('VERSION'), '1.3.0');
  assert.equal(u.searchParams.get('CRS'), 'EPSG:4326');
  assert.equal(u.searchParams.get('LAYERS'), LAYER);
  assert.equal(u.searchParams.get('QUERY_LAYERS'), LAYER);
  const [south, west, north, east] = (u.searchParams.get('BBOX') ?? '').split(',').map(Number);
  assert.ok(south < LAT && LAT < north, 'lat inside the first/third pair');
  assert.ok(west < LON && LON < east, 'lon inside the second/fourth pair');
  assert.ok(Math.abs((south + north) / 2 - LAT) < 1e-6);
  assert.ok(Math.abs((west + east) / 2 - LON) < 1e-6);
  // The latitude span is the smaller one: latitude is the first coordinate.
  assert.ok(north - south < east - west);
});

test('GetFeatureInfo asks for the centre pixel of an 800x700 window, JSON first', () => {
  const u = new URL(buildGetFeatureInfoUrl(LAYER, LON, LAT));
  assert.equal(u.searchParams.get('WIDTH'), '800');
  assert.equal(u.searchParams.get('HEIGHT'), '700');
  assert.equal(u.searchParams.get('I'), '400');
  assert.equal(u.searchParams.get('J'), '350');
  assert.equal(u.searchParams.get('INFO_FORMAT'), 'application/json');
  const h = new URL(buildGetFeatureInfoUrl(LAYER, LON, LAT, 'text/html'));
  assert.equal(h.searchParams.get('INFO_FORMAT'), 'text/html');
});

test('GetLegendGraphic names the layer and asks for a PNG', () => {
  const u = new URL(buildLegendUrl(LAYER));
  assert.equal(u.origin + u.pathname, 'https://bhuvan-vec2.nrsc.gov.in/bhuvan/ows');
  assert.equal(u.searchParams.get('REQUEST'), 'GetLegendGraphic');
  assert.equal(u.searchParams.get('LAYER'), LAYER);
  assert.equal(u.searchParams.get('FORMAT'), 'image/png');
});

test('parses the JSON GeoServer answers for Siripuram', () => {
  const r = parseFeatureInfoJson({
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      id: 'AP_Visakhapatnam_lulc_v2.36335',
      properties: {
        PI_CODE: 'Vishakhapatnam', AREA: 2224.5, lc_code: 'BUUC',
        dscr1: 'Built up', dscr2: 'Built up (Urban)', dscr3: 'Core urban', webcode: 1,
      },
    }],
  });
  assert.deepEqual(r, { code: 'BUUC', cls: 'Built up (Urban)', detail: 'Core urban' });
  assert.equal(lulcClassLabel(r!), 'Built up (Urban), Core urban');
  assert.equal(formatLulcLine(r!), 'LULC: Built up (Urban), Core urban — SISDP 1:10k (Bhuvan)');
});

test('an empty FeatureCollection is "no class here", not an error', () => {
  assert.equal(parseFeatureInfoJson({ type: 'FeatureCollection', features: [] }), null);
  assert.throws(() => parseFeatureInfoJson({ error: 'nope' }));
});

test('parses the text/html fallback', () => {
  const html = `<html><body><table class="featureInfo">
    <caption class="featureInfo">AP_Visakhapatnam_lulc_v2</caption>
    <tr><th>fid</th><th >PI_CODE</th><th >AREA</th><th >lc_code</th>
        <th >dscr1</th><th >dscr2</th><th >dscr3</th><th >webcode</th></tr>
    <tr><td>AP_Visakhapatnam_lulc_v2.36335</td><td>Vishakhapatnam</td><td>2224.5</td>
        <td>BUUC</td><td>Built up</td><td>Built up (Urban)</td><td>Core urban</td><td>1</td></tr>
  </table></body></html>`;
  assert.deepEqual(parseFeatureInfoHtml(html),
    { code: 'BUUC', cls: 'Built up (Urban)', detail: 'Core urban' });
  assert.equal(parseFeatureInfoHtml('<html><body></body></html>'), null);
});
