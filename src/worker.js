// AI-GOLD — Claude plans gold trades every closed H1 bar, PAPER ONLY (no orders anywhere).
// Separate from Mark1 / forex-agent (owner 2026-10-29: "เราไม่ยุ่งกับ mark 1"): own repo, Worker, D1, and a bars-only EA in the Exness terminal.
//  - POST /ea/bars  (Bearer token, hash in docs('secrets','ea')): the EA posts closed M15 + H1 bars every new M15 bar
//  - every new M15 bar: paper engine fills/stops pending + open trades on the new M15 bars (conservative: stop first, no TP in the fill bar)
//  - every new H1 bar: build context (H1/H4/D1 bars, EMA/ATR/RSI/ADX, swings, open trade, recent results, lessons) -> Claude -> plan JSON
//    -> HARD RULES (code, not the AI) validate it -> paper order. Benchmark twin: random side, same SL/TP distances, opened when the AI fills.
//  - /api/* (password, PBKDF2) for the web page in /public
// Pre-registered evaluation (2026-10-29): >= 50 closed AI trades; AI avg R >= +0.10 AND >= twin avg R + 0.15; no rule violations executed.
import { ema, atr, rsi, adx, swings, agg } from './ind.js';

const MODEL = 'claude-sonnet-5-5';
const RULES = {
  maxOpen: 1,              // one AI trade (pending or open) at a time
  minRiskAtr: 0.4, maxRiskAtr: 3.0,   // SL distance in H1 ATR
  minRR: 1.0,              // TP distance >= 1 x SL distance
  maxExpiryH: 6,           // pending orders live at most 6 hours
  maxLossStreakPause: 8,   // 8 losses in a row -> stop new AI entries until a person resumes
};

const enc = new TextEncoder();
const json = (d, s = 200, h = {}) => new Response(JSON.stringify(d), { status: s, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...h } });
const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const sha256 = async s => b64(await crypto.subtle.digest('SHA-256', enc.encode(s)));
const rand = () => b64(crypto.getRandomValues(new Uint8Array(24)));
const nowIso = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
const iso = ms => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
const r2 = x => Math.round(x * 100) / 100;
async function pbkdf2(pw, salt) {
  const key = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveBits']);
  return b64(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(salt), iterations: 100000 }, key, 256));
}
function safeEqual(a, b) { if (!a || !b || a.length !== b.length) return false; let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0; }
const kvGet = async (env, k, d = null) => { const r = await env.DB.prepare('SELECT v FROM kv WHERE k=?').bind(k).first(); return r ? r.v : d; };
const kvSet = (env, k, v) => env.DB.prepare('INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').bind(k, String(v)).run();
const getDoc = async (env, c, id) => { const r = await env.DB.prepare('SELECT data FROM docs WHERE coll=? AND id=?').bind(c, id).first(); return r ? JSON.parse(r.data) : null; };
const setDoc = (env, c, id, d) => env.DB.prepare('INSERT INTO docs VALUES(?,?,?) ON CONFLICT(coll,id) DO UPDATE SET data=excluded.data').bind(c, id, JSON.stringify(d)).run();
const event = (env, level, msg) => env.DB.prepare('INSERT INTO events(time,level,msg) VALUES(?,?,?)').bind(nowIso(), level, String(msg).slice(0, 1000)).run();

// ---------------- auth ----------------
async function session(req, env) {
  const c = (req.headers.get('cookie') || '').match(/ag_session=([^;]+)/); if (!c) return false;
  const a = await getDoc(env, 'secrets', 'auth'); return !!(a && a.sessions && a.sessions[await sha256(c[1])] > Date.now());
}
async function login(req, env) {
  const { password, setup } = await req.json().catch(() => ({}));
  if (!password || password.length < 6) return json({ error: 'รหัสผ่านต้องยาวอย่างน้อย 6 ตัว' }, 400);
  let a = await getDoc(env, 'secrets', 'auth');
  if (!a) {
    if (!setup) return json({ error: 'ยังไม่ได้ตั้งรหัสผ่าน', needSetup: true }, 401);
    const salt = rand(); a = { salt, hash: await pbkdf2(password, salt), sessions: {} };
  } else if (!safeEqual(await pbkdf2(password, a.salt), a.hash)) { await new Promise(r => setTimeout(r, 800)); return json({ error: 'รหัสผ่านไม่ถูกต้อง' }, 401); }
  const tok = rand(), now = Date.now();
  a.sessions = Object.fromEntries(Object.entries(a.sessions || {}).filter(([, e]) => e > now)); a.sessions[await sha256(tok)] = now + 30 * 86400e3;
  await setDoc(env, 'secrets', 'auth', a);
  return json({ ok: true }, 200, { 'set-cookie': `ag_session=${tok}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${30 * 86400}` });
}
async function eaAuth(req, env) {
  const h = req.headers.get('authorization') || ''; const tok = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  const d = await getDoc(env, 'secrets', 'ea'); return !!(tok && d && safeEqual(await sha256(tok), d.hash));
}

// ---------------- bars ----------------
const mk = rows => (rows || []).map(b => ({ t: +b[0] * 1000, o: +b[1], h: +b[2], l: +b[3], c: +b[4] })).filter(b => b.c > 0).sort((a, b) => a.t - b.t);
async function storeBars(env, tf, bars, sinceT) {
  const nw = bars.filter(b => b.t > sinceT).slice(-500);
  if (!nw.length) return;
  const st = env.DB.prepare('INSERT OR REPLACE INTO bars VALUES(?,?,?,?,?,?)');
  for (let i = 0; i < nw.length; i += 50) await env.DB.batch(nw.slice(i, i + 50).map(b => st.bind(tf, b.t, b.o, b.h, b.l, b.c)));
  await env.DB.prepare('DELETE FROM bars WHERE tf=? AND t < ?').bind(tf, bars[0].t - 1).run();
}

// ---------------- paper engine (bid bars; buys fill/exit with spread) ----------------
// returns updated trade or null if unchanged. Conservative: in one bar the stop is checked before the target; no target in the fill bar.
function stepTrade(tr, b, spread) {
  const s = tr.side; let ch = false;
  if (tr.status === 'pending') {
    if (b.t >= tr.expiry_t) { tr.status = 'cancelled'; tr.exit_reason = 'expired'; tr.exit_t = b.t; return true; }
    const askH = b.h + spread, askL = b.l + spread; let fill = null;
    if (tr.otype === 'stop') fill = s > 0 ? (askH >= tr.entry ? Math.max(tr.entry, b.o + spread) : null) : (b.l <= tr.entry ? Math.min(tr.entry, b.o) : null);
    else fill = s > 0 ? (askL <= tr.entry ? Math.min(tr.entry, b.o + spread) : null) : (b.h >= tr.entry ? Math.max(tr.entry, b.o) : null);
    if (fill === null) return false;
    tr.status = 'open'; tr.fill = fill; tr.fill_t = b.t; ch = true;
    // stop inside the fill bar (conservative: any touch of the stop after the fill counts)
    if ((s > 0 && b.l <= tr.sl) || (s < 0 && b.h + spread >= tr.sl)) return close(tr, tr.sl, b.t, 'sl');
    return ch;
  }
  if (tr.status !== 'open') return false;
  if ((s > 0 && b.l <= tr.sl) || (s < 0 && b.h + spread >= tr.sl)) return close(tr, tr.sl, b.t, tr.sl * s > tr.sl_init * s ? 'trail' : 'sl');
  if (b.t > tr.fill_t && ((s > 0 && b.h >= tr.tp) || (s < 0 && b.l + spread <= tr.tp))) return close(tr, tr.tp, b.t, 'tp');
  return ch;
}
function close(tr, px, t, why) {
  tr.status = 'closed'; tr.exit = px; tr.exit_t = t; tr.exit_reason = why;
  tr.r = Math.round(tr.side * (px - tr.fill) / Math.abs(tr.fill - tr.sl_init) * 1000) / 1000; return true;
}
async function saveTrade(env, tr) {
  await env.DB.prepare('UPDATE trades SET status=?, sl=?, fill_t=?, fill=?, exit_t=?, exit=?, r=?, exit_reason=?, lesson=? WHERE id=?')
    .bind(tr.status, tr.sl, tr.fill_t ?? null, tr.fill ?? null, tr.exit_t ?? null, tr.exit ?? null, tr.r ?? null, tr.exit_reason ?? null, tr.lesson ?? null, tr.id).run();
}
async function insertTrade(env, tr) {
  const r = await env.DB.prepare(`INSERT INTO trades(kind,status,side,otype,created,created_t,expiry_t,entry,sl,sl_init,tp,fill_t,fill,decision_id,twin_of)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(tr.kind, tr.status, tr.side, tr.otype, nowIso(), tr.created_t, tr.expiry_t, tr.entry, tr.sl, tr.sl_init, tr.tp,
    tr.fill_t ?? null, tr.fill ?? null, tr.decision_id ?? null, tr.twin_of ?? null).run();
  tr.id = r.meta.last_row_id; return tr;
}
async function runEngine(env, m15, spread, sinceT) {
  const live = (await env.DB.prepare("SELECT * FROM trades WHERE status IN ('pending','open') ORDER BY id").all()).results;
  if (!live.length) return [];
  const closed = [];
  for (const b of m15.filter(x => x.t > sinceT)) {
    for (const tr of live) {
      if (tr.status !== 'pending' && tr.status !== 'open') continue;
      if (b.t < tr.created_t) continue;
      const wasPending = tr.status === 'pending';
      if (stepTrade(tr, b, spread)) {
        await saveTrade(env, tr);
        if (tr.kind === 'ai' && wasPending && tr.fill_t) {   // benchmark twin: random side, same distances, opened at the AI fill
          const side = crypto.getRandomValues(new Uint8Array(1))[0] & 1 ? 1 : -1, dSL = Math.abs(tr.entry - tr.sl_init), dTP = Math.abs(tr.tp - tr.entry);
          const bid = tr.side > 0 ? tr.fill - spread : tr.fill, fill = side > 0 ? bid + spread : bid;
          const tw = await insertTrade(env, { kind: 'rand', status: 'open', side, otype: 'market', created_t: tr.fill_t, expiry_t: tr.fill_t, entry: fill,
            sl: fill - side * dSL, sl_init: fill - side * dSL, tp: fill + side * dTP, fill_t: tr.fill_t, fill, decision_id: tr.decision_id, twin_of: tr.id });
          live.push(tw);
        }
        if (tr.status === 'closed') closed.push(tr);
      }
    }
  }
  return closed;
}

// ---------------- context for the AI ----------------
function context(h1, m15, spread, live, recent, lessons, lastLesson) {
  const c = h1.map(b => b.c), A = atr(h1), R = rsi(c), X = adx(h1), E20 = ema(c, 20), E50 = ema(c, 50), E200 = ema(c, 200);
  const i = h1.length - 1, H4 = agg(h1, 4), D1 = agg(h1, 24), e50h4 = ema(H4.map(b => b.c), 50);
  const sw = swings(h1, 3, 8), swH4 = swings(H4, 2, 6);
  const fmt = b => `${iso(b.t)},${b.o.toFixed(2)},${b.h.toFixed(2)},${b.l.toFixed(2)},${b.c.toFixed(2)}`;
  const last = m15[m15.length - 1];
  return {
    now_bar: iso(h1[i].t), price: last.c, spread: r2(spread),
    indicators_h1: { ema20: r2(E20[i]), ema50: r2(E50[i]), ema200: r2(E200[i]), atr14: r2(A[i]), rsi14: r2(R[i]), adx14: r2(X[i] ?? 0),
      ema50_h4: r2(e50h4[e50h4.length - 1]) },
    swings_h1: { highs: sw.hi.map(x => [iso(x.t), r2(x.p)]), lows: sw.lo.map(x => [iso(x.t), r2(x.p)]) },
    swings_h4: { highs: swH4.hi.map(x => [iso(x.t), r2(x.p)]), lows: swH4.lo.map(x => [iso(x.t), r2(x.p)]) },
    d1_last20: D1.slice(-20).map(fmt), h4_last40: H4.slice(-40).map(fmt), h1_last72: h1.slice(-72).map(fmt), m15_last16: m15.slice(-16).map(fmt),
    open_or_pending: live.map(t => ({ id: t.id, status: t.status, side: t.side > 0 ? 'buy' : 'sell', type: t.otype, entry: t.fill ?? t.entry, sl: t.sl, sl_init: t.sl_init, tp: t.tp,
      opened: t.fill_t ? iso(t.fill_t) : null, expires: t.status === 'pending' ? iso(t.expiry_t) : null })),
    recent_results: recent.map(t => ({ side: t.side > 0 ? 'buy' : 'sell', opened: iso(t.fill_t), r: t.r, exit: t.exit_reason })),
    lessons, just_closed: lastLesson,
  };
}
const SYSTEM = `You are AI-GOLD, a disciplined discretionary trader of XAUUSD (gold), deciding once per closed H1 bar. This is a PAPER forward test
(no real money) that the owner watches on a web page, so explain your reasoning briefly in Thai.
Prices are broker bid prices, server time. Hard rules are enforced by code; a plan that breaks them is rejected:
- at most ONE trade (pending or open) at a time; every new trade MUST have a stop loss and take profit
- stop distance between ${RULES.minRiskAtr} and ${RULES.maxRiskAtr} x H1 ATR; take profit at least ${RULES.minRR} x the stop distance
- pending orders expire after at most ${RULES.maxExpiryH} hours; buy_stop above price, sell_stop below, buy_limit below, sell_limit above
- move_sl may only tighten the stop of the open trade; no averaging, no adding to a position
You may (and often should) choose "wait". Prefer clear structure (trend, swing levels, ranges, breakouts/retests) over prediction.
Use the lessons list: they are notes you wrote after earlier trades. If a trade just closed, write one short lesson (Thai) about it.`;
const TOOL = {
  name: 'submit_plan', description: 'Submit the plan for this H1 bar.',
  input_schema: { type: 'object', required: ['bias', 'market_view', 'levels', 'action', 'reasoning'], properties: {
    bias: { type: 'string', enum: ['up', 'down', 'neutral'] },
    market_view: { type: 'string', description: 'Thai, 1-2 sentences: what the market is doing' },
    levels: { type: 'array', maxItems: 6, items: { type: 'object', required: ['price', 'kind'], properties: {
      price: { type: 'number' }, kind: { type: 'string', enum: ['support', 'resistance', 'pivot'] }, note: { type: 'string' } } } },
    action: { type: 'string', enum: ['wait', 'buy_stop', 'sell_stop', 'buy_limit', 'sell_limit', 'buy_market', 'sell_market', 'move_sl', 'close', 'cancel_pending'] },
    entry: { type: 'number' }, sl: { type: 'number' }, tp: { type: 'number' }, expiry_hours: { type: 'number' },
    confidence: { type: 'integer', minimum: 0, maximum: 100 },
    reasoning: { type: 'string', description: 'Thai, 2-4 sentences' },
    lesson: { type: 'string', description: 'Thai, one sentence, only when just_closed is not null' } } },
};
async function askClaude(env, ctxObj) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: MODEL, max_tokens: 1500, system: SYSTEM, tools: [TOOL], tool_choice: { type: 'tool', name: 'submit_plan' },
      messages: [{ role: 'user', content: 'Market context (JSON):\n' + JSON.stringify(ctxObj) }] }),
  });
  const d = await r.json();
  if (!r.ok) throw new Error(`Claude API ${r.status}: ${JSON.stringify(d).slice(0, 300)}`);
  const tu = (d.content || []).find(x => x.type === 'tool_use');
  if (!tu) throw new Error('no plan in reply');
  return { plan: tu.input, usage: d.usage || {} };
}

// ---------------- hard rules ----------------
function validate(p, price, spread, atrH1, live) {
  const a = p.action; const open = live.find(t => t.status === 'open'), pend = live.find(t => t.status === 'pending');
  if (a === 'wait') return { ok: true };
  if (a === 'close') return open ? { ok: true } : { ok: false, why: 'ไม่มีไม้เปิดให้ปิด' };
  if (a === 'cancel_pending') return pend ? { ok: true } : { ok: false, why: 'ไม่มีออเดอร์รอ' };
  if (a === 'move_sl') {
    if (!open) return { ok: false, why: 'ไม่มีไม้เปิด' };
    if (!(p.sl > 0) || open.side * (p.sl - open.sl) <= 0) return { ok: false, why: 'ขยับ SL ได้เฉพาะทางที่แคบลง' };
    if (open.side > 0 ? p.sl >= price : p.sl <= price + spread) return { ok: false, why: 'SL ใหม่เลยราคาปัจจุบัน' };
    return { ok: true };
  }
  if (live.length >= RULES.maxOpen) return { ok: false, why: 'มีไม้/ออเดอร์อยู่แล้ว (สูงสุด 1)' };
  const side = a.startsWith('buy') ? 1 : -1, type = a.split('_')[1];
  const entry = type === 'market' ? (side > 0 ? price + spread : price) : +p.entry;
  if (!(entry > 0) || !(p.sl > 0) || !(p.tp > 0)) return { ok: false, why: 'ไม่มี entry/SL/TP' };
  const dSL = side * (entry - p.sl), dTP = side * (p.tp - entry);
  if (dSL <= 0 || dTP <= 0) return { ok: false, why: 'SL/TP อยู่ผิดฝั่ง' };
  if (dSL < RULES.minRiskAtr * atrH1 || dSL > RULES.maxRiskAtr * atrH1) return { ok: false, why: `ระยะ SL ${r2(dSL)} นอกช่วง ${RULES.minRiskAtr}-${RULES.maxRiskAtr} ATR (${r2(atrH1)})` };
  if (dTP < RULES.minRR * dSL) return { ok: false, why: 'TP น้อยกว่า 1R' };
  if (type === 'stop' && (side > 0 ? entry <= price + spread : entry >= price)) return { ok: false, why: 'stop order อยู่ผิดฝั่งของราคา' };
  if (type === 'limit' && (side > 0 ? entry >= price + spread : entry <= price)) return { ok: false, why: 'limit order อยู่ผิดฝั่งของราคา' };
  return { ok: true, side, type, entry };
}

async function decide(env, h1, m15, spread) {
  if (!env.ANTHROPIC_API_KEY) { await event(env, 'WARN', 'ยังไม่ได้ใส่ ANTHROPIC_API_KEY'); return; }
  if ((await kvGet(env, 'paused', '0')) === '1') return;
  const live = (await env.DB.prepare("SELECT * FROM trades WHERE kind='ai' AND status IN ('pending','open')").all()).results;
  const recent = (await env.DB.prepare("SELECT * FROM trades WHERE kind='ai' AND status='closed' ORDER BY exit_t DESC LIMIT 8").all()).results;
  const L = (await getDoc(env, 'state', 'lessons')) || { items: [] };
  const needLesson = (await env.DB.prepare("SELECT * FROM trades WHERE kind='ai' AND status='closed' AND lesson IS NULL ORDER BY exit_t DESC LIMIT 1").first());
  const A = atr(h1), atrH1 = A[A.length - 1], price = m15[m15.length - 1].c;
  const cx = context(h1, m15, spread, live, recent, L.items.slice(-15), needLesson ? { id: needLesson.id, side: needLesson.side > 0 ? 'buy' : 'sell',
    entry: needLesson.fill, sl_init: needLesson.sl_init, tp: needLesson.tp, exit: needLesson.exit, r: needLesson.r, why: needLesson.exit_reason, opened: iso(needLesson.fill_t), closed: iso(needLesson.exit_t) } : null);
  let plan, usage;
  try { ({ plan, usage } = await askClaude(env, cx)); } catch (e) { await event(env, 'ERROR', e.message); return; }
  const v = validate(plan, price, spread, atrH1, live);
  const d = await env.DB.prepare('INSERT INTO decisions(time,bar_t,model,tokens_in,tokens_out,plan,valid,note) VALUES(?,?,?,?,?,?,?,?)')
    .bind(nowIso(), h1[h1.length - 1].t, MODEL, usage.input_tokens || 0, usage.output_tokens || 0, JSON.stringify({ ...plan, price, atr: r2(atrH1) }), v.ok ? 1 : 0, v.ok ? null : v.why).run();
  const did = d.meta.last_row_id;
  if (needLesson && plan.lesson) {
    await env.DB.prepare('UPDATE trades SET lesson=? WHERE id=?').bind(String(plan.lesson).slice(0, 300), needLesson.id).run();
    L.items.push({ t: nowIso(), r: needLesson.r, text: String(plan.lesson).slice(0, 300) }); L.items = L.items.slice(-40); await setDoc(env, 'state', 'lessons', L);
  }
  if (!v.ok || plan.action === 'wait') return;
  const barT = m15[m15.length - 1].t + 15 * 60e3;   // orders act from the next M15 bar
  if (plan.action === 'close') { const t = live.find(x => x.status === 'open'); close(t, t.side > 0 ? price : price + spread, barT, 'ai_close'); await saveTrade(env, t); return; }
  if (plan.action === 'cancel_pending') { const t = live.find(x => x.status === 'pending'); t.status = 'cancelled'; t.exit_reason = 'ai_cancel'; t.exit_t = barT; await saveTrade(env, t); return; }
  if (plan.action === 'move_sl') { const t = live.find(x => x.status === 'open'); t.sl = +plan.sl; await saveTrade(env, t); return; }
  const expH = Math.min(Math.max(+plan.expiry_hours || 4, 1), RULES.maxExpiryH);
  const streak = (await env.DB.prepare("SELECT r FROM trades WHERE kind='ai' AND status='closed' ORDER BY exit_t DESC LIMIT ?").bind(RULES.maxLossStreakPause).all()).results;
  if (streak.length >= RULES.maxLossStreakPause && streak.every(x => x.r <= 0)) { await kvSet(env, 'paused', '1'); await event(env, 'WARN', `แพ้ติดกัน ${RULES.maxLossStreakPause} ไม้ -> หยุดเปิดไม้ใหม่ รอคนตรวจ`); return; }
  const tr = { kind: 'ai', status: v.type === 'market' ? 'open' : 'pending', side: v.side, otype: v.type, created_t: barT, expiry_t: barT + expH * 3600e3,
    entry: v.entry, sl: +plan.sl, sl_init: +plan.sl, tp: +plan.tp, decision_id: did };
  if (v.type === 'market') { tr.fill = v.entry; tr.fill_t = barT; }
  await insertTrade(env, tr);
  if (v.type === 'market') {   // twin for market entries is created here (pending ones get theirs when filled)
    const side = crypto.getRandomValues(new Uint8Array(1))[0] & 1 ? 1 : -1, dSL = Math.abs(tr.entry - tr.sl), dTP = Math.abs(tr.tp - tr.entry);
    const fill = side > 0 ? price + spread : price;
    await insertTrade(env, { kind: 'rand', status: 'open', side, otype: 'market', created_t: barT, expiry_t: barT, entry: fill, sl: fill - side * dSL, sl_init: fill - side * dSL,
      tp: fill + side * dTP, fill_t: barT, fill, decision_id: did, twin_of: tr.id });
  }
}

async function eaBars(req, env, ctx) {
  const e = await req.json();
  const m15 = mk(e.m15), h1 = mk(e.h1), spread = Math.max(+e.spread || 0, 0.05);
  if (m15.length < 50 || h1.length < 250) return json({ error: `need m15>=50 h1>=250, got ${m15.length}/${h1.length}` }, 400);
  const st = (await getDoc(env, 'state', 'feed')) || { lastM15: 0, lastH1: 0 };
  await storeBars(env, 'M15', m15, st.lastM15); await storeBars(env, 'H1', h1, st.lastH1);
  await runEngine(env, m15, spread, st.lastM15 || m15[m15.length - 2].t);
  const newH1 = h1[h1.length - 1].t > st.lastH1;
  const nst = { lastM15: m15[m15.length - 1].t, lastH1: h1[h1.length - 1].t, spread, symbol: e.symbol || '', at: nowIso() };
  await setDoc(env, 'state', 'feed', nst);
  if (newH1 && st.lastH1) ctx.waitUntil(decide(env, h1, m15, spread));
  return json({ ok: true, decided: newH1 && !!st.lastH1 });
}

// ---------------- web API ----------------
async function view(env) {
  const H1 = (await env.DB.prepare("SELECT t,o,h,l,c FROM bars WHERE tf='H1' ORDER BY t DESC LIMIT 300").all()).results.reverse();
  const dec = (await env.DB.prepare('SELECT * FROM decisions ORDER BY id DESC LIMIT 60').all()).results.map(d => ({ ...d, plan: JSON.parse(d.plan || '{}') }));
  const trades = (await env.DB.prepare('SELECT * FROM trades ORDER BY id DESC LIMIT 400').all()).results;
  const score = k => { const x = trades.filter(t => t.kind === k && t.status === 'closed' && t.r !== null).map(t => t.r);
    const w = x.filter(r => r > 0), l = x.filter(r => r <= 0);
    return { n: x.length, win: x.length ? r2(w.length / x.length * 100) : null, avg_r: x.length ? r2(x.reduce((a, b) => a + b, 0) / x.length) : null,
      sum_r: r2(x.reduce((a, b) => a + b, 0)), pf: l.length ? r2(w.reduce((a, b) => a + b, 0) / -l.reduce((a, b) => a + b, 0)) : null }; };
  const tok = await env.DB.prepare('SELECT COUNT(*) n, SUM(tokens_in) i, SUM(tokens_out) o FROM decisions').first();
  const events = (await env.DB.prepare('SELECT * FROM events ORDER BY id DESC LIMIT 20').all()).results;
  return { bars: H1, decisions: dec, trades, score: { ai: score('ai'), rand: score('rand') }, lessons: ((await getDoc(env, 'state', 'lessons')) || { items: [] }).items.slice().reverse(),
    feed: await getDoc(env, 'state', 'feed'), paused: (await kvGet(env, 'paused', '0')) === '1', key: !!env.ANTHROPIC_API_KEY, model: MODEL, rules: RULES,
    usage: { decisions: tok.n, tokens_in: tok.i || 0, tokens_out: tok.o || 0 }, events };
}

export default {
  async fetch(req, env, ctx) {
    const u = new URL(req.url), p = u.pathname;
    try {
      if (p === '/ea/bars' && req.method === 'POST') { if (!(await eaAuth(req, env))) return json({ error: 'unauthorized' }, 401); return eaBars(req, env, ctx); }
      if (p === '/api/login' && req.method === 'POST') return login(req, env);
      if (p === '/api/status') return json({ setup: !(await getDoc(env, 'secrets', 'auth')), authed: await session(req, env) });
      if (p.startsWith('/api/')) {
        if (!(await session(req, env))) return json({ error: 'login required' }, 401);
        if (p === '/api/view') return json(await view(env));
        if (p === '/api/pause' && req.method === 'POST') { const { paused } = await req.json(); await kvSet(env, 'paused', paused ? '1' : '0'); await event(env, 'WARN', paused ? 'หยุด AI (กดจากหน้าเว็บ)' : 'เปิด AI ต่อ (กดจากหน้าเว็บ)'); return json({ ok: true }); }
        return json({ error: 'not found' }, 404);
      }
      return env.ASSETS.fetch(req);
    } catch (e) { return json({ error: e.message }, 500); }
  },
};
