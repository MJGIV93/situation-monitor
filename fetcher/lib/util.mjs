// Small helpers shared by the adapters.

export const json = (t) => JSON.parse(t);

export function need(cond, msg) {
  if (!cond) throw new Error(msg);
}

// Request that must succeed. Adapters throw on failure so the runner can keep the last good reading.
export async function fetchOk(ctx, url, opts) {
  const res = await ctx.get(url, opts);
  if (!res.ok) throw new Error(`${new URL(url).host} answered ${res.status || res.error}`);
  return res.text;
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“" };
export function unescape(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m);
}
export function strip(html) {
  return unescape(String(html).replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}
export function clip(s, n) {
  s = String(s ?? "").trim();
  if (s.length <= n) return s;
  const cut = s.slice(0, n - 1);
  return cut.slice(0, Math.max(cut.lastIndexOf(" "), n - 20)).replace(/[\s,;:.]+$/, "") + "…";
}

/* ---- numbers ---- */
export function median(a) {
  if (!a.length) return null;
  const s = a.slice().sort((x, y) => x - y), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
export function pctile(a, p) {
  if (!a.length) return null;
  const s = a.slice().sort((x, y) => x - y), i = (s.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i);
  return s[lo] + (s[hi] - s[lo]) * (i - lo);
}
export const round = (x, d = 2) => (x == null ? null : Math.round(x * 10 ** d) / 10 ** d);
export const commas = (n, d = 0) => n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
export function short(n) {
  return n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + "M" : n >= 1e4 ? Math.round(n / 1e3) + "k" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : String(n);
}
export function pct(x) {
  return x >= 10 ? x.toFixed(0) + "%" : x >= 1 ? x.toFixed(1) + "%" : x >= 0.1 ? x.toFixed(2) + "%" : x.toFixed(3) + "%";
}

/* ---- time, always shown in Eastern ---- */
const TZ = "America/New_York";
const dayFmt = new Intl.DateTimeFormat("en-US", { timeZone: TZ, month: "short", day: "numeric" });
const clockFmt = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" });
const wdayFmt = new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short", hour: "numeric", minute: "2-digit" });
export const etDay = (t) => dayFmt.format(new Date(t));
export const etClock = (t) => clockFmt.format(new Date(t));
export const etStamp = (t) => `${etDay(t)}, ${etClock(t)} ET`;
export const etWeekdayClock = (t) => wdayFmt.format(new Date(t));
export function agoText(ms) {
  const m = Math.round(ms / 60000);
  if (m < 60) return m + " min ago";
  const h = Math.round(m / 60);
  if (h < 48) return h + " hr ago";
  const d = Math.round(h / 24);
  return d < 14 ? d + "d ago" : d < 60 ? Math.round(d / 7) + "w ago" : Math.round(d / 30) + "mo ago";
}

/* ---- distance ---- */
export function km(lat1, lon1, lat2, lon2) {
  const r = Math.PI / 180, a = Math.sin(((lat2 - lat1) * r) / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(a));
}

/* ---- price readings ---- */
// hist: values oldest to newest, the last one being the current value.
// perWeek: points per week (5 trading days, 7 calendar days, or 1 for weekly data).
// Returns the fields every price reading carries: range, median, and what a large move is.
export function priceFields(hist, perWeek, chg) {
  const year = perWeek === 1 ? 52 : perWeek === 7 ? 365 : 252;
  const h = hist.slice(-(year + 1));
  const move = (n) => {
    const out = [];
    for (let i = n; i < h.length; i++) {
      const a = h[i - n], b = h[i];
      if (chg === "abs") out.push(Math.abs(b - a));
      else if (a) out.push(Math.abs(((b - a) / a) * 100));
    }
    return out;
  };
  const d = chg === "abs" ? 3 : 2;
  const keep = perWeek === 1 ? 52 : perWeek === 7 ? 95 : 70;
  return {
    num: round(h.at(-1), 4),
    lo: round(Math.min(...h), 4),
    hi: round(Math.max(...h), 4),
    med: round(median(h), 4),
    series: h.slice(-keep).map((x) => round(x, 4)),
    wk: perWeek,
    chg,
    bigA: round(pctile(move(1), 0.95), d),
    bigB: round(pctile(move(perWeek === 1 ? 4 : perWeek), 0.95), d),
  };
}

// FRED csv -> [{date, v}] with missing days dropped.
export function fredRows(text) {
  const lines = text.trim().split("\n");
  need(/date/i.test(lines[0] ?? ""), "not a FRED csv");
  return lines.slice(1).map((l) => l.split(",")).filter((c) => c[1] && c[1] !== "." && isFinite(Number(c[1]))).map((c) => ({ date: c[0], v: Number(c[1]) }));
}
export const fredUrl = (id) => `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}&cosd=${new Date(Date.now() - 420 * 86400e3).toISOString().slice(0, 10)}`;
