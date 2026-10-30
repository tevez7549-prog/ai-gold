// AI-GOLD — Claude plans gold trades every closed H1 bar, PAPER ONLY (no orders anywhere).
// Separate from Mark1 / forex-agent (owner 2026-10-29: "เราไม่ยุ่งกับ mark 1"): own repo, Worker, D1, and a bars-only EA in the Exness terminal.
//  - POST /ea/bars  (Bearer token, hash in docs('secrets','ea')): the EA posts closed M15 + H1 bars every new M15 bar
//  - every new M15 bar: paper engine fills/stops pending + open trades on the new M15 bars (conservative: stop first, no TP in the fill bar)
//  - every new H1 bar: build context (H1/H4/D1 bars, EMA/ATR/RSI/ADX, swings, open trade, recent results, lessons) -> Claude -> plan JSON
//    -> HARD RULES (code, not the AI) validate it -> paper order. Benchmark twin: random side, same SL/TP distances, opened when the AI fills.
//  - /api/* (password, PBKDF2) for the web page in /public
// Pre-registered evaluation (2026-10-29): >= 50 closed AI trades; AI avg R >= +0.10 AND >= twin avg R + 0.15; no rule violations executed.
// Rules v2 (owner 2026-10-30 08:00, "loose rules, goal-based"): several trades at once, the AI picks risk 0.25-2% of a virtual $10,000
// account per trade (lower when unsure), every trade needs SL + TP and both may be moved any time (manage profits, don't let winners
// turn into losers), DD >= 15% from peak halves the risk of new trades, DD >= 30% stops new trades (latched until a person resumes),
// total open risk <= 6%. After every closed trade the AI writes a detailed review (why won/lost, could it have made more / lost less).
import { ema, atr, rsi, adx, swings, agg } from './ind.js';

const MODEL = 'claude-sonnet-5-5';
const RULES = {
  startEquity: 10000,
  riskMin: 0.25, riskMax: 2.0,   // % of equity per trade, chosen by the AI
  openRiskCap: 6.0,              // % of equity at risk across all open + pending trades (to their CURRENT stops)
  ddHalf: 15, ddStop: 30,        // % drawdown from peak: halve new risk / stop new trades
  maxLive: 6,                    // open + pending AI trades at once (sanity)
  maxNewPerBar: 3,
  maxExpiryH: 48,                // pending orders live at most 48 h
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
// events feed the web log and the Agent Office (agent = who walks to the boss, kind = what happened)
const event = (env, level, msg, agent = 'sys', kind = null) => env.DB.prepare('INSERT INTO events(time,level,msg,agent,kind) VALUES(?,?,?,?,?)')
  .bind(nowIso(), level, String(msg).slice(0, 1000), agent, kind || (level === 'ERROR' ? 'err' : level === 'WARN' ? 'warn' : 'info')).run();
const px = x => (+x).toFixed(2);
const SIDE = s => s > 0 ? 'BUY' : 'SELL';
const WHY = { tp: 'TP', sl: 'SL', trail: 'SL ที่เลื่อนแล้ว', ai_close: 'AI สั่งปิด', expired: 'หมดเวลา', ai_cancel: 'AI ยกเลิก' };
async function tradeEvent(env, tr, what) {
  const who = tr.kind === 'rand' ? 'rand' : 'ai';
  if (what === 'fill') return event(env, 'INFO', `เปิด ${SIDE(tr.side)} @ ${px(tr.fill)} · SL ${px(tr.sl)} · TP ${px(tr.tp)}` + (tr.kind === 'rand' ? ` (สุ่มฝั่ง คู่กับไม้ AI #${tr.twin_of})` : ''), who, 'open');
  if (what === 'close') return event(env, 'INFO', `ปิด ${SIDE(tr.side)} ที่ ${WHY[tr.exit_reason] || tr.exit_reason} ${px(tr.exit)} · ${tr.r >= 0 ? '+' : ''}${tr.r}R`, who, 'close');
  if (what === 'cancel') return event(env, 'INFO', `ยกเลิกออเดอร์ ${SIDE(tr.side)} ${tr.otype.toUpperCase()} @ ${px(tr.entry)} (${WHY[tr.exit_reason] || tr.exit_reason})`, who, 'cancel');
}

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
  // max favourable / adverse excursion in price ($/oz), for the AI's post-trade review
  const fav = s > 0 ? b.h - tr.fill : tr.fill - (b.l + spread), adv = s > 0 ? tr.fill - b.l : (b.h + spread) - tr.fill;
  if (b.t >= tr.fill_t) { if (fav > (tr.mfe || 0)) { tr.mfe = fav; ch = true; } if (adv > (tr.mae || 0)) { tr.mae = adv; ch = true; } }
  if ((s > 0 && b.l <= tr.sl) || (s < 0 && b.h + spread >= tr.sl)) return close(tr, tr.sl, b.t, tr.sl * s > tr.sl_init * s ? 'trail' : 'sl');
  if (b.t > tr.fill_t && ((s > 0 && b.h >= tr.tp) || (s < 0 && b.l + spread <= tr.tp))) return close(tr, tr.tp, b.t, 'tp');
  return ch;
}
function close(tr, px, t, why) {
  tr.status = 'closed'; tr.exit = px; tr.exit_t = t; tr.exit_reason = why;
  tr.r = Math.round(tr.side * (px - tr.fill) / Math.abs(tr.fill - tr.sl_init) * 1000) / 1000; return true;
}
async function saveTrade(env, tr) {
  await env.DB.prepare('UPDATE trades SET status=?, sl=?, tp=?, fill_t=?, fill=?, exit_t=?, exit=?, r=?, exit_reason=?, lesson=?, mfe=?, mae=? WHERE id=?')
    .bind(tr.status, tr.sl, tr.tp, tr.fill_t ?? null, tr.fill ?? null, tr.exit_t ?? null, tr.exit ?? null, tr.r ?? null, tr.exit_reason ?? null, tr.lesson ?? null,
      tr.mfe ?? null, tr.mae ?? null, tr.id).run();
}
async function insertTrade(env, tr) {
  const r = await env.DB.prepare(`INSERT INTO trades(kind,status,side,otype,created,created_t,expiry_t,entry,sl,sl_init,tp,fill_t,fill,decision_id,twin_of,risk_pct,tp_init)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(tr.kind, tr.status, tr.side, tr.otype, nowIso(), tr.created_t, tr.expiry_t, tr.entry, tr.sl, tr.sl_init, tr.tp,
    tr.fill_t ?? null, tr.fill ?? null, tr.decision_id ?? null, tr.twin_of ?? null, tr.risk_pct ?? 1, tr.tp).run();
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
        if (wasPending && tr.fill_t) await tradeEvent(env, tr, 'fill');
        if (tr.status === 'cancelled') await tradeEvent(env, tr, 'cancel');
        if (tr.status === 'closed') await tradeEvent(env, tr, 'close');
        if (tr.kind === 'ai' && wasPending && tr.fill_t) {   // benchmark twin: random side, same distances, opened at the AI fill
          const side = crypto.getRandomValues(new Uint8Array(1))[0] & 1 ? 1 : -1, dSL = Math.abs(tr.entry - tr.sl_init), dTP = Math.abs(tr.tp - tr.entry);
          const bid = tr.side > 0 ? tr.fill - spread : tr.fill, fill = side > 0 ? bid + spread : bid;
          const tw = await insertTrade(env, { kind: 'rand', status: 'open', side, otype: 'market', created_t: tr.fill_t, expiry_t: tr.fill_t, entry: fill,
            sl: fill - side * dSL, sl_init: fill - side * dSL, tp: fill + side * dTP, fill_t: tr.fill_t, fill, decision_id: tr.decision_id, twin_of: tr.id, risk_pct: tr.risk_pct });
          await tradeEvent(env, tw, 'fill');
          live.push(tw);
        }
        if (tr.status === 'closed') closed.push(tr);
      }
    }
  }
  return closed;
}

// ---------------- account (virtual $10,000, compounding by each trade's risk %) ----------------
// equity = start x PRODUCT(1 + risk_pct/100 x R) over closed AI trades; floating = open trades marked at the last price.
function account(closedAsc, openTrades, bid, spread) {
  let eq = RULES.startEquity, peak = eq;
  for (const t of closedAsc) { eq *= 1 + (t.risk_pct ?? 1) / 100 * t.r; peak = Math.max(peak, eq); }
  let floatPct = 0, openRisk = 0;
  for (const t of openTrades) {
    const risk0 = Math.abs((t.fill ?? t.entry) - t.sl_init) || 1, rp = t.risk_pct ?? 1;
    const curRisk = t.side * ((t.fill ?? t.entry) - t.sl) / risk0;          // 1 = initial risk, <=0 = stop at/past entry
    openRisk += rp * Math.max(0, curRisk);
    if (t.status === 'open' && bid) floatPct += rp * (t.side > 0 ? bid - t.fill : t.fill - (bid + spread)) / risk0;
  }
  const eqNow = eq * (1 + floatPct / 100), pk = Math.max(peak, eqNow);
  const dd = (pk - eqNow) / pk * 100;
  return { equity: r2(eqNow), closed_equity: r2(eq), peak: r2(pk), dd_pct: r2(dd), open_risk_pct: r2(openRisk),
    mode: dd >= RULES.ddStop ? 'stopped' : dd >= RULES.ddHalf ? 'half' : 'normal' };
}

// ---------------- context for the AI ----------------
function context(h1, m15, spread, live, recent, lessons, toReview, acct) {
  const c = h1.map(b => b.c), A = atr(h1), R = rsi(c), X = adx(h1), E20 = ema(c, 20), E50 = ema(c, 50), E200 = ema(c, 200);
  const i = h1.length - 1, H4 = agg(h1, 4), D1 = agg(h1, 24), e50h4 = ema(H4.map(b => b.c), 50);
  const sw = swings(h1, 3, 8), swH4 = swings(H4, 2, 6);
  const fmt = b => `${iso(b.t)},${b.o.toFixed(2)},${b.h.toFixed(2)},${b.l.toFixed(2)},${b.c.toFixed(2)}`;
  const last = m15[m15.length - 1];
  const rr = (t, v) => v == null ? null : r2(v / (Math.abs(t.fill - t.sl_init) || 1));
  return {
    now_bar: iso(h1[i].t), price: last.c, spread: r2(spread),
    account: { ...acct, risk_rule: `risk per new trade ${RULES.riskMin}-${RULES.riskMax}% of equity` + (acct.mode === 'half' ? ' (HALVED by code: DD >= 15%)' : '') +
      (acct.mode === 'stopped' ? ' — NEW TRADES BLOCKED (DD >= 30%)' : ''), open_risk_cap_pct: RULES.openRiskCap },
    indicators_h1: { ema20: r2(E20[i]), ema50: r2(E50[i]), ema200: r2(E200[i]), atr14: r2(A[i]), rsi14: r2(R[i]), adx14: r2(X[i] ?? 0),
      ema50_h4: r2(e50h4[e50h4.length - 1]) },
    swings_h1: { highs: sw.hi.map(x => [iso(x.t), r2(x.p)]), lows: sw.lo.map(x => [iso(x.t), r2(x.p)]) },
    swings_h4: { highs: swH4.hi.map(x => [iso(x.t), r2(x.p)]), lows: swH4.lo.map(x => [iso(x.t), r2(x.p)]) },
    d1_last20: D1.slice(-20).map(fmt), h4_last40: H4.slice(-40).map(fmt), h1_last72: h1.slice(-72).map(fmt), m15_last16: m15.slice(-16).map(fmt),
    my_trades: live.map(t => ({ id: t.id, status: t.status, side: t.side > 0 ? 'buy' : 'sell', type: t.otype, entry: t.fill ?? t.entry, sl: t.sl, sl_init: t.sl_init,
      tp: t.tp, tp_init: t.tp_init, risk_pct: t.risk_pct, opened: t.fill_t ? iso(t.fill_t) : null, expires: t.status === 'pending' ? iso(t.expiry_t) : null,
      float_r: t.status === 'open' ? r2((t.side > 0 ? last.c - t.fill : t.fill - (last.c + spread)) / (Math.abs(t.fill - t.sl_init) || 1)) : null,
      best_r_so_far: t.status === 'open' ? rr(t, t.mfe) : null, worst_r_so_far: t.status === 'open' ? rr(t, t.mae) : null })),
    recent_results: recent.map(t => ({ id: t.id, side: t.side > 0 ? 'buy' : 'sell', opened: iso(t.fill_t), r: t.r, exit: t.exit_reason, best_r: rr(t, t.mfe), risk_pct: t.risk_pct })),
    lessons,
    review_these_closed_trades: toReview.map(t => ({ id: t.id, side: t.side > 0 ? 'buy' : 'sell', entry: t.fill, sl_init: t.sl_init, sl_final: t.sl, tp_init: t.tp_init,
      tp_final: t.tp, exit: t.exit, exit_reason: t.exit_reason, r: t.r, risk_pct: t.risk_pct, best_r_during_trade: rr(t, t.mfe), worst_r_during_trade: rr(t, t.mae),
      opened: iso(t.fill_t), closed: iso(t.exit_t), hours: r2((t.exit_t - t.fill_t) / 3600e3) })),
  };
}
const SYSTEM = `You are AI-GOLD (the owner calls this system "Mark2"), a discretionary trader of XAUUSD (gold), deciding once per closed H1 bar.
This is a PAPER forward test (no real money) on a virtual $${RULES.startEquity} account that the owner watches on a web page; write all text in Thai.
GOAL: grow the account as much as possible while keeping drawdown from the peak below 20-25%. You are judged on profit vs drawdown and against a
random-direction twin that copies your sizes and initial stops/targets — so only trade when you see a real edge, and manage trades well.
You have wide freedom. The ONLY rules (enforced by code; an item that breaks them is rejected, the rest of the plan still runs):
- every trade must have a stop loss AND a take profit; you may move both at any time in either direction (but not past the current price)
- choose risk per trade ${RULES.riskMin}-${RULES.riskMax}% of equity (use less when unsure); code halves it when DD >= ${RULES.ddHalf}% and blocks new trades at DD >= ${RULES.ddStop}%
- total risk of all your open + pending trades (to their current stops) <= ${RULES.openRiskCap}% of equity; at most ${RULES.maxLive} trades at once, ${RULES.maxNewPerBar} new per bar
- order types: market, stop (buy above / sell below price), limit (buy below / sell above price); pending orders expire within ${RULES.maxExpiryH} h
Manage profits actively: move the stop to protect open profit and adjust targets so winners do not turn into losers or close for a tiny gain;
best_r_so_far / worst_r_so_far show how far each open trade has run. Several trades, both directions, scaling in or out are allowed if you think they help.
Use the lessons list (notes you wrote after earlier trades). For EVERY trade in review_these_closed_trades write a detailed review: why it won or lost,
whether it could have made more (compare best_r_during_trade with r) or lost less, what you would do differently, and a one-line lesson.
Empty orders/modify/close/cancel = wait. Always reply by calling the submit_plan tool exactly once; never answer in plain text.`;
const TOOL = {
  name: 'submit_plan', description: 'Submit the plan for this H1 bar.',
  input_schema: { type: 'object', required: ['bias', 'market_view', 'levels', 'reasoning', 'orders', 'modify', 'close', 'cancel'], properties: {
    bias: { type: 'string', enum: ['up', 'down', 'neutral'] },
    market_view: { type: 'string', description: 'Thai, 1-2 sentences: what the market is doing' },
    levels: { type: 'array', maxItems: 8, items: { type: 'object', required: ['price', 'kind'], properties: {
      price: { type: 'number' }, kind: { type: 'string', enum: ['support', 'resistance', 'pivot'] }, note: { type: 'string' } } } },
    orders: { type: 'array', maxItems: RULES.maxNewPerBar, description: 'new trades (empty = none)', items: { type: 'object', required: ['side', 'type', 'sl', 'tp', 'risk_pct', 'why'], properties: {
      side: { type: 'string', enum: ['buy', 'sell'] }, type: { type: 'string', enum: ['market', 'stop', 'limit'] }, entry: { type: 'number', description: 'required for stop/limit' },
      sl: { type: 'number' }, tp: { type: 'number' }, risk_pct: { type: 'number', description: `${RULES.riskMin}-${RULES.riskMax}` },
      expiry_hours: { type: 'number' }, why: { type: 'string', description: 'Thai' } } } },
    modify: { type: 'array', description: 'move SL and/or TP of your open or pending trades', items: { type: 'object', required: ['id', 'why'], properties: {
      id: { type: 'integer' }, sl: { type: 'number' }, tp: { type: 'number' }, why: { type: 'string', description: 'Thai' } } } },
    close: { type: 'array', description: 'close open trades at market', items: { type: 'object', required: ['id', 'why'], properties: { id: { type: 'integer' }, why: { type: 'string' } } } },
    cancel: { type: 'array', description: 'cancel pending orders', items: { type: 'object', required: ['id', 'why'], properties: { id: { type: 'integer' }, why: { type: 'string' } } } },
    confidence: { type: 'integer', minimum: 0, maximum: 100 },
    reasoning: { type: 'string', description: 'Thai, 2-5 sentences' },
    reviews: { type: 'array', description: 'one per trade in review_these_closed_trades', items: { type: 'object', required: ['id', 'review', 'lesson'], properties: {
      id: { type: 'integer' }, review: { type: 'string', description: 'Thai, detailed: why won/lost, could it have made more or lost less, what to do differently' },
      lesson: { type: 'string', description: 'Thai, one line' } } } } } },
};
// This model does not accept a forced tool_choice, so tool_choice is 'auto' and the prompt requires the tool call;
// if the reply has no tool call, ask once more in the same conversation.
async function askClaude(env, ctxObj) {
  const messages = [{ role: 'user', content: 'Market context (JSON):\n' + JSON.stringify(ctxObj) + '\n\nAnswer ONLY by calling submit_plan exactly once.' }];
  const usage = { input_tokens: 0, output_tokens: 0 };
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await fetch((env.ANTHROPIC_BASE || 'https://api.anthropic.com') + '/v1/messages', {   // ANTHROPIC_BASE only for local tests
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: MODEL, max_tokens: 6000, system: SYSTEM, tools: [TOOL], tool_choice: { type: 'auto' }, messages }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(`Claude API ${r.status}: ${JSON.stringify(d).slice(0, 300)}`);
    usage.input_tokens += d.usage?.input_tokens || 0; usage.output_tokens += d.usage?.output_tokens || 0;
    const tu = (d.content || []).find(x => x.type === 'tool_use');
    if (tu) return { plan: tu.input, usage };
    messages.push({ role: 'assistant', content: d.content && d.content.length ? d.content : [{ type: 'text', text: '(no answer)' }] });
    messages.push({ role: 'user', content: 'Call submit_plan now with your plan (empty arrays = wait).' });
  }
  throw new Error('no plan in reply');
}

// ---------------- hard rules v2 ----------------
const arr = x => Array.isArray(x) ? x : [];
function checkNew(o, price, spread) {
  const side = o.side === 'buy' ? 1 : o.side === 'sell' ? -1 : 0, type = ['market', 'stop', 'limit'].includes(o.type) ? o.type : null;
  if (!side || !type) return { ok: false, why: 'side/type ไม่ถูกต้อง' };
  const entry = type === 'market' ? (side > 0 ? price + spread : price) : +o.entry;
  if (!(entry > 0) || !(+o.sl > 0) || !(+o.tp > 0)) return { ok: false, why: 'ไม่มี entry/SL/TP' };
  if (side * (entry - o.sl) <= 0 || side * (o.tp - entry) <= 0) return { ok: false, why: 'SL/TP อยู่ผิดฝั่ง' };
  if (side * (entry - o.sl) < spread) return { ok: false, why: 'SL ใกล้กว่าสเปรด' };
  if (type === 'stop' && (side > 0 ? entry <= price + spread : entry >= price)) return { ok: false, why: 'stop order อยู่ผิดฝั่งของราคา' };
  if (type === 'limit' && (side > 0 ? entry >= price + spread : entry <= price)) return { ok: false, why: 'limit order อยู่ผิดฝั่งของราคา' };
  const rp = +o.risk_pct;
  if (!(rp >= RULES.riskMin && rp <= RULES.riskMax)) return { ok: false, why: `risk ${o.risk_pct}% นอกช่วง ${RULES.riskMin}-${RULES.riskMax}%` };
  return { ok: true, side, type, entry, rp };
}
function checkModify(m, t, price, spread) {
  if (!t) return { ok: false, why: `ไม่พบไม้ #${m.id}` };
  const sl = m.sl != null ? +m.sl : t.sl, tp = m.tp != null ? +m.tp : t.tp, s = t.side;
  if (!(sl > 0) || !(tp > 0)) return { ok: false, why: 'SL/TP ต้องมีเสมอ' };
  if (t.status === 'open') {
    if (s > 0 ? sl >= price : sl <= price + spread) return { ok: false, why: 'SL ใหม่เลยราคาปัจจุบัน' };
    if (s > 0 ? tp <= price : tp >= price + spread) return { ok: false, why: 'TP ใหม่เลยราคาปัจจุบัน (ใช้ close แทน)' };
  } else if (s * (t.entry - sl) <= 0 || s * (tp - t.entry) <= 0) return { ok: false, why: 'SL/TP ผิดฝั่งของราคาเข้า' };
  return { ok: true, sl, tp };
}

async function decide(env, h1, m15, spread) {
  if (!env.ANTHROPIC_API_KEY) { await event(env, 'WARN', 'ยังไม่ได้ใส่ ANTHROPIC_API_KEY', 'ai', 'err'); return; }
  if ((await kvGet(env, 'paused', '0')) === '1') return;
  const live = (await env.DB.prepare("SELECT * FROM trades WHERE kind='ai' AND status IN ('pending','open') ORDER BY id").all()).results;
  const closedAsc = (await env.DB.prepare("SELECT * FROM trades WHERE kind='ai' AND status='closed' AND r IS NOT NULL ORDER BY exit_t, id").all()).results;
  const recent = closedAsc.slice(-8).reverse();
  const L = (await getDoc(env, 'state', 'lessons')) || { items: [] };
  const toReview = closedAsc.filter(t => t.lesson == null).slice(-3);
  const A = atr(h1), atrH1 = A[A.length - 1], price = m15[m15.length - 1].c;
  let acct = account(closedAsc, live, price, spread);
  if (acct.mode === 'stopped' && (await kvGet(env, 'dd_stop', '0')) !== '1') {
    await kvSet(env, 'dd_stop', '1'); await event(env, 'WARN', `DD ${acct.dd_pct}% ถึงเกณฑ์ ${RULES.ddStop}% -> หยุดเปิดไม้ใหม่ รอคนตรวจ`, 'boss', 'stop');
  }
  const ddStopped = (await kvGet(env, 'dd_stop', '0')) === '1';
  const cx = context(h1, m15, spread, live, recent, L.items.slice(-15), toReview, { ...acct, mode: ddStopped ? 'stopped' : acct.mode });
  let plan, usage;
  const barH1 = h1[h1.length - 1].t;
  try { ({ plan, usage } = await askClaude(env, cx)); } catch (e) {
    // remember the failure; eaBars retries this H1 bar on the next M15 posts (at most 3 tries per bar)
    const rt = (await getDoc(env, 'state', 'retry')) || {};
    await setDoc(env, 'state', 'retry', { bar: barH1, tries: rt.bar === barH1 ? (rt.tries || 0) + 1 : 1 });
    await event(env, 'ERROR', e.message, 'ai', 'err'); return;
  }
  const barT = m15[m15.length - 1].t + 15 * 60e3;   // orders act from the next M15 bar
  const rejects = [], done = [];
  const byId = id => live.find(t => t.id === +id && (t.status === 'open' || t.status === 'pending'));
  // reviews of closed trades -> trades.lesson (one line) + trades.review (detailed) + lessons memory
  for (const rv of arr(plan.reviews)) {
    const t = toReview.find(x => x.id === +rv.id); if (!t) continue;
    await env.DB.prepare('UPDATE trades SET lesson=?, review=? WHERE id=?').bind(String(rv.lesson || '').slice(0, 300), String(rv.review || '').slice(0, 2000), t.id).run();
    L.items.push({ t: nowIso(), id: t.id, r: t.r, text: String(rv.lesson || '').slice(0, 300) }); L.items = L.items.slice(-40);
    await event(env, 'INFO', `ทบทวนไม้ #${t.id} (${t.r >= 0 ? '+' : ''}${t.r}R): ${String(rv.review || '').slice(0, 220)}`, 'ai', 'rep');
  }
  if (arr(plan.reviews).length) await setDoc(env, 'state', 'lessons', L);
  // closes
  for (const c of arr(plan.close)) {
    const t = byId(c.id); if (!t || t.status !== 'open') { rejects.push(`ปิด #${c.id}: ไม่พบไม้เปิด`); continue; }
    close(t, t.side > 0 ? price : price + spread, barT, 'ai_close'); await saveTrade(env, t); await tradeEvent(env, t, 'close'); done.push(`ปิด #${t.id}`);
  }
  for (const c of arr(plan.cancel)) {
    const t = byId(c.id); if (!t || t.status !== 'pending') { rejects.push(`ยกเลิก #${c.id}: ไม่พบออเดอร์รอ`); continue; }
    t.status = 'cancelled'; t.exit_reason = 'ai_cancel'; t.exit_t = barT; await saveTrade(env, t); await tradeEvent(env, t, 'cancel'); done.push(`ยกเลิก #${t.id}`);
  }
  for (const m of arr(plan.modify)) {
    const t = byId(m.id), v = checkModify(m, t, price, spread);
    if (!v.ok) { rejects.push(`แก้ #${m.id}: ${v.why}`); continue; }
    const os = t.sl, ot = t.tp; t.sl = v.sl; t.tp = v.tp; await saveTrade(env, t);
    const parts = []; if (os !== t.sl) parts.push(`SL ${px(os)}→${px(t.sl)}`); if (ot !== t.tp) parts.push(`TP ${px(ot)}→${px(t.tp)}`);
    if (parts.length) { await event(env, 'INFO', `ปรับ ${SIDE(t.side)} #${t.id}: ${parts.join(' · ')}${m.why ? ' — ' + String(m.why).slice(0, 100) : ''}`, 'ai', 'sl'); done.push(`แก้ #${t.id}`); }
  }
  // new orders (after closes/modifies, so freed risk can be reused)
  const liveNow = live.filter(t => t.status === 'open' || t.status === 'pending');
  for (const o of arr(plan.orders).slice(0, RULES.maxNewPerBar)) {
    if (ddStopped) { rejects.push(`เปิดใหม่: DD ถึง ${RULES.ddStop}% หยุดเปิดไม้`); continue; }
    const v = checkNew(o, price, spread); if (!v.ok) { rejects.push(`เปิด ${o.side} ${o.type}: ${v.why}`); continue; }
    if (liveNow.length >= RULES.maxLive) { rejects.push(`เปิดใหม่: ครบ ${RULES.maxLive} ไม้แล้ว`); continue; }
    const rp = r2(acct.mode === 'half' ? v.rp / 2 : v.rp);
    const used = account([], liveNow, price, spread).open_risk_pct;
    if (used + rp > RULES.openRiskCap + 1e-9) { rejects.push(`เปิดใหม่: ความเสี่ยงรวม ${r2(used)}%+${rp}% เกิน ${RULES.openRiskCap}%`); continue; }
    const expH = Math.min(Math.max(+o.expiry_hours || 8, 1), RULES.maxExpiryH);
    const tr = { kind: 'ai', status: v.type === 'market' ? 'open' : 'pending', side: v.side, otype: v.type, created_t: barT, expiry_t: barT + expH * 3600e3,
      entry: v.entry, sl: +o.sl, sl_init: +o.sl, tp: +o.tp, risk_pct: rp, decision_id: null };
    if (v.type === 'market') { tr.fill = v.entry; tr.fill_t = barT; }
    await insertTrade(env, tr); liveNow.push(tr); tr._why = o.why;
    if (v.type === 'market') {
      await tradeEvent(env, tr, 'fill');
      const side = crypto.getRandomValues(new Uint8Array(1))[0] & 1 ? 1 : -1, dSL = Math.abs(tr.entry - tr.sl), dTP = Math.abs(tr.tp - tr.entry), fill = side > 0 ? price + spread : price;
      const tw = await insertTrade(env, { kind: 'rand', status: 'open', side, otype: 'market', created_t: barT, expiry_t: barT, entry: fill, sl: fill - side * dSL, sl_init: fill - side * dSL,
        tp: fill + side * dTP, fill_t: barT, fill, decision_id: null, twin_of: tr.id, risk_pct: rp });
      await tradeEvent(env, tw, 'fill');
    } else await event(env, 'INFO', `ตั้ง ${SIDE(tr.side)} ${tr.otype.toUpperCase()} @ ${px(tr.entry)} · SL ${px(tr.sl)} · TP ${px(tr.tp)} · เสี่ยง ${rp}% · หมดอายุ ${expH} ชม.`, 'ai', 'order');
    done.push(`${o.side} ${o.type} ${rp}%`);
  }
  const d = await env.DB.prepare('INSERT INTO decisions(time,bar_t,model,tokens_in,tokens_out,plan,valid,note) VALUES(?,?,?,?,?,?,?,?)')
    .bind(nowIso(), barH1, MODEL, usage.input_tokens || 0, usage.output_tokens || 0, JSON.stringify({ ...plan, price, atr: r2(atrH1), account: acct, done }),
      rejects.length ? 0 : 1, rejects.length ? rejects.join(' | ').slice(0, 1000) : null).run();
  const did = d.meta.last_row_id;
  await env.DB.prepare("UPDATE trades SET decision_id=? WHERE decision_id IS NULL AND created_t=? AND status IN ('open','pending')").bind(did, barT).run();
  for (const rj of rejects) await event(env, 'INFO', 'ปัดตก: ' + rj, 'ai', 'reject');
  if (!done.length && !rejects.length) await event(env, 'INFO', `รอ · ${plan.market_view || ''}`.slice(0, 160), 'ai', 'plan');
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
  let go = newH1 && !!st.lastH1;
  if (!go && st.lastH1) {   // retry a bar whose decision failed (API error), max 3 tries
    const rt = await getDoc(env, 'state', 'retry');
    go = !!rt && rt.bar === h1[h1.length - 1].t && (rt.tries || 0) < 3
      && !(await env.DB.prepare('SELECT 1 FROM decisions WHERE bar_t=? LIMIT 1').bind(rt.bar).first());   // not if the retry already succeeded
  }
  if (go) ctx.waitUntil(decide(env, h1, m15, spread));
  return json({ ok: true, decided: go });
}


// ---------------- heartbeat + research department + Agent Office ----------------
// EA v1.02 pings every 60 s: VPS dot = last ping received, MT5 dot = last ping where the terminal was connected to the broker.
async function eaPing(req, env) {
  const e = await req.json().catch(() => ({})), now = Date.now();
  const prev = (await getDoc(env, 'state', 'ping')) || {};
  const connected = !!e.connected;
  const err = String(e.err || '').slice(0, 200);
  const d = { at: now, connected, conn_at: connected ? now : (prev.conn_at || 0), bid: +e.bid || null, ask: +e.ask || null, ping_ms: +e.ping_ms || null,
    ver: String(e.ver || ''), err, err_at: err ? (err === prev.err ? prev.err_at : now) : 0 };
  await setDoc(env, 'state', 'ping', d);
  if (err && err !== prev.err) await event(env, 'ERROR', 'ส่งแท่งไม่สำเร็จ: ' + err, 'feed', 'err');
  if (!err && prev.err) await event(env, 'INFO', 'ส่งแท่งได้ตามปกติอีกครั้ง', 'feed', 'info');
  if (prev.at && now - prev.at > 10 * 60e3) await event(env, 'INFO', `EA กลับมาออนไลน์ (เงียบไป ${Math.round((now - prev.at) / 60e3)} นาที)`, 'feed', 'info');
  return json({ ok: true });
}
const DEPT = ['scout', 'tester', 'auditor', 'librarian', 'report'];
const DEPT_KINDS = ['start', 'rep', 'idea', 'pass', 'fail', 'err', 'info'];
async function deptReport(req, env) {
  const h = req.headers.get('authorization') || ''; const tok = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  const sec = await getDoc(env, 'secrets', 'dept'); if (!(tok && sec && safeEqual(await sha256(tok), sec.hash))) return json({ error: 'unauthorized' }, 401);
  const e = await req.json().catch(() => ({})), now = Date.now();
  const st = (await getDoc(env, 'state', 'dept')) || { roles: {} };
  for (const [k, v] of Object.entries(e.roles || {})) {
    if (!DEPT.includes(k) || !v) continue;
    st.roles[k] = { state: ['working', 'idle', 'error'].includes(v.state) ? v.state : 'idle', msg: String(v.msg || '').slice(0, 200),
      stats: (Array.isArray(v.stats) ? v.stats : []).slice(0, 3).map(x => [String(x[0]).slice(0, 20), String(x[1]).slice(0, 20)]), at: now };
  }
  if (e.summary) st.summary = { tested: +e.summary.tested || 0, passed: +e.summary.passed || 0, backlog: +e.summary.backlog || 0, night: String(e.summary.night || '').slice(0, 20) };
  if (e.run === 'start') st.run_start = now;
  if (e.run === 'end') st.run_end = now;
  st.at = now; await setDoc(env, 'state', 'dept', st);
  for (const x of (e.events || []).slice(0, 20)) {
    if (!DEPT.includes(x.agent)) continue;
    const kind = DEPT_KINDS.includes(x.kind) ? x.kind : 'info';
    await event(env, kind === 'err' ? 'ERROR' : 'INFO', String(x.msg || '').slice(0, 300), x.agent, kind);
  }
  return json({ ok: true });
}
// Exness gold (server = UTC): closed Fri 21:00 -> Sun 22:00, daily break ~21:00-22:05
function marketOpen(ms) {
  const d = new Date(ms), wd = d.getUTCDay(), m = d.getUTCHours() * 60 + d.getUTCMinutes();
  if (wd === 6 || (wd === 0 && m < 22 * 60 + 5) || (wd === 5 && m >= 21 * 60)) return false;
  return !(m >= 21 * 60 && m < 22 * 60 + 5);
}
const tsOf = s => s ? Date.parse(s.replace(' ', 'T') + 'Z') : 0;
async function office(env) {
  const now = Date.now();
  const trades = (await env.DB.prepare('SELECT * FROM trades ORDER BY id').all()).results;
  const ev = (await env.DB.prepare('SELECT id,time,level,msg,agent,kind FROM events ORDER BY id DESC LIMIT 40').all()).results;
  const feed = await getDoc(env, 'state', 'feed'), ping = await getDoc(env, 'state', 'ping'), dept = (await getDoc(env, 'state', 'dept')) || { roles: {} };
  const paused = (await kvGet(env, 'paused', '0')) === '1' || (await kvGet(env, 'dd_stop', '0')) === '1';
  const lastDec = await env.DB.prepare('SELECT id,time,plan,valid FROM decisions ORDER BY id DESC LIMIT 1').first();
  const nM15 = (await env.DB.prepare("SELECT COUNT(*) n FROM bars WHERE tf='M15'").first()).n;
  const pingFresh = ping && now - ping.at < 5 * 60e3;
  const bid = pingFresh && ping.bid ? ping.bid : (await env.DB.prepare("SELECT c FROM bars WHERE tf='M15' ORDER BY t DESC LIMIT 1").first() || {}).c;
  const spread = pingFresh && ping.ask && ping.bid ? ping.ask - ping.bid : (feed ? feed.spread : 0.2);
  const priceAt = pingFresh ? ping.at : (feed ? tsOf(feed.at) : 0);
  const bkkDay = ms => Math.floor((ms + 7 * 3600e3) / 86400e3);
  const today = bkkDay(now);
  const lastEv = a => { const x = ev.find(e => e.agent === a); return x ? tsOf(x.time) : null; };
  const floatR = t => { if (t.status !== 'open' || !bid) return null; const risk = Math.abs(t.fill - t.sl_init) || 1;
    return t.side > 0 ? (bid - t.fill) / risk : (t.fill - (bid + spread)) / risk; };
  function book(kind) {
    const cl = trades.filter(t => t.kind === kind && t.status === 'closed' && t.r !== null).sort((a, b) => a.exit_t - b.exit_t);
    let eq = 10000, peak = 10000, cum = 0, cumPeak = 0, ddR = 0, eqDay = null, streak = 0;
    for (const t of cl) {
      if (eqDay === null && bkkDay(t.exit_t) >= today) eqDay = eq;
      eq *= 1 + (t.risk_pct ?? 1) / 100 * t.r; peak = Math.max(peak, eq); cum += t.r; cumPeak = Math.max(cumPeak, cum); ddR = Math.min(ddR, cum - cumPeak);
    }
    for (let i = cl.length - 1; i >= 0 && cl[i].r <= 0; i--) streak++;
    const opens = trades.filter(t => t.kind === kind && t.status === 'open'), pends = trades.filter(t => t.kind === kind && t.status === 'pending');
    const open = opens[opens.length - 1], pend = pends[pends.length - 1];
    const fR = open ? floatR(open) : null;
    const floatPct = opens.reduce((a, t) => a + (t.risk_pct ?? 1) * (floatR(t) || 0), 0);
    const eqNow = eq * (1 + floatPct / 100);
    if (eqDay === null) eqDay = eq;
    return { n: cl.length, sum_r: r2(cum), dd_r: r2(Math.min(ddR, cum + (fR || 0) - cumPeak)), streak, eq_closed: r2(eq), eq: r2(eqNow), peak: r2(Math.max(peak, eqNow)),
      dd_pct: r2((Math.max(peak, eqNow) - eqNow) / Math.max(peak, eqNow) * 100), today_usd: r2(eqNow - eqDay), today_pct: r2((eqNow - eqDay) / eqDay * 100),
      today_r: r2(cl.filter(t => bkkDay(t.exit_t) === today).reduce((a, t) => a + t.r, 0)),
      win: cl.length ? Math.round(cl.filter(t => t.r > 0).length / cl.length * 100) : null,
      n_open: opens.length, n_pend: pends.length,
      open: open ? { id: open.id, side: SIDE(open.side), entry: open.fill, sl: open.sl, sl_init: open.sl_init, tp: open.tp, risk_pct: open.risk_pct, float_r: fR === null ? null : r2(fR),
        float_usd: fR === null ? null : r2(fR * (open.risk_pct ?? 1) / 100 * eq), float_oz: bid ? r2(open.side > 0 ? bid - open.fill : open.fill - (bid + spread)) : null, since: open.fill_t,
        more: opens.length - 1 } : null,
      pending: pend ? { side: SIDE(pend.side), type: pend.otype, entry: pend.entry, sl: pend.sl, tp: pend.tp, expires: pend.expiry_t } : null };
  }
  const ai = book('ai'), rnd = book('rand');
  const mOpen = marketOpen(now);
  // AI status
  const lastAiErr = ev.find(e => e.agent === 'ai' && e.kind === 'err');
  const aiErr = lastAiErr && (!lastDec || tsOf(lastAiErr.time) > tsOf(lastDec.time)) && now - tsOf(lastAiErr.time) < 3 * 3600e3;
  const feedAge = feed ? now - tsOf(feed.at) : Infinity;
  const feedErr = mOpen && (feedAge > 20 * 60e3 || (ping && ping.err && now - ping.at < 10 * 60e3) || (ping && now - ping.at > 5 * 60e3));
  const lp = lastDec ? JSON.parse(lastDec.plan || '{}') : null;
  const agents = [];
  agents.push({ id: 'ai', name: 'AI-GOLD', room: 'm', grp: 'MARK2', mk: `XAUUSD · วางแผนทุกแท่ง H1 · ${MODEL}`,
    st: aiErr ? 'error' : paused ? 'stop' : ai.open ? 'hold' : 'wait',
    label: aiErr ? 'error' : paused ? 'หยุด' : ai.open ? 'ถือไม้' : ai.pending ? 'ตั้งออเดอร์รอ' : 'รอสัญญาณ',
    pos: ai.open, pending: ai.pending,
    note: aiErr ? 'เรียก Claude ไม่สำเร็จ: ' + lastAiErr.msg.slice(0, 120) : paused ? 'หยุดเปิดไม้ใหม่ (DD ถึง 30% หรือกดหยุด) รอคนตรวจ'
      : lp ? `แผนล่าสุด: ${lp.action} · ${lp.market_view || ''}`.slice(0, 160) : 'ยังไม่มีแผน รอแท่ง H1 ถัดไป',
    stats: [['รวม R', (ai.sum_r >= 0 ? '+' : '') + ai.sum_r + 'R', ai.sum_r > 0 ? 'up' : ai.sum_r < 0 ? 'down' : ''], ['DD ระบบ', ai.dd_r + 'R', ''], ['ไม้ปิด', ai.n + (ai.win !== null ? ` · ชนะ ${ai.win}%` : ''), '']],
    last: lastEv('ai') });
  agents.push({ id: 'rand', name: 'RANDOM TWIN', room: 'm', grp: 'BENCHMARK', mk: 'สุ่มฝั่ง · SL/TP เท่ากับไม้ AI',
    st: rnd.open ? 'hold' : paused ? 'stop' : 'wait', label: rnd.open ? 'ถือไม้' : paused ? 'หยุด' : 'รอไม้ AI',
    pos: rnd.open, note: 'เปิดไม้พร้อมกับตอนที่ไม้ AI ได้ fill เท่านั้น',
    stats: [['รวม R', (rnd.sum_r >= 0 ? '+' : '') + rnd.sum_r + 'R', rnd.sum_r > 0 ? 'up' : rnd.sum_r < 0 ? 'down' : ''], ['DD ระบบ', rnd.dd_r + 'R', ''], ['AI − Twin', ai.n ? r2(ai.sum_r / Math.max(ai.n, 1) - rnd.sum_r / Math.max(rnd.n, 1)) + 'R/ไม้' : '—', '']],
    last: lastEv('rand') });
  agents.push({ id: 'feed', name: 'FEED', room: 'm', grp: 'EA · EXNESS', mk: 'AIBarsEA ส่งแท่ง M15/H1 ' + (feed ? feed.symbol : ''),
    st: feedErr ? 'error' : !mOpen ? 'stop' : 'hold', label: feedErr ? 'error' : !mOpen ? 'ตลาดปิด' : 'ส่งข้อมูล',
    note: feedErr ? (ping && ping.err ? 'ส่งแท่งไม่สำเร็จ: ' + ping.err : feedAge > 20 * 60e3 ? `ไม่ได้รับแท่งมา ${Math.round(feedAge / 60e3)} นาที` : 'EA ไม่ ping มาเกิน 5 นาที')
      : `แท่ง M15 ล่าสุด ${feed ? iso(feed.lastM15 + 7 * 3600e3).slice(11) : '—'} น. · spread ${feed ? feed.spread : '—'}` + (ping && ping.ping_ms ? ` · ping ${ping.ping_ms} ms` : ''),
    stats: [['แท่ง M15', String(nM15), ''], ['โบรก', ping ? (ping.connected ? 'เชื่อมต่อ' : 'หลุด') : '—', ping && !ping.connected ? 'down' : ''], ['ราคา', bid ? px(bid) : '—', '']],
    last: feed ? tsOf(feed.at) : null });
  const RN = { scout: ['SCOUT', 'หาไอเดียใหม่'], tester: ['TESTER', 'backtest ตามมาตรฐาน'], auditor: ['AUDITOR', 'ตรวจผลแบบไม่เห็นงาน'], librarian: ['LIBRARIAN', 'บันทึก journal / backlog'], report: ['REPORT', 'สรุปผลให้เจ้าของ'] };
  const missed = dept.run_end ? now - dept.run_end > 30 * 3600e3 : false;
  for (const k of DEPT) {
    const r = dept.roles[k] || {};
    const st = r.state === 'error' || (k === 'report' && missed) ? 'error' : r.state === 'working' && now - (r.at || 0) < 4 * 3600e3 ? 'hold' : 'wait';
    agents.push({ id: k, name: RN[k][0], room: 's', grp: 'RESEARCH', mk: RN[k][1] + ' · ทุกคืน 01:37',
      st, label: st === 'error' ? 'error' : st === 'hold' ? 'กำลังทำงาน' : 'รอรอบคืนนี้',
      note: k === 'report' && missed ? 'รอบคืนล่าสุดไม่ได้รายงานเกิน 30 ชม.' : r.msg || 'ยังไม่มีรายงานจากรอบกลางคืน',
      stats: (r.stats && r.stats.length ? r.stats : k === 'tester' && dept.summary ? [['ทดสอบแล้ว', String(dept.summary.tested)], ['ผ่าน', String(dept.summary.passed)], ['คิว', String(dept.summary.backlog)]]
        : [['ทดสอบแล้ว', dept.summary ? String(dept.summary.tested) : '—'], ['ผ่าน', dept.summary ? String(dept.summary.passed) : '—'], ['คิว', dept.summary ? String(dept.summary.backlog) : '—']]).map(x => [x[0], x[1], '']),
      last: lastEv(k) || r.at || null });
  }
  const evToday = ev.filter(e => bkkDay(tsOf(e.time)) === today).length;
  return {
    now, market_open: mOpen,
    kpi: { equity: ai.eq, today_usd: ai.today_usd, today_pct: ai.today_pct, today_r: ai.today_r, dd_pct: ai.dd_pct, dd_limit: RULES.ddHalf, dd_stop: RULES.ddStop, peak: ai.peak,
      streak: ai.streak, paused,
      open: { ai: ai.n_open, ai_pending: ai.n_pend, rand: rnd.n_open } },
    hb: { mt5: ping ? ping.conn_at : null, vps: ping ? ping.at : null, feed: feed ? tsOf(feed.at) : null, ver: ping ? ping.ver : null, price_at: priceAt },
    agents, events: ev.map(e => ({ id: e.id, t: tsOf(e.time), agent: e.agent || 'sys', kind: e.kind || (e.level === 'ERROR' ? 'err' : 'info'), msg: e.msg })), events_today: evToday };
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
      if (p === '/ea/ping' && req.method === 'POST') { if (!(await eaAuth(req, env))) return json({ error: 'unauthorized' }, 401); return eaPing(req, env); }
      if (p === '/dept/report' && req.method === 'POST') return deptReport(req, env);
      if (p === '/office') return env.ASSETS.fetch(new Request(new URL('/office.html', req.url), req));
      if (p === '/api/login' && req.method === 'POST') return login(req, env);
      if (p === '/api/status') return json({ setup: !(await getDoc(env, 'secrets', 'auth')), authed: await session(req, env) });
      if (p.startsWith('/api/')) {
        if (!(await session(req, env))) return json({ error: 'login required' }, 401);
        if (p === '/api/view') return json(await view(env));
        if (p === '/api/office') return json(await office(env));
        if (p === '/api/pause' && req.method === 'POST') { const { paused } = await req.json(); await kvSet(env, 'paused', paused ? '1' : '0'); if (!paused) await kvSet(env, 'dd_stop', '0'); await event(env, 'WARN', paused ? 'หยุด AI (กดจากหน้าเว็บ)' : 'เปิด AI ต่อ (กดจากหน้าเว็บ)', 'boss', paused ? 'stop' : 'info'); return json({ ok: true }); }
        return json({ error: 'not found' }, 404);
      }
      return env.ASSETS.fetch(req);
    } catch (e) { return json({ error: e.message }, 500); }
  },
};
