// ดึง client sentiment จาก IG แล้วเขียนเป็นไฟล์ data/<SYMBOL>.json (รันโดย GitHub Actions ทุก 30 นาที)
import fs from "node:fs";

const HOST = process.env.IG_HOST || "https://demo-api.ig.com/gateway/deal";
const { IG_API_KEY: KEY, IG_USERNAME: USER, IG_PASSWORD: PASS } = process.env;
if (!KEY || !USER || !PASS) {
  console.error("ไม่พบ secrets IG_API_KEY / IG_USERNAME / IG_PASSWORD");
  process.exit(1);
}

// ชื่อในหน้าเว็บ -> marketId ของ IG (ตัวที่เป็น null ยังไม่ได้หา marketId)
const IG_IDS = {
  EURUSD: "EURUSD", GBPUSD: "GBPUSD", USDJPY: "USDJPY", USDCHF: "USDCHF",
  AUDUSD: "AUDUSD", USDCAD: "USDCAD", NZDUSD: "NZDUSD", EURGBP: "EURGBP",
  EURJPY: "EURJPY", GBPJPY: "GBPJPY", AUDJPY: "AUDJPY", EURCHF: "EURCHF",
  XAUUSD: "GOLD", XAGUSD: "SILVER", DE40: "DAX",
  NAS100: null, SPX500: null, US30: null, USOIL: null,
};
const SLOT = 30 * 60 * 1000;
const KEEP = 2000; // เก็บย้อนหลังประมาณ 40 วัน

const login = await fetch(HOST + "/session", {
  method: "POST",
  headers: {
    "X-IG-API-KEY": KEY,
    Version: "2",
    "Content-Type": "application/json",
    Accept: "application/json; charset=UTF-8",
  },
  body: JSON.stringify({ identifier: USER, password: PASS }),
});
if (!login.ok) throw new Error(`IG login ${login.status} ${await login.text()}`);
const cst = login.headers.get("CST");
const xst = login.headers.get("X-SECURITY-TOKEN");

const ids = Object.values(IG_IDS).filter(Boolean);
const res = await fetch(HOST + "/clientsentiment?marketIds=" + ids.join(","), {
  headers: {
    "X-IG-API-KEY": KEY, CST: cst, "X-SECURITY-TOKEN": xst,
    Version: "1", Accept: "application/json; charset=UTF-8",
  },
});
if (!res.ok) throw new Error(`IG sentiment ${res.status} ${await res.text()}`);
const { clientSentiments = [] } = await res.json();

const bySymbol = Object.fromEntries(
  Object.entries(IG_IDS).filter(([, v]) => v).map(([k, v]) => [v, k])
);
const ts = Math.floor(Date.now() / SLOT) * SLOT;
fs.mkdirSync("data", { recursive: true });
const saved = [];
for (const s of clientSentiments) {
  const sym = bySymbol[s.marketId];
  if (!sym) continue;
  const file = `data/${sym}.json`;
  let arr = [];
  try { arr = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
  arr = arr.filter((x) => x.ts !== ts);
  arr.push({ ts, long: s.longPositionPercentage, short: s.shortPositionPercentage });
  fs.writeFileSync(file, JSON.stringify(arr.slice(-KEEP)));
  saved.push(sym);
}
fs.writeFileSync("data/index.json", JSON.stringify({ updated: Date.now(), symbols: saved }));
console.log("saved", saved.length, saved.join(","));
