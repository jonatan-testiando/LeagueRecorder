// Capturas de la app INSTALADA con datos reales, por CDP (puerto 9222).
// No cambia la configuración: el tema se alterna solo con el atributo data-theme.
import { chromium } from 'file:///C:/Users/Alejandro/AppData/Local/npm-cache/_npx/9833c18b2d85bc59/node_modules/playwright-core/index.mjs';
import fs from 'node:fs';
import path from 'node:path';

const OUT = process.argv[2];
fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const page = browser.contexts()[0].pages().find((p) => !p.url().startsWith('devtools')) ?? browser.contexts()[0].pages()[0];
const cdp = await page.context().newCDPSession(page);
const info = { url: page.url(), version: await page.evaluate(() => document.querySelector('.rail-version')?.textContent ?? null) };

const go = async (hash) => { await page.evaluate((h) => { location.hash = h; }, hash); await page.waitForTimeout(1800); };
const clickText = async (labels) => {
  await page.evaluate((labels) => {
    const b = [...document.querySelectorAll('button, [role=tab]')].filter((x) => x.offsetParent !== null)
      .find((x) => labels.some((l) => x.textContent.trim().startsWith(l)));
    if (b) b.click();
  }, labels);
  await page.waitForTimeout(1500);
};
const shot = async (name) => { await page.screenshot({ path: path.join(OUT, `${name}.jpg`), type: 'jpeg', quality: 86 }); process.stdout.write(name + ' '); };
const setTheme = (t) => page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), t);
const origTheme = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
info.theme = origTheme;

for (const [w, h] of [[1280, 800], [1920, 1080]]) {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
  for (const theme of ['dark', 'light']) {
    await setTheme(theme);
    const p = `${theme}-${w}`;
    await go('#/home'); await shot(`${p}-hoy`);
    await go('#/review'); await shot(`${p}-biblioteca`);
    await go('#/patterns'); await page.waitForTimeout(1500); await shot(`${p}-patrones`);
    if (w === 1280) {
      await go('#/review');
      await page.evaluate(() => { const r = document.querySelector('[data-match-id]'); r?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); r?.click(); });
      await page.keyboard.press('Enter'); await page.waitForTimeout(2500);
      await shot(`${p}-reproductor-revision`);
      await clickText(['Partida', 'Match']); await shot(`${p}-reproductor-partida`);
      await clickText(['Impacto', 'Impact']); await shot(`${p}-reproductor-impacto`);
      await clickText(['Mapa', 'Map']); await page.waitForTimeout(1200); await shot(`${p}-reproductor-mapa`);
      await clickText(['Vídeo', 'Video']);
      await page.keyboard.press('Escape');
      await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find((x) => x.getAttribute('aria-label')?.match(/Volver|Back/) || x.title?.match(/Volver|Back/)); b?.click(); });
      await page.waitForTimeout(800);
    }
  }
}
await setTheme(origTheme ?? 'dark');
await cdp.send('Emulation.clearDeviceMetricsOverride');
// Métrica real: cuánto tarda la biblioteca en pintar sus filas tras recargar.
fs.writeFileSync(path.join(OUT, 'info.json'), JSON.stringify(info, null, 1));
console.log('\n', JSON.stringify(info));
process.exit(0);
