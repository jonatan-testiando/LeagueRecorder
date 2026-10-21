// Capturas y medidas de la app en el arnés (dev-harness.html), con Playwright.
// Uso: node shots.mjs <carpeta-salida> [filtro-de-vistas]
import { chromium } from 'file:///C:/Users/Alejandro/AppData/Local/npm-cache/_npx/9833c18b2d85bc59/node_modules/playwright-core/index.mjs';
import fs from 'node:fs';
import path from 'node:path';

const OUT = process.argv[2];
const FILTER = process.argv[3] ? new RegExp(process.argv[3]) : null;
const BASE = 'http://localhost:1420/dev-harness.html';
const SIZES = [[1280, 800], [1920, 1080]];
const THEMES = ['dark', 'light'];

const clickText = (labels) => async (p) => {
  await p.evaluate((labels) => {
    const b = [...document.querySelectorAll('button, [role=tab]')].filter((x) => x.offsetParent !== null)
      .find((x) => labels.some((l) => x.textContent.trim() === l || x.textContent.trim().startsWith(l)));
    if (b) b.click(); else console.warn('no encontrado', labels);
  }, labels);
  await p.waitForTimeout(700);
};

const VIEWS = [
  { id: 'hoy', hash: '#/home' },
  { id: 'biblioteca', hash: '#/review' },
  { id: 'clips', hash: '#/clips' },
  { id: 'errores', hash: '#/errors' },
  { id: 'patrones', hash: '#/patterns' },
  { id: 'training-ejercicios', hash: '#/training' },
  { id: 'training-lectura', hash: '#/training', act: clickText(['Lectura de mapa', 'Awareness']) },
  { id: 'training-config', hash: '#/training', act: clickText(['Configuración', 'Setup']) },
  { id: 'analisis-video', hash: '#/vod' },
  ...['recording', 'storage', 'account', 'advanced', 'diagnostics'].map((c) => ({ id: `ajustes-${c}`, hash: `#/settings?cat=${c}` })),
  { id: 'reproductor-revision', q: 'player', hash: '#/review', wait: 2200 },
  { id: 'reproductor-partida', q: 'player&tab=1', hash: '#/review', wait: 2400 },
  { id: 'reproductor-impacto', q: 'player&tab=2', hash: '#/review', wait: 2400 },
  { id: 'reproductor-mapa', q: 'player', hash: '#/review', wait: 2200, act: clickText(['Mapa', 'Map']) },
  { id: 'onboarding-1', q: 'onboarding', hash: '#/home' },
  { id: 'onboarding-2', q: 'onboarding', hash: '#/home', act: async (p) => { await clickText(['Siguiente', 'Next'])(p); } },
  { id: 'onboarding-3', q: 'onboarding', hash: '#/home', act: async (p) => { await clickText(['Siguiente', 'Next'])(p); await clickText(['Siguiente', 'Next'])(p); } },
  { id: 'ctrl-k', hash: '#/home', act: async (p) => { await p.keyboard.press('Control+K'); await p.waitForTimeout(500); } },
  { id: 'ctrl-k-busqueda', hash: '#/home', act: async (p) => { await p.keyboard.press('Control+K'); await p.waitForTimeout(300); await p.keyboard.type('gwen'); await p.waitForTimeout(500); } },
  { id: 'vacio-hoy', q: 'empty', hash: '#/home' },
  { id: 'vacio-biblioteca', q: 'empty', hash: '#/review' },
  { id: 'grabando-hoy', q: 'rec', hash: '#/home' },
  // Carga: el IPC tarda 4 s y se captura a los 400 ms.
  { id: 'carga-hoy', hash: '#/home', slow: true, wait: 400 },
  { id: 'carga-biblioteca', hash: '#/review', slow: true, wait: 400 },
  { id: 'carga-patrones', hash: '#/patterns', slow: true, wait: 400 },
  { id: 'carga-reproductor', q: 'player', hash: '#/review', slow: true, wait: 900 },
];

// Censo dentro de la página: contraste, tipografía, espaciado, radios,
// recortes, objetivos pequeños, animaciones y saltos de maquetación.
function census() {
  const vis = (el) => el.offsetParent !== null || getComputedStyle(el).position === 'fixed';
  const parse = (c) => {
    const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null;
    const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  const lum = (c) => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
  const over = (top, bot) => ({ r: top.r * top.a + bot.r * (1 - top.a), g: top.g * top.a + bot.g * (1 - top.a), b: top.b * top.a + bot.b * (1 - top.a), a: 1 });
  const bgOf = (el) => {
    const stack = []; let img = false;
    for (let e = el; e; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (cs.backgroundImage && cs.backgroundImage !== 'none' && !cs.backgroundImage.startsWith('url')) img = true;
      const c = parse(cs.backgroundColor); if (c && c.a > 0) { stack.push(c); if (c.a >= 1) break; }
    }
    let base = { r: 255, g: 255, b: 255, a: 1 };
    for (let i = stack.length - 1; i >= 0; i--) base = over(stack[i], base);
    return { c: base, img };
  };
  const ratio = (a, b) => { const l1 = lum(a), l2 = lum(b); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); };
  const textEls = [...document.querySelectorAll('body *')].filter((el) => vis(el) && [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 0));
  const rows = [];
  const sizes = {}, weights = {}, families = {};
  let truncated = 0; const truncatedEx = [];
  for (const el of textEls) {
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect(); if (r.width === 0 || r.bottom < 0 || r.top > innerHeight) continue;
    const fg = parse(cs.color); if (!fg) continue;
    const { c: bg, img } = bgOf(el);
    const op = parseFloat(cs.opacity);
    const fgc = over({ ...fg, a: fg.a * (isNaN(op) ? 1 : op) }, bg);
    const cr = ratio(fgc, bg);
    const fs = parseFloat(cs.fontSize);
    sizes[fs] = (sizes[fs] || 0) + 1; weights[cs.fontWeight] = (weights[cs.fontWeight] || 0) + 1;
    const fam = cs.fontFamily.split(',')[0].replace(/['"]/g, ''); families[fam] = (families[fam] || 0) + 1;
    const txt = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join(' ').slice(0, 50);
    rows.push({ cr: +cr.toFixed(2), fs, fw: cs.fontWeight, txt, img, cls: (el.className && el.className.baseVal === undefined ? el.className : '').toString().slice(0, 40), tag: el.tagName });
    if (el.scrollWidth > el.clientWidth + 1 && (cs.textOverflow === 'ellipsis' || cs.overflow === 'hidden')) { truncated++; if (truncatedEx.length < 8) truncatedEx.push(txt); }
  }
  const large = (r) => r.fs >= 18.66 || (r.fs >= 14 && +r.fw >= 700);
  const fails = rows.filter((r) => r.cr < (large(r) ? 3 : 4.5) && !r.img);
  const body = rows.filter((r) => r.fs >= 13 && r.fs <= 16);
  const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
  const all = [...document.querySelectorAll('body *')].filter(vis);
  const pads = {}, gaps = {}, radii = {};
  let transAll = 0;
  for (const el of all) {
    const cs = getComputedStyle(el);
    for (const k of ['paddingTop', 'paddingLeft', 'marginTop', 'marginBottom']) { const v = parseFloat(cs[k]); if (v > 0) pads[v] = (pads[v] || 0) + 1; }
    const g = parseFloat(cs.rowGap || cs.gap); if (g > 0) gaps[g] = (gaps[g] || 0) + 1;
    const rad = parseFloat(cs.borderTopLeftRadius); if (rad > 0) radii[rad] = (radii[rad] || 0) + 1;
    if (cs.transitionProperty.split(',').map((s) => s.trim()).includes('all') && parseFloat(cs.transitionDuration) > 0) transAll++;
  }
  const offScale = (m) => Object.entries(m).filter(([v]) => +v % 4 !== 0).reduce((s, [, n]) => s + n, 0);
  const tot = (m) => Object.values(m).reduce((s, n) => s + n, 0);
  const small = [...document.querySelectorAll('button, a, [role=button], input[type=checkbox], [role=tab]')].filter(vis).map((el) => el.getBoundingClientRect()).filter((r) => r.width > 0 && (r.width < 24 || r.height < 24)).length;
  const sc = [...document.querySelectorAll('*')].filter((el) => vis(el) && el.scrollHeight > el.clientHeight + 40 && ['auto', 'scroll'].includes(getComputedStyle(el).overflowY)).map((el) => ({ cls: String(el.className).slice(0, 40), h: el.clientHeight, sh: el.scrollHeight, screens: +(el.scrollHeight / el.clientHeight).toFixed(2) }));
  return {
    texts: rows.length,
    contrast: { fails: fails.length, failEx: fails.sort((a, b) => a.cr - b.cr).slice(0, 10), min: Math.min(...rows.map((r) => r.cr)), bodyMedian: median(body.map((r) => r.cr)), maxRatio: Math.max(...rows.map((r) => r.cr)), over12: rows.filter((r) => r.cr > 12).length, under10Body: body.filter((r) => r.cr < 9).length },
    sizes, weights, families, distinctSizes: Object.keys(sizes).length,
    under12: rows.filter((r) => r.fs < 12).length,
    spacing: { padsOffScale: offScale(pads), padsTotal: tot(pads), gaps, distinctPads: Object.keys(pads).length },
    radii,
    truncated, truncatedEx, smallTargets: small, transitionAll: transAll,
    scrollers: sc,
    animations: document.getAnimations().map((a) => ({ name: a.animationName || a.transitionProperty || a.constructor.name, d: a.effect?.getTiming?.().duration })).slice(0, 30),
    animationsCount: document.getAnimations().length,
    cls: window.__cls ?? null,
    domNodes: document.querySelectorAll('*').length,
  };
}

const INIT = (slow) => `
  window.__cls = 0;
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__cls += e.value; }).observe({ type: 'layout-shift', buffered: true }); } catch {}
  let __ti;
  Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, get() { return __ti; }, set(v) {
    const inv = v.invoke.bind(v);
    // Huecos del arnés que tiran la app entera (sin ErrorBoundary).
    const FIX = { get_jungle_routes: [], 'plugin:window|is_maximized': false };
    const call = (c, a) => Promise.resolve(inv(c, a)).then((r) => (r == null && c in FIX ? FIX[c] : r));
    v.invoke = ${slow ? '(c, a) => new Promise((r) => setTimeout(() => r(call(c, a)), 4000))' : 'call'};
    __ti = v;
  } });
`;

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const metrics = {};
for (const theme of THEMES) for (const [w, h] of SIZES) {
  const dir = path.join(OUT, `${theme}-${w}`); fs.mkdirSync(dir, { recursive: true });
  for (const v of VIEWS) {
    if (FILTER && !FILTER.test(v.id)) continue;
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1, colorScheme: theme });
    await ctx.addInitScript(INIT(!!v.slow));
    const page = await ctx.newPage();
    const errs = []; page.on('pageerror', (e) => errs.push(String(e).slice(0, 200)));
    const q = [`theme=${theme}`, v.q].filter(Boolean).join('&');
    const t0 = Date.now();
    await page.goto(`${BASE}?${q}${v.hash}`, { waitUntil: v.slow ? 'domcontentloaded' : 'networkidle', timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(v.wait ?? 1400);
    if (v.act) await v.act(page);
    await page.screenshot({ path: path.join(dir, `${v.id}.jpg`), type: 'jpeg', quality: 86 });
    if (!v.slow && w === 1280) metrics[`${theme}/${v.id}`] = { ...(await page.evaluate(census)), errs, ms: Date.now() - t0 };
    await ctx.close();
    process.stdout.write(`${theme}-${w}/${v.id} `);
  }
}
await browser.close();
fs.writeFileSync(path.join(process.argv[4] || OUT, 'metrics.json'), JSON.stringify(metrics, null, 1));
console.log('\nhecho');
