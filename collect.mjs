// ดึงข้อมูลจาก IG แล้วเขียนเป็นไฟล์ใน data/ (รันโดย GitHub Actions ทุก 30 นาที)
//   data/<SYMBOL>.json         สัดส่วน long/short ของลูกค้า IG
//   data/prices/<SYMBOL>.json  ราคาปิดแท่ง 30 นาที (ดึงชั่วโมงละครั้งเพื่อประหยัดโควตา)
//   data/epics.json            รหัสสินทรัพย์ของ IG ที่หาให้อัตโนมัติ (แก้เองได้ถ้าหาผิด)
//   data/index.json            สถานะล่าสุด และโควตาที่เหลือ
import fs from "node:fs";

const HOST = process.env.IG_HOST || "https://demo-api.ig.com/gateway/deal";
const { IG_API_KEY: KEY, IG_USERNAME: USER, IG_PASSWORD: PASS } = process.env;
if (!KEY || !USER || !PASS) {
  console.error("ไม่พบ secrets IG_API_KEY / IG_USERNAME / IG_PASSWORD");
  process.exit(1);
}

// marketId สำหรับ sentiment (ตัวที่เป็น null จะหาให้อัตโนมัติจาก epic)
const IG_IDS = {
  EURUSD: "EURUSD", GBPUSD: "GBPUSD", USDJPY: "USDJPY", USDCHF: "USDCHF",
  AUDUSD: "AUDUSD", USDCAD: "USDCAD", NZDUSD: "NZDUSD", EURGBP: "EURGBP",
  EURJPY: "EURJPY", GBPJPY: "GBPJPY", AUDJPY: "AUDJPY", EURCHF: "EURCHF",
  XAUUSD: "GOLD", XAGUSD: "SILVER", DE40: "DAX",
  NAS100: null, SPX500: null, US30: null, USOIL: null,
};
// คำค้นหาสินทรัพย์ใน IG และชนิดที่คาดไว้ (ชื่อเป็นของ IG ยังไม่ได้ยืนยันกับบัญชีจริง)
const SEARCH = {
  EURUSD: ["EUR/USD", "CURRENCIES"], GBPUSD: ["GBP/USD", "CURRENCIES"], USDJPY: ["USD/JPY", "CURRENCIES"],
  USDCHF: ["USD/CHF", "CURRENCIES"], AUDUSD: ["AUD/USD", "CURRENCIES"], USDCAD: ["USD/CAD", "CURRENCIES"],
  NZDUSD: ["NZD/USD", "CURRENCIES"], EURGBP: ["EUR/GBP", "CURRENCIES"], EURJPY: ["EUR/JPY", "CURRENCIES"],
  GBPJPY: ["GBP/JPY", "CURRENCIES"], AUDJPY: ["AUD/JPY", "CURRENCIES"], EURCHF: ["EUR/CHF", "CURRENCIES"],
  XAUUSD: ["Spot Gold", "COMMODITIES"], XAGUSD: ["Spot Silver", "COMMODITIES"],
  NAS100: ["US Tech 100", "INDICES"], SPX500: ["US 500", "INDICES"], US30: ["Wall Street", "INDICES"],
  DE40: ["Germany 40", "INDICES"], USOIL: ["Oil - US Crude", "COMMODITIES"],
};
const SLOT = 30 * 60 * 1000;
const KEEP = 2000;
const KEEP_PRICES = 600;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return d; } };
fs.mkdirSync("data/prices", { recursive: true });

const login = await fetch(HOST + "/session", {
  method: "POST",
  headers: { "X-IG-API-KEY": KEY, Version: "2", "Content-Type": "application/json", Accept: "application/json; charset=UTF-8" },
  body: JSON.stringify({ identifier: USER, password: PASS }),
});
if (!login.ok) throw new Error(`IG login ${login.status} ${await login.text()}`);
const cst = login.headers.get("CST");
const xst = login.headers.get("X-SECURITY-TOKEN");

async function ig(path, version = "1", tries = 4) {
  const r = await fetch(HOST + path, {
    headers: { "X-IG-API-KEY": KEY, CST: cst, "X-SECURITY-TOKEN": xst, Version: version, Accept: "application/json; charset=UTF-8" },
  });
  if (!r.ok) {
    const body = (await r.text()).slice(0, 200);
    // ชนลิมิตคำขอต่อนาที: รอแล้วลองใหม่ (ไม่ใช่โควตาประวัติราคารายสัปดาห์)
    if ((r.status === 403 || r.status === 429) && /exceeded-api-key-allowance|too-many|rate/i.test(body) && tries > 1) {
      await sleep(25000);
      return ig(path, version, tries - 1);
    }
    throw new Error(`IG ${r.status} ${path} ${body}`);
  }
  return r.json();
}

// ---------- 1) หา epic (ครั้งแรกครั้งเดียว) ----------
const epics = readJson("data/epics.json", {});
const BAD = /mini|micro|weekend|option|rolling|daily|inverse|turbo|knock|\bjan|\bfeb|\bmar|\bapr|\bmay|\bjun|\bjul|\baug|\bsep|\boct|\bnov|\bdec/i;
for (const [sym, [term, type]] of Object.entries(SEARCH)) {
  if (epics[sym]?.epic) continue;
  try {
    const d = await ig("/markets?searchTerm=" + encodeURIComponent(term));
    const all = d.markets || [];
    let list = all.filter((m) => m.instrumentType === type && !BAD.test(m.instrumentName || ""));
    if (!list.length) list = all.filter((m) => !/mini|micro|option/i.test(m.instrumentName || "") && m.expiry === "-");
    if (!list.length) console.warn("ผลค้นหา", sym, JSON.stringify(all.slice(0, 5).map((m) => [m.epic, m.instrumentName, m.instrumentType, m.expiry])));
    const score = (m) =>
      (m.expiry === "-" ? 4 : 0) + (/\.IP$/.test(m.epic) ? 2 : 0) + (/^(CS\.D|IX\.D)/.test(m.epic) ? 2 : 0) +
      ((m.instrumentName || "").toLowerCase().includes(term.toLowerCase()) ? 1 : 0);
    list.sort((a, b) => score(b) - score(a));
    if (list[0]) epics[sym] = { epic: list[0].epic, name: list[0].instrumentName };
    else console.warn("หา epic ไม่เจอ:", sym);
  } catch (e) {
    console.warn("search", sym, e.message);
  }
  await sleep(3000);
}
// หา marketId สำหรับ sentiment ของตัวที่ยังไม่มี
for (const [sym, id] of Object.entries(IG_IDS)) {
  if (id || !epics[sym]?.epic || epics[sym].marketId) continue;
  try {
    const d = await ig("/markets/" + epics[sym].epic, "3");
    if (d.instrument?.marketId) epics[sym].marketId = d.instrument.marketId;
  } catch (e) {
    console.warn("marketId", sym, e.message);
  }
  await sleep(3000);
}
fs.writeFileSync("data/epics.json", JSON.stringify(epics, null, 1));

// ---------- 2) sentiment ----------
const ts = Math.floor(Date.now() / SLOT) * SLOT;
const idOf = (sym) => IG_IDS[sym] || epics[sym]?.marketId || null;
const bySymbol = {};
for (const sym of Object.keys(IG_IDS)) if (idOf(sym)) bySymbol[idOf(sym)] = sym;
const base = Object.keys(IG_IDS).filter((s) => IG_IDS[s]).map((s) => IG_IDS[s]);
const extra = Object.keys(IG_IDS).filter((s) => !IG_IDS[s] && idOf(s)).map((s) => idOf(s));
let sentiments = (await ig("/clientsentiment?marketIds=" + base.join(","))).clientSentiments || [];
for (const id of extra) {
  try { sentiments = sentiments.concat((await ig("/clientsentiment?marketIds=" + id)).clientSentiments || []); }
  catch (e) { console.warn("sentiment", id, e.message); }
}
const savedSent = [];
for (const s of sentiments) {
  const sym = bySymbol[s.marketId];
  if (!sym) continue;
  const file = `data/${sym}.json`;
  const arr = readJson(file, []).filter((x) => x.ts !== ts);
  arr.push({ ts, long: s.longPositionPercentage, short: s.shortPositionPercentage });
  fs.writeFileSync(file, JSON.stringify(arr.slice(-KEEP)));
  savedSent.push(sym);
}

// ---------- 3) ราคา (ชั่วโมงละครั้ง หรือเมื่อสั่งรันเอง) ----------
const state = readJson("data/index.json", {});
let allowance = state.allowance || null;
const force = process.env.GITHUB_EVENT_NAME === "workflow_dispatch";
const hourly = new Date().getUTCMinutes() < 30;
const savedPrices = [];
const priceErrors = [];
for (const [sym, e] of Object.entries(epics)) {
  if (!e.epic) continue;
  const file = `data/prices/${sym}.json`;
  let old = readJson(file, []);
  if (e.pxEpic !== e.epic) { old = []; e.pxEpic = e.epic; } // เปลี่ยน epic แล้ว ทิ้งราคาเก่าที่อาจเป็นคนละสินทรัพย์
  if (!(force || hourly || old.length < 20)) continue;
  if (allowance && allowance.remaining != null && allowance.remaining < 150) { priceErrors.push("โควตาใกล้หมด"); break; }
  const max = old.length < 48 ? 48 : 3;
  try {
    const d = await ig(`/prices/${e.epic}?resolution=MINUTE_30&max=${max}&pageSize=0`, "3");
    if (d.metadata?.allowance) {
      allowance = { remaining: d.metadata.allowance.remainingAllowance, total: d.metadata.allowance.totalAllowance, resetInSec: d.metadata.allowance.allowanceExpiry };
    }
    const map = new Map(old.map((x) => [x.t, x.c]));
    for (const p of d.prices || []) {
      const cp = p.closePrice || {};
      const bid = cp.bid, ask = cp.ask;
      const close = bid != null && ask != null ? (bid + ask) / 2 : cp.lastTraded;
      if (close == null) continue;
      const raw = p.snapshotTimeUTC || p.snapshotTime;
      const t = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(raw) ? raw : raw.replace(/\//g, "-").replace(" ", "T") + "Z");
      if (!Number.isNaN(t)) map.set(t, close);
    }
    const arr = [...map.entries()].sort((a, b) => a[0] - b[0]).slice(-KEEP_PRICES).map(([t, c]) => ({ t, c }));
    const med = arr.map((x) => x.c).sort((a, b) => a - b)[Math.floor(arr.length / 2)];
    for (let i = arr.length - 1; i >= 0; i--) if (med && Math.abs(arr[i].c - med) / med > 0.25) arr.splice(i, 1);
    fs.writeFileSync(file, JSON.stringify(arr));
    savedPrices.push(sym);
  } catch (err) {
    priceErrors.push(`${sym}: ${err.message}`);
    if (/historical-data-allowance/i.test(err.message)) break; // โควตาประวัติราคารายสัปดาห์หมด
  }
  await sleep(2500);
}


// ---------- 4) ออเดอร์บุ๊คจริง (ทอง/เงิน) จากตลาดสาธารณะของ Binance ไม่ต้องสมัคร ----------
// แท่งแดง = ออเดอร์ขายที่ตั้งรออยู่เหนือราคา, แท่งน้ำเงิน = ออเดอร์ซื้อที่ตั้งรออยู่ใต้ราคา
const BOOKS = {
  XAUUSD: [["https://fapi.binance.com/fapi/v1/depth?symbol=XAUUSDT&limit=1000", "futures XAUUSDT"],
           ["https://data-api.binance.vision/api/v3/depth?symbol=PAXGUSDT&limit=5000", "spot PAXGUSDT"]],
  XAGUSD: [["https://fapi.binance.com/fapi/v1/depth?symbol=XAGUSDT&limit=1000", "futures XAGUSDT"]],
};
const bookInfo = {};
for (const [sym, urls] of Object.entries(BOOKS)) {
  for (const [url, label] of urls) {
    try {
      const r = await fetch(url, { headers: { Accept: "application/json" } });
      if (!r.ok) { bookInfo[sym] = `${label}: HTTP ${r.status}`; continue; }
      const d = await r.json();
      const bids = (d.bids || []).map(([p, q]) => [+p, +q]), asks = (d.asks || []).map(([p, q]) => [+p, +q]);
      if (!bids.length || !asks.length) { bookInfo[sym] = `${label}: empty`; continue; }
      const mid = (bids[0][0] + asks[0][0]) / 2;
      const N = 40;
      // ความกว้างช่วงราคา: ครอบคลุมออเดอร์ 90% ของแต่ละฝั่ง (ตัดออเดอร์ไกลๆ ที่โผล่มาประปรายทิ้ง)
      const reach = (arr, sign) => {
        const tot = arr.reduce((t, [p, q]) => t + p * q, 0); let c = 0;
        for (const [p, q] of arr) { c += p * q; if (c >= tot * 0.9) return Math.abs(p - mid); }
        return Math.abs(arr[arr.length - 1][0] - mid);
      };
      const span = Math.max(reach(bids), reach(asks));
      const w = span / N;
      if (!(w > 0)) { bookInfo[sym] = `${label}: bad span`; continue; }
      const bins = [];
      for (let i = N - 1; i >= 0; i--) bins.push({ p: mid + (i + 0.5) * w, b: 0, s: 0 }); // เหนือราคา (sell)
      for (let i = 0; i < N; i++) bins.push({ p: mid - (i + 0.5) * w, b: 0, s: 0 }); // ใต้ราคา (buy)
      for (const [p, q] of asks) { const i = Math.floor((p - mid) / w); if (i >= 0 && i < N) bins[N - 1 - i].s += q * p; }
      for (const [p, q] of bids) { const i = Math.floor((mid - p) / w); if (i >= 0 && i < N) bins[N + i].b += q * p; }
      const file = `data/book/${sym}.json`;
      fs.mkdirSync("data/book", { recursive: true });
      const arr = readJson(file, []).filter((x) => x.ts !== ts);
      arr.push({ ts, mid, w, src: label, bins: bins.map((x) => ({ p: +x.p.toFixed(6), b: Math.round(x.b), s: Math.round(x.s) })) });
      fs.writeFileSync(file, JSON.stringify(arr.slice(-144)));
      bookInfo[sym] = `${label}: ok`;
      break;
    } catch (e) {
      bookInfo[sym] = `${label}: ${e.message}`;
    }
  }
}
console.log("book", JSON.stringify(bookInfo));
fs.writeFileSync("data/epics.json", JSON.stringify(epics, null, 1));
fs.writeFileSync("data/index.json", JSON.stringify({
  updated: Date.now(), symbols: savedSent, prices: savedPrices, allowance, priceErrors: priceErrors.slice(0, 5), book: bookInfo,
}));
console.log("sentiment", savedSent.length, "prices", savedPrices.length, "allowance", JSON.stringify(allowance), "errors", priceErrors.length);
for (const e of priceErrors.slice(0, 5)) console.warn(e);
