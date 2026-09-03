/**
 * Capture what the page actually shows, to debug the verify:ui timing.
 */
import puppeteer from 'puppeteer-core';

const URL = 'http://localhost:3000/p/siripuram';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

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
  const consoleMsgs = [];
  page.on('console', (m) => consoleMsgs.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => consoleMsgs.push(`PAGEERROR ${String(e)}`));

  console.log(`navigating to ${URL}`);
  await page.goto(URL, { waitUntil: 'networkidle2', timeout: 120000 });
  console.log('  page loaded');

  // Capture text every 2s for 20s
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const text = await page.evaluate(() =>
      document.body.innerText.replace(/\s+/g, ' ').trim().slice(0, 200),
    );
    console.log(`[${(i + 1) * 2}s] ${text}`);
  }

  console.log('\n--- CONSOLE MSGS ---');
  for (const m of consoleMsgs.slice(-20)) console.log('  ' + m);
} finally {
  await browser.close();
}
