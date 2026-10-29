// Indicators for AI-GOLD (bars = [{t,o,h,l,c}] oldest first, t in ms)
export function ema(v, n) { const k = 2 / (n + 1), out = []; let e = null; for (const x of v) { e = e === null ? x : e + k * (x - e); out.push(e); } return out; }
export function atr(b, n = 14) {
  const out = []; let a = null;
  for (let i = 0; i < b.length; i++) {
    const tr = i ? Math.max(b[i].h - b[i].l, Math.abs(b[i].h - b[i - 1].c), Math.abs(b[i].l - b[i - 1].c)) : b[i].h - b[i].l;
    a = a === null ? tr : a + (tr - a) / n; out.push(a);
  }
  return out;
}
export function rsi(v, n = 14) {
  const out = [null]; let g = 0, l = 0;
  for (let i = 1; i < v.length; i++) {
    const d = v[i] - v[i - 1], up = Math.max(d, 0), dn = Math.max(-d, 0);
    if (i <= n) { g += up / n; l += dn / n; } else { g = (g * (n - 1) + up) / n; l = (l * (n - 1) + dn) / n; }
    out.push(i < n ? null : (l === 0 ? 100 : 100 - 100 / (1 + g / l)));
  }
  return out;
}
export function adx(b, n = 14) {
  const out = []; let tr = 0, pdm = 0, mdm = 0, ax = null;
  for (let i = 0; i < b.length; i++) {
    if (!i) { out.push(null); continue; }
    const up = b[i].h - b[i - 1].h, dn = b[i - 1].l - b[i].l;
    const t = Math.max(b[i].h - b[i].l, Math.abs(b[i].h - b[i - 1].c), Math.abs(b[i].l - b[i - 1].c));
    tr += (t - tr) / n; pdm += ((up > dn && up > 0 ? up : 0) - pdm) / n; mdm += ((dn > up && dn > 0 ? dn : 0) - mdm) / n;
    const pdi = 100 * pdm / tr, mdi = 100 * mdm / tr, dx = pdi + mdi ? 100 * Math.abs(pdi - mdi) / (pdi + mdi) : 0;
    ax = ax === null ? dx : ax + (dx - ax) / n; out.push(i < 2 * n ? null : ax);
  }
  return out;
}
// confirmed fractal swings: k bars on each side
export function swings(b, k = 3, maxN = 8) {
  const hi = [], lo = [];
  for (let i = b.length - 1 - k; i >= k && (hi.length < maxN || lo.length < maxN); i--) {
    let isH = true, isL = true;
    for (let j = 1; j <= k; j++) { if (b[i - j].h >= b[i].h || b[i + j].h > b[i].h) isH = false; if (b[i - j].l <= b[i].l || b[i + j].l < b[i].l) isL = false; }
    if (isH && hi.length < maxN) hi.push({ t: b[i].t, p: b[i].h });
    if (isL && lo.length < maxN) lo.push({ t: b[i].t, p: b[i].l });
  }
  return { hi, lo };
}
// aggregate H1 bars into H4 / D1 (by server-time bucket)
export function agg(b, hours) {
  const out = []; const ms = hours * 3600e3;
  for (const x of b) {
    const k = Math.floor(x.t / ms) * ms, last = out[out.length - 1];
    if (last && last.t === k) { last.h = Math.max(last.h, x.h); last.l = Math.min(last.l, x.l); last.c = x.c; }
    else out.push({ t: k, o: x.o, h: x.h, l: x.l, c: x.c });
  }
  return out;
}
