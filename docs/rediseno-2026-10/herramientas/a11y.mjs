import { chromium } from 'file:///C:/Users/Alejandro/AppData/Local/npm-cache/_npx/9833c18b2d85bc59/node_modules/playwright-core/index.mjs';
const OUT = process.argv[2];
const b = await chromium.launch({ channel: 'chrome', headless: true });
const res = {};
for (const theme of ['dark', 'light']) {
  const ctx = await b.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: theme, reducedMotion: 'reduce' });
  await ctx.addInitScript(`let __ti; Object.defineProperty(window,'__TAURI_INTERNALS__',{configurable:true,get(){return __ti},set(v){const inv=v.invoke.bind(v);const F={get_jungle_routes:[]};v.invoke=(c,a)=>Promise.resolve(inv(c,a)).then(r=>r==null&&c in F?F[c]:r);__ti=v;}});`);
  const p = await ctx.newPage();
  await p.goto(`http://localhost:1420/dev-harness.html?theme=${theme}#/home`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(1200);
  const focus = [];
  for (let i = 0; i < 14; i++) {
    await p.keyboard.press('Tab');
    focus.push(await p.evaluate(() => { const e = document.activeElement; const cs = getComputedStyle(e); const r = e.getBoundingClientRect();
      return { tag: e.tagName, txt: (e.getAttribute('aria-label') || e.textContent || '').trim().slice(0, 28), outline: cs.outlineStyle !== 'none' ? `${cs.outlineWidth} ${cs.outlineStyle} ${cs.outlineColor}` : 'none', shadow: cs.boxShadow !== 'none', y: Math.round(r.top) }; }));
    if (i === 5) await p.screenshot({ path: `${OUT}/foco-${theme}.jpg`, type: 'jpeg', quality: 86 });
  }
  // Movimiento reducido: ¿las animaciones quedan a 0,01 ms (spinners congelados)?
  const rm = await p.evaluate(() => ({ dur: getComputedStyle(document.querySelector('.panel-enter') || document.body).animationDuration, reduce: matchMedia('(prefers-reduced-motion: reduce)').matches }));
  const landmarks = await p.evaluate(() => ({ main: document.querySelectorAll('main,[role=main]').length, nav: document.querySelectorAll('nav').length, h1: document.querySelectorAll('h1').length, imgNoAlt: [...document.querySelectorAll('img')].filter((i) => !i.hasAttribute('alt')).length, btnNoName: [...document.querySelectorAll('button')].filter((x) => x.offsetParent && !(x.textContent.trim() || x.getAttribute('aria-label') || x.title)).length, lang: document.documentElement.lang }));
  res[theme] = { focus, rm, landmarks };
  await ctx.close();
}
console.log(JSON.stringify(res, null, 1));
await b.close();
