// Contraste WCAG y OKLCH de pares de tokens.
const hex = (h) => { h = h.replace('#', ''); return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255); };
const lin = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const L = (h) => { const [r, g, b] = hex(h).map(lin); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
export const cr = (a, b) => { const x = L(a), y = L(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
export const oklch = (h) => {
  const [r, g, b] = hex(h).map(lin);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const LL = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return [+LL.toFixed(3), +Math.hypot(A, B).toFixed(3), Math.round(((Math.atan2(B, A) * 180) / Math.PI + 360) % 360)];
};
const sets = JSON.parse(process.argv[2]);
for (const [name, t] of Object.entries(sets)) {
  console.log(`\n== ${name}`);
  for (const bg of t.bgs) {
    const line = t.fgs.map((fg) => `${fg}:${cr(fg, bg).toFixed(2)}`).join('  ');
    console.log(`${bg} L${oklch(bg)[0]} | ${line}`);
  }
}
