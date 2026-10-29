-- AI-GOLD (separate from Mark1 / forex-agent). Paper trading only.
CREATE TABLE IF NOT EXISTS kv(k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS docs(coll TEXT, id TEXT, data TEXT, PRIMARY KEY(coll,id));
CREATE TABLE IF NOT EXISTS bars(tf TEXT, t INTEGER, o REAL, h REAL, l REAL, c REAL, PRIMARY KEY(tf,t));
-- one row per H1 decision (the AI's full answer is kept for the web page)
CREATE TABLE IF NOT EXISTS decisions(id INTEGER PRIMARY KEY AUTOINCREMENT, time TEXT, bar_t INTEGER, model TEXT, tokens_in INTEGER, tokens_out INTEGER,
  plan TEXT, valid INTEGER, note TEXT);
-- paper trades: kind 'ai' = the AI's plan, 'rand' = benchmark twin (random side, same SL/TP distance, opened when the AI trade fills)
CREATE TABLE IF NOT EXISTS trades(id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT, status TEXT, side INTEGER, otype TEXT,
  created TEXT, created_t INTEGER, expiry_t INTEGER, entry REAL, sl REAL, sl_init REAL, tp REAL,
  fill_t INTEGER, fill REAL, exit_t INTEGER, exit REAL, r REAL, exit_reason TEXT, decision_id INTEGER, twin_of INTEGER, lesson TEXT);
CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT, time TEXT, level TEXT, msg TEXT, agent TEXT, kind TEXT);  -- agent/kind added 2026-10-29 for the Agent Office
CREATE INDEX IF NOT EXISTS idx_trades_status ON trades(status);
