/**
 * Reproduce the "click building → error" flow and capture every console
 * message, page error, and request failure, so we can see exactly what
 * blows up.
 */
import puppeteer from 'puppeteer-core';

const URL = 'http://localhost:3000/p/siripuram';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const errors = [];
const consoleMsgs = [];

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: [
    '--window-size=1680,950',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--hide-scrollbars',
    '--no-sandbox',
  ],
  defaultViewport: { width: 1680, height: 950 },
});

try {
  const page = await browser.newPage();
  page.on('console', (m) => {
    const txt = `[${m.type()}] ${m.text()}`;
    consoleMsgs.push(txt);
    if (m.type() === 'error') errors.push(txt);
  });
  page.on('pageerror', (e) => errors.push(`PAGEERROR ${String(e)}`));
  page.on('requestfailed', (r) =>
    errors.push(`REQFAIL ${r.url().slice(0, 120)} -- ${r.failure()?.errorText}`));

  console.log(`navigating to ${URL}`);
  await page.goto(URL, { waitUntil: 'networkidle2', timeout: 120000 });

  console.log('waiting for the building count to appear in the status bar...');
  await page.waitForFunction(
    () => /384 3D buildings/.test(document.body.innerText),
    { timeout: 300000 },
  );
  console.log('  status bar shows the building count -- data is loaded');

  await new Promise((r) => setTimeout(r, 4000));

  console.log('typing a ULPIN into the search box...');
  await page.click('input[placeholder*="Search"]');
  await page.type('input[placeholder*="Search"]', 'AP-VSP-3D26-0001');
  await new Promise((r) => setTimeout(r, 1500));

  const searchHits = await page.evaluate(() => {
    const btns = [...document.querySelectorAll('button')].filter((b) =>
      /AP-VSP-3D26-0001/.test(b.innerText),
    );
    return btns.length;
  });
  console.log(`  search returned ${searchHits} candidate buttons`);

  if (searchHits > 0) {
    console.log('clicking the first match...');
    await page.evaluate(() => {
      const btn = [...document.querySelectorAll('button')].find((b) =>
        /AP-VSP-3D26-0001/.test(b.innerText),
      );
      if (btn) btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    await new Promise((r) => setTimeout(r, 5000));
  }

  const panel = await page.evaluate(() =>
    document.body.innerText.replace(/\s+/g, ' ').trim().slice(0, 600),
  );
  console.log('---PANEL TEXT---');
  console.log(panel);
  console.log('---END PANEL---');

  await page.screenshot({ path: 'docs/shots/repro-building.png' });
  console.log('screenshot -> docs/shots/repro-building.png');

  console.log('\n--- ERRORS (' + errors.length + ') ---');
  for (const e of errors) console.log('  ' + e);
  console.log('\n--- LAST 20 CONSOLE MSGS ---');
  for (const m of consoleMsgs.slice(-20)) console.log('  ' + m);
} finally {
  await browser.close();
}
