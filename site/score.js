// Scoring rules. One copy, used by the page and by the fetcher, so the number
// recorded in history is always the number shown on screen.

export const FRESH_MS = 3 * 60 * 60 * 1000;
export const HOLD_MS = 24 * 60 * 60 * 1000;
export const SCOPES = [["national", "USA"], ["home", "Home"]];
export const BANDS = ["Quiet", "Watch", "Elevated", "Disrupted", "Severe"];
export const LINES = ["Nothing ever happens.", "Monitoring the situation.", "The situation is developing.", "Several situations at once.", "It's happening."];
export const TILES = [
  { id: "power", name: "Utilities" },
  { id: "air", name: "Travel" },
  { id: "net", name: "Internet" },
  { id: "money", name: "Money" },
  { id: "fuel", name: "Fuel" },
  { id: "hazard", name: "Hazards" },
  { id: "gov", name: "Advisories" },
  { id: "cyber", name: "Cyber" },
];
// Most a single domain can add to a score on its own, as a share of 100.
export const WEIGHTS = {
  national: { power: 0.7, net: 0.5, money: 0.5, air: 0.4, cyber: 0.4, hazard: 0.3, gov: 0.5, fuel: 0.3 },
  home: { power: 0.8, air: 0.6, net: 0.5, money: 0.5, hazard: 0.7, fuel: 0.4, gov: 0.5, cyber: 0.1 },
};
export const STATE_SEV = { ok: 0, minor: 20, major: 50, critical: 80 };
export const STATE_WORD = { ok: "OK", minor: "Minor", major: "Major", critical: "Critical" };
// Move size in multiples of a large move for that series -> points.
export const CURVE = [[0, 0], [0.5, 5], [1, 20], [2, 50], [4, 90], [6, 100]];

const HOUR = 3600e3;

export function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }
export function num(x) { if (x == null || x === "") return null; const n = Number(x); return isFinite(n) ? n : null; }
export function arr(x) { return Array.isArray(x) ? x : []; }
export function band(s) { return s >= 75 ? 4 : s >= 50 ? 3 : s >= 25 ? 2 : s >= 10 ? 1 : 0; }
export function tileName(id) { const t = TILES.find((x) => x.id === id); return t ? t.name : id; }
export function age(iso, now = Date.now()) { const t = Date.parse(iso); return isNaN(t) ? null : now - t; }
// live: still counted toward the scores. fresh: read within the last 3 hours.
export function live(f, now = Date.now()) { const a = age(f.checkedAt, now); return f.ok !== false && a != null && a < HOLD_MS; }
export function fresh(f, now = Date.now()) { const a = age(f.checkedAt, now); return f.ok !== false && a != null && a < FRESH_MS; }

/* ---- number formats ---- */
export function commas(n, d) { return n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d }); }
export function fmt(v, f) {
  if (v == null) return "–";
  switch (f) {
    case "usd0": return "$" + commas(v, 0);
    case "usd2": return "$" + commas(v, 2);
    case "usd3": return "$" + commas(v, 3);
    case "usdk": return "$" + commas(v / 1000, 1) + "k";
    case "pct2": return commas(v, 2) + "%";
    case "num0": return commas(v, 0);
    case "num1": return commas(v, 1);
    default: return commas(v, 2);
  }
}
export function signed(v, text) { return (v > 0 ? "+" : v < 0 ? "−" : "") + text; }

/* ---- price readings: every series is compared over the same windows ---- */
export function isPct(f) { return f.chg !== "abs"; }
export function wk(f) { return num(f.wk) || 5; }
export function windows(f) {
  const w = wk(f);
  return w === 1 ? [["1w", 1], ["1m", 4], ["3m", 13]] : [["1d", 1], ["1w", w], ["1m", w === 7 ? 30 : 21], ["3m", w === 7 ? 90 : 63]];
}
// Value n points back. A reading without a long series can carry explicit
// reference values instead, keyed by how many points back they stand for.
export function back(f, n) {
  if (f.refs && num(f.refs[n]) != null) return num(f.refs[n]);
  const s = arr(f.series);
  return s.length > n ? num(s[s.length - 1 - n]) : null;
}
export function moveOver(f, n) {
  const p = back(f, n), v = num(f.num);
  if (p == null || v == null) return null;
  return isPct(f) ? (p ? ((v - p) / p) * 100 : null) : v - p;
}
export function sizeText(f, x) { return isPct(f) ? x.toFixed(1) + "%" : f.fmt === "pct2" ? Math.round(x * 100) + " bp" : x.toFixed(2); }
export function moveText(f, m) { return m == null ? "" : signed(m, sizeText(f, Math.abs(m))); }

export function interp(table, x) {
  if (x <= table[0][0]) return table[0][1];
  for (let i = 1; i < table.length; i++) {
    if (x <= table[i][0]) return table[i - 1][1] + ((table[i][1] - table[i - 1][1]) * (x - table[i - 1][0])) / (table[i][0] - table[i - 1][0]);
  }
  return table[table.length - 1][1];
}
function absTable(f) {
  const a = f.abs;
  if (!a || !Array.isArray(a.x) || !Array.isArray(a.s)) return [];
  return a.x.map((x, i) => [num(x), num(a.s[i])]).filter((p) => p[0] != null && p[1] != null);
}

function priceCalc(f) {
  const v = num(f.num), lo = num(f.lo), hi = num(f.hi), w = wk(f);
  const hasRange = v != null && lo != null && hi != null && hi > lo;
  const pos = hasRange ? clamp((v - lo) / (hi - lo), 0, 1) : 0.5;
  const out = { pos, head: moveOver(f, w), lines: [], sev: 0 };
  const adv = (m) => (f.bad === "high" ? m : f.bad === "low" ? -m : Math.abs(m));
  const wins = w === 1
    ? [["1w", "week", 1, num(f.bigA)], ["1m", "month", 4, num(f.bigB)]]
    : [["1d", "day", 1, num(f.bigA)], ["1w", "week", w, num(f.bigB)]];
  let sMove = 0, best = null;
  wins.forEach((x) => {
    const m = moveOver(f, x[2]);
    if (m == null || !x[3]) return;
    const r = adv(m) / x[3], pts = r > 0 ? interp(CURVE, r) : 0;
    if (best == null || pts > sMove) { sMove = pts; best = { label: x[0], word: x[1], m, big: x[3], r }; }
  });
  const table = absTable(f);
  if (table.length && v != null) {
    const sLevel = interp(table, v);
    out.lines.push("Level: " + Math.round(sLevel) + ". Its own scale runs " + table.map((p) => fmt(p[0], f.fmt) + " = " + p[1]).join(", ") + ".");
    out.sev = Math.max(sLevel, sMove);
  } else if (hasRange) {
    const p = f.bad === "high" ? pos : f.bad === "low" ? 1 - pos : Math.abs(pos - 0.5) * 2;
    let sPos = Math.max(0, (p - 0.75) / 0.25) * 20;
    const easing = f.bad !== "both" && out.head != null && adv(out.head) < 0 && sPos > 0;
    if (easing) sPos *= 0.4;
    const edge = f.bad === "high" ? "high" : f.bad === "low" ? "low" : pos < 0.5 ? "low" : "high";
    out.lines.push("Position: " + Math.round(sPos) + ". It sits " + Math.round(pos * 100) + "% of the way up its 12-month range, and the outer quarter at the " + edge + " end adds up to 20" + (easing ? ", cut here because the past week eased" : "") + ".");
    out.sev = sPos + sMove;
  } else {
    out.lines.push("Position: not scored yet. This reading doesn't have a year of history.");
    out.sev = sMove;
  }
  if (best) out.lines.push("Move: " + Math.round(sMove) + ". The " + best.label + " change of " + moveText(f, best.m) + (best.r > 0 ? " is " + best.r.toFixed(1) + " times a large " + best.word + " for this series (" + sizeText(f, best.big) + ")." : " is in the harmless direction."));
  out.lines.push("A large move is one bigger than 95% of the past year's. 1 time scores 20, 2 times 50, 4 times 90." + (table.length ? " The score is the higher of level and move." : ""));
  const cap = num(f.cap);
  if (cap != null && out.sev > cap) { out.lines.push("Capped at " + cap + ". It's market context and can't break anything by itself."); out.sev = cap; }
  return out;
}

/* ---- trains ---- */
export function trainList(f) {
  const out = [];
  arr(f.dirs).forEach((d) => { arr(d && d.trains).slice(0, 3).forEach((t) => { if (t) out.push(t); }); });
  return out;
}
const LATE_PTS = [[0, 0], [5, 4], [10, 12], [20, 20], [40, 30]];
const LINE_DELAY_PTS = [[0, 0], [10, 15], [20, 35], [40, 60], [60, 80]];
function trainCalc(f) {
  const r = { sev: 0, lines: [] };
  let pts = 0, late = 0, canc = 0;
  trainList(f).forEach((t) => {
    if (t.s === "cancelled") { canc++; pts += 30; }
    else if (t.s === "late") { late++; pts += num(t.d) != null ? interp(LATE_PTS, num(t.d)) : 12; }
  });
  const board = Math.min(85, pts);
  const lineDelay = num(f.lineDelay), line = lineDelay ? interp(LINE_DELAY_PTS, lineDelay) : 0;
  r.sev = f.suspended ? 90 : Math.max(board, line);
  r.lines.push("Board: " + Math.round(board) + ". Counts the next three trains each way. A late train scores by how late it is (12 at 10 minutes, 20 at 20, 30 at 40) and a cancellation scores 30." + (late || canc ? " Now: " + late + " late, " + canc + " cancelled." : ""));
  if (lineDelay) r.lines.push("Line alert: " + Math.round(line) + ". NJ Transit is reporting delays of up to " + lineDelay + " minutes on the line.");
  if (f.suspended) r.lines.push("Service is suspended, which scores 90.");
  else r.lines.push("The score is the higher of the board and any line-wide delay alert.");
  return r;
}

/* ---- alerts and other dated events ---- */
const ET = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric", hour12: false });
function commuteHour(t) {
  const parts = ET.formatToParts(new Date(t));
  const day = parts.find((p) => p.type === "weekday").value;
  const hour = Number(parts.find((p) => p.type === "hour").value) % 24;
  return day !== "Sat" && day !== "Sun" && ((hour >= 6 && hour < 10) || (hour >= 16 && hour < 20));
}
function overlapsCommute(from, to) {
  const end = Math.min(to, from + 72 * HOUR);
  for (let t = from; t <= end; t += HOUR) if (commuteHour(t)) return true;
  return commuteHour(end);
}
const WX_HIGH = /^(Blizzard|Ice Storm|Flash Flood|Tornado|Hurricane|Tropical Storm|Storm Surge|Extreme Wind|Snow Squall|Tsunami|Dust Storm) Warning$/i;
const WX_MINOR_WARNING = /^(Freeze|Hard Freeze|Frost|Red Flag|Gale|Storm|Hazardous Seas|Heavy Freezing Spray|Lake Effect Snow) Warning$/i;
const WX_MARINE = /Small Craft|Marine|Rip Current|Beach Hazards|Surf|Seas|Gale|Freezing Spray/i;
export function weatherTier(e) {
  const name = String(e.event || "");
  if (e.emergency) return [95, "emergency"];
  if (WX_HIGH.test(name)) return [80, "high-end warning"];
  if (WX_MARINE.test(name)) return [5, "marine notice"];
  if (WX_MINOR_WARNING.test(name)) return [15, "advisory-level warning"];
  if (/Warning$/i.test(name)) return [55, "warning"];
  if (/Watch$/i.test(name)) return [30, "watch"];
  if (/Advisory$|Air Quality Alert/i.test(name)) return [15, "advisory"];
  return [5, "statement"];
}
// Full score for 6 hours, half until 24 hours, then nothing.
function fade(at, now, full = 6, half = 24) {
  const h = (now - Date.parse(at)) / HOUR;
  return isNaN(h) ? 0 : h < full ? 1 : h < half ? 0.5 : 0;
}
const QUAKE_NEAR = [[2.5, 10], [3.5, 30], [4.5, 55], [5.5, 85], [6.5, 100]];
const QUAKE_FAR = [[3.5, 10], [4.5, 30], [5.5, 55], [6.5, 85]];
function stepTable(table, x) { let v = 0; table.forEach((p) => { if (x >= p[0]) v = p[1]; }); return v; }

const EVENT_RULES = {
  weather(e, now) {
    const [base, tier] = weatherTier(e);
    const onset = Date.parse(e.onset) || now, ends = Date.parse(e.ends) || now + 12 * HOUR;
    if (ends < now) return { pts: 0, why: "ended" };
    const far = onset - now > 6 * HOUR;
    const commute = base >= 15 && overlapsCommute(Math.max(now, onset), ends);
    const pts = base * (far ? 0.6 : 1) + (commute ? 10 : 0);
    return { pts, why: tier + " " + base + (far ? ", at 60% until 6 hours before it starts" : "") + (commute ? ", +10 for a weekday commute" : "") };
  },
  town(e, now) {
    const base = e.urgent ? 80 : e.tier === "alert" ? 55 : e.tier === "advisory" ? 20 : 0;
    const k = fade(e.at, now);
    return { pts: base * k, why: (e.urgent ? "urgent wording 80" : (e.tier || "notice") + " " + base) + (k === 1 ? "" : k ? ", halved after 6 hours" : ", over 24 hours old") };
  },
  quakeHome(e, now) {
    const near = num(e.km) != null && e.km <= 100;
    const base = stepTable(near ? QUAKE_NEAR : QUAKE_FAR, num(e.mag) || 0);
    const k = fade(e.at, now);
    return { pts: base * k, why: "magnitude " + e.mag + " at " + Math.round(e.km * 0.621) + " miles scores " + base + (k === 1 ? "" : k ? ", halved after 6 hours" : ", over 24 hours old") };
  },
  quakeUS(e, now) {
    const m = num(e.mag) || 0;
    let base = m >= 7 ? 60 : m >= 6 ? 25 : 0;
    if (e.alert === "red") base = 90; else if (e.alert === "orange") base = Math.max(base, 70); else if (e.alert === "yellow") base = Math.max(base, 40);
    const k = fade(e.at, now, 24, 72);
    return { pts: base * k, why: "magnitude " + e.mag + (e.alert ? ", USGS impact level " + e.alert : "") + " scores " + base + (k === 1 ? "" : k ? ", halved after a day" : ", over 3 days old") };
  },
  ntas(e, now, f) {
    const base = e.type === "imminent" ? 90 : e.type === "elevated" ? 60 : 20;
    const k = f.half && !e.nyc ? 0.5 : 1;
    return { pts: base * k, why: (e.type || "bulletin") + " " + base + (k < 1 ? ", halved because it doesn't name the New York area" : "") };
  },
  femaHome() { return { pts: 40, why: "a federal declaration covering your county scores 40" }; },
  context() { return { pts: 0, why: "context only" }; },
};
const EVENT_NOTES = {
  weather: "Scored by alert type: statement 5, advisory 15, watch 30, warning 55, high-end warning 80, emergency 95. The highest active alert counts.",
  town: "Community notices score 0, advisories 20, alerts 55, and 80 for wording like boil water, evacuate or shelter in place. A notice fades after 6 hours and drops off after 24.",
  quakeHome: "Scored by magnitude and distance from Morristown. Within 60 miles: 10 at magnitude 2.5, 30 at 3.5, 55 at 4.5, 85 at 5.5.",
  quakeUS: "Only US quakes count: 25 at magnitude 6, 60 at 7, more if USGS rates the impact orange or red.",
  ntas: "A bulletin scores 20, an Elevated alert 60, an Imminent alert 90.",
  femaHome: "Scores 40 while a federal declaration from the past 30 days covers Morris County or Manhattan.",
  context: "Shown for context. It doesn't add to the score.",
};
function eventCalc(f, now) {
  const rule = EVENT_RULES[f.rule] || EVENT_RULES.context;
  const ev = arr(f.events).map((e) => ({ e, ...rule(e, now, f) }));
  const top = ev.reduce((a, b) => (b.pts > (a ? a.pts : -1) ? b : a), null);
  const r = { sev: top ? top.pts : 0, lines: [], ev: ev.map((x) => Math.round(x.pts)), active: ev.filter((x) => x.pts > 0).length };
  if (top && top.pts > 0) r.lines.push("Highest: " + (top.e.event || top.e.title || "event") + ", " + top.why + ".");
  r.lines.push(EVENT_NOTES[f.rule] || EVENT_NOTES.context);
  return r;
}

/* ---- one rule per reading type ---- */
const RULED = { price: 1, level: 1, status: 1, trains: 1, lines: 1, events: 1 };
export function calc(f, now = Date.now()) {
  const k = f.kind;
  let r = { sev: 0, lines: [] };
  if (k === "price") r = priceCalc(f);
  else if (k === "events") r = eventCalc(f, now);
  else if (k === "trains") r = trainCalc(f);
  else if (k === "level") {
    const steps = arr(f.steps), n = steps.length || 5, st = clamp(Math.round(num(f.step) || 0), 0, n - 1);
    const sv = arr(f.sevs).length === n ? f.sevs : n === 5 ? [0, 15, 40, 70, 95] : steps.map((_, i) => Math.round((95 * i) / Math.max(1, n - 1)));
    r.sev = num(sv[st]) || 0;
    r.lines.push("Level " + (st + 1) + " of " + n + ". The levels score " + sv.join(", ") + ".");
  } else if (k === "status") {
    r.sev = STATE_SEV[f.state] || 0;
    r.lines.push("Status pages score 0 for OK, 20 for minor, 50 for major and 80 for critical.");
  } else if (k === "lines") {
    let d = 0, su = 0;
    arr(f.lines).forEach((l) => { if (l && l.s === "suspended") su++; else if (l && l.s === "delays") d++; });
    r.sev = Math.min(80, d * 10 + su * 35);
    r.lines.push("10 per line with delays, 35 per suspended line.");
  } else if (k === "count" && num(f.base)) {
    r.sev = clamp(((num(f.num) || 0) / f.base - 1.25) * 40, 0, 80);
    r.lines.push("Scored against its average of " + commas(f.base, 1) + ". Points start at 25% above average.");
  } else {
    r.sev = num(f.sev) || 0;
    r.lines.push(r.sev ? "Scored by a fixed value set in the fetcher." : "Scores 0 while nothing is active.");
  }
  if (!RULED[k] && !(k === "count" && num(f.base)) && num(f.sev) != null) r.sev = num(f.sev);
  r.sev = Math.round(clamp(r.sev || 0, 0, 100));
  return r;
}

/* ---- roll-up ---- */
// A domain takes its worst reading plus a fifth of the next two.
export function tileScore(sevs) {
  if (!sevs.length) return 0;
  const s = sevs.slice().sort((a, b) => b - a);
  let rest = 0;
  for (let i = 1; i < Math.min(s.length, 3); i++) rest += s[i];
  return Math.min(100, s[0] + 0.2 * rest);
}
// feeds: readings that already carry their computed score in _c.
export function dial(feeds, scope, now = Date.now()) {
  const mine = feeds.filter((f) => f.scope === scope);
  const liveFeeds = mine.filter((f) => live(f, now));
  const w = WEIGHTS[scope], parts = [];
  let keep = 1;
  TILES.forEach((t) => {
    const tf = liveFeeds.filter((f) => f.tile === t.id);
    if (!tf.length) return;
    const c = ((w[t.id] || 0) * tileScore(tf.map((f) => f._c.sev))) / 100;
    keep *= 1 - c;
    if (c >= 0.005) parts.push({ id: t.id, c });
  });
  // A domain's points: how far the score would fall if that domain alone went quiet.
  parts.forEach((p) => { p.pts = 100 * (1 - keep) - 100 * (1 - keep / Math.max(1 - p.c, 1e-9)); });
  parts.sort((a, b) => b.pts - a.pts);
  return {
    score: liveFeeds.length ? Math.round(100 * (1 - keep)) : null,
    parts,
    live: liveFeeds.length,
    old: liveFeeds.length - liveFeeds.filter((f) => fresh(f, now)).length,
    total: mine.length,
  };
}

/* ---- the two-part text shown on a row, also used for the log ---- */
export function rowText(f, c, now = Date.now()) {
  const k = f.kind;
  if (f.ok === false) return ["No reading", ""];
  if (!live(f, now)) return ["Expired", ""];
  if (k === "price") return [fmt(num(f.num), f.fmt), c.head == null ? "" : moveText(f, c.head) + " 1w"];
  if (k === "level") { const s = arr(f.steps); return [String(s[clamp(Math.round(num(f.step) || 0), 0, Math.max(0, s.length - 1))] || "Level " + f.step), String(f.short || "")]; }
  if (k === "status") return [STATE_WORD[f.state] || "Unknown", String(f.short || "")];
  if (k === "trains") {
    const all = trainList(f), bad = all.filter((t) => t.s === "late" || t.s === "cancelled");
    const first = arr(f.dirs)[0] && arr(f.dirs[0].trains)[0];
    return [first ? String(first.t) : "No trains", f.suspended ? "suspended" : bad.length ? bad.length + " of " + all.length + " disrupted" : f.lineDelay ? "line delays" : all.length ? "all on time" : ""];
  }
  if (k === "lines") {
    const hit = arr(f.lines).filter((l) => l && l.s && l.s !== "ok");
    return [hit.length ? hit.length + " affected" : "Clear", String(f.short || "")];
  }
  if (k === "events") return [c.active ? c.active + " active" : "Clear", String(f.short || "")];
  if (k === "count") return [commas(num(f.num) || 0, 0), String(f.short || "")];
  return [String(f.value || "–"), String(f.short || "")];
}
