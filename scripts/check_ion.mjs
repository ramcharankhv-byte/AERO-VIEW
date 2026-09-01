/**
 * Confirms the Cesium ion token is actually in effect.
 *
 * Checks three independent signals rather than trusting one: what the status
 * bar reports, whether the "no ion token" notice is showing, and which imagery
 * / terrain hosts the page actually fetched from.
 */
import puppeteer from 'puppeteer-core';

const CHROME =
  process.env.CHROME_PATH ??
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: [
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--no-sandbox',
    '--window-size=1680,950',
  ],
  defaultViewport: { width: 1680, height: 950 },
});

try {
  const page = await browser.newPage();
  const hosts = new Map();
  page.on('response', (r) => {
    const u = new URL(r.url());
    if (/cesium\.com|virtualearth|bing|openstreetmap/.test(u.host)) {
      const key = `${u.host}${u.pathname.split('/').slice(0, 3).join('/')}`;
      hosts.set(key, (hosts.get(key) ?? 0) + 1);
    }
  });

  await page.goto('http://localhost:3000/', {
    waitUntil: 'networkidle2',
    timeout: 90000,
  });
  await page.waitForFunction(
    () => /\d+ 3D buildings/.test(document.body.innerText),
    { timeout: 90000 },
  );
  await new Promise((r) => setTimeout(r, 10000)); // terrain sampling + tiles

  const text = await page.evaluate(() =>
    document.body.innerText.replace(/\s+/g, ' '),
  );

  const usingIon = /Cesium World Terrain/.test(text);
  const noticeShown = /No Cesium ion token/.test(text);

  console.log(`  status bar        : ${usingIon ? 'Cesium World Terrain' : 'OSM basemap - no terrain'}`);
  console.log(`  ion notice        : ${noticeShown ? 'SHOWN (token not active)' : 'hidden (token active)'}`);
  console.log('  network hosts hit :');
  for (const [h, n] of [...hosts].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
    console.log(`    ${String(n).padStart(4)}x  ${h}`);
  }

  await page.screenshot({ path: 'docs/shots/1-city-ion.png' });
  console.log('  shot -> docs/shots/1-city-ion.png');

  process.exitCode = usingIon && !noticeShown ? 0 : 1;
} finally {
  await browser.close();
}
