//+------------------------------------------------------------------+
//| AIBarsEA.mq5 — AI-GOLD price feed (BARS ONLY, never trades)      |
//| Runs in the EXNESS terminal (not Pepperstone / Mark1).           |
//| Every new M15 bar: POST the last closed M15 + H1 bars to the     |
//| ai-gold Worker (/ea/bars). The Worker asks Claude for a plan on  |
//| each new H1 bar and simulates it as paper trades.                |
//| Repo copy keeps the placeholder token; the VPS copy has the real |
//| token. Allow the Worker URL in Tools > Options > Expert Advisors.|
//+------------------------------------------------------------------+
#property copyright "AI-GOLD"
#property version   "1.00"
#property strict

input string WorkerURL = "https://ai-gold.tevez7549.workers.dev";
input string Token     = "__AI_TOKEN__";
input int    M15Bars   = 300;
input int    H1Bars    = 400;

datetime lastM15 = 0;

int OnInit() { EventSetTimer(15); Print("AIBarsEA v1.00 started on ", _Symbol, " (bars only, no trading)"); return INIT_SUCCEEDED; }
void OnDeinit(const int r) { EventKillTimer(); }
void OnTick() { Step(); }
void OnTimer() { Step(); }

string BarsJson(ENUM_TIMEFRAMES tf, int n) {
   MqlRates r[]; ArraySetAsSeries(r, false);
   int got = CopyRates(_Symbol, tf, 1, n, r);   // shift 1 = closed bars only, oldest first
   if(got <= 0) return "[]";
   string s = "[";
   for(int i = 0; i < got; i++) {
      if(i) s += ",";
      s += StringFormat("[%I64d,%.3f,%.3f,%.3f,%.3f]", (long)r[i].time, r[i].open, r[i].high, r[i].low, r[i].close);
   }
   return s + "]";
}

void Step() {
   datetime t = iTime(_Symbol, PERIOD_M15, 0);
   if(t == 0 || t == lastM15) return;
   double spread = SymbolInfoDouble(_Symbol, SYMBOL_ASK) - SymbolInfoDouble(_Symbol, SYMBOL_BID);
   string body = StringFormat("{\"symbol\":\"%s\",\"spread\":%.3f,\"m15\":%s,\"h1\":%s}", _Symbol, spread, BarsJson(PERIOD_M15, M15Bars), BarsJson(PERIOD_H1, H1Bars));
   char data[], res[]; string hdr;
   StringToCharArray(body, data, 0, StringLen(body), CP_UTF8);
   string h = "Content-Type: application/json\r\nAuthorization: Bearer " + Token + "\r\n";
   ResetLastError();
   int code = WebRequest("POST", WorkerURL + "/ea/bars", h, 15000, data, res, hdr);
   if(code == 200) { lastM15 = t; }
   else Print("AIBarsEA post failed code=", code, " err=", GetLastError(), " ", CharArrayToString(res, 0, 200));
}
