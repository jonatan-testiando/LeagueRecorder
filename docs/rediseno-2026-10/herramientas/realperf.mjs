import { chromium } from 'file:///C:/Users/Alejandro/AppData/Local/npm-cache/_npx/9833c18b2d85bc59/node_modules/playwright-core/index.mjs';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const page = browser.contexts()[0].pages()[0];
const out = {};
for (const route of ['#/home', '#/review', '#/patterns']) {
  await page.evaluate((r) => { location.hash = r; }, route);
  await page.waitForTimeout(500);
  // Recarga y muestreo cada 50 ms de qué se ve.
  await page.evaluate(() => location.reload());
  const samples = [];
  const t0 = Date.now();
  for (let i = 0; i < 70; i++) {
    const s = await page.evaluate(() => ({
      lang: document.body?.innerText.includes('Today') || document.body?.innerText.includes('Library') ? 'en' : (document.body?.innerText.includes('Hoy') ? 'es' : '?'),
      theme: document.documentElement.getAttribute('data-theme'),
      rows: document.querySelectorAll('[data-match-id]').length,
      empty: /Play a game|Juega una partida/.test(document.body?.innerText ?? ''),
      spin: document.querySelectorAll('.spin, [class*=spin], .animate-spin').length,
      skel: document.querySelectorAll('[class*=skeleton]').length,
      cls: performance.getEntriesByType('layout-shift').reduce((a, e) => a + (e.hadRecentInput ? 0 : e.value), 0),
    })).catch(() => null);
    if (s) samples.push({ t: Date.now() - t0, ...s });
    await page.waitForTimeout(40);
  }
  // Resumen: primeros instantes de cada estado.
  const first = (f) => samples.find(f)?.t ?? null;
  out[route] = {
    firstEs: first((s) => s.lang === 'es'), lastEn: [...samples].reverse().find((s) => s.lang === 'en')?.t ?? null,
    firstDark: first((s) => s.theme === 'dark'), firstLight: first((s) => s.theme === 'light'), noTheme: first((s) => s.theme == null),
    firstRows: first((s) => s.rows > 0), emptyShown: samples.filter((s) => s.empty).map((s) => s.t).slice(0, 3),
    maxSpin: Math.max(...samples.map((s) => s.spin)), maxSkel: Math.max(...samples.map((s) => s.skel)),
    cls: samples.at(-1)?.cls,
  };
}
console.log(JSON.stringify(out, null, 1));
process.exit(0);
