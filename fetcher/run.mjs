// One pass of the monitor: run every adapter that is due, score the readings,
// record history and the log, and write the file the page reads.
//
// Files in out/:
//   latest.json   what the page reads
//   state.json    last good readings, per-adapter caches, history and log
//   runs.jsonl    one line per run, for checking reliability
//   archive/      one file per day: both dials and every reading's score at each run

import { mkdir, readFile, writeFile, appendFile, readdir, unlink } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { pathToFileURL } from "node:url";
import { get as httpGet } from "./lib/http.mjs";
import { etClock } from "./lib/util.mjs";
import { calc, dial, rowText, band, BANDS, live, tileName } from "../site/score.js";

import utilities from "./adapters/utilities.mjs";
import travel from "./adapters/travel.mjs";
import internet from "./adapters/internet.mjs";
import money from "./adapters/money.mjs";
import fuel from "./adapters/fuel.mjs";
import hazards from "./adapters/hazards.mjs";
import advisories from "./adapters/advisories.mjs";
import cyber from "./adapters/cyber.mjs";
import military from "./adapters/military.mjs";
import news from "./adapters/news.mjs";
import weather from "./adapters/weather.mjs";

export const ADAPTERS = [...utilities, ...travel, ...internet, ...money, ...fuel, ...hazards, ...advisories, ...military, ...cyber, ...news, ...weather];

const OUT = "out";
const CONCURRENCY = 6;
const ADAPTER_TIMEOUT = 60000;
const HISTORY_KEEP = 1100; // about a week at 10-minute steps
const HISTORY_SHOWN = 300; // about two days, sent to the page
const LOG_KEEP = 60;
const TRAIL_KEEP = 150; // a little over a day at 10-minute steps
const DROP_AFTER = 7 * 86400e3; // a reading that hasn't refreshed in a week is removed

// How a reading's move between bands is worded.
const change = (from, to, sev) => (to > from ? (from === 0 ? "now active" : "worsened") : sev < 1 ? "cleared" : "eased");

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label + " timed out")), ms); })]).finally(() => clearTimeout(timer));
}

async function pool(items, n, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (next < items.length) await fn(items[next++]); }));
}

export async function runOnce({ get = httpGet, now = Date.now(), state = {}, event = "local" } = {}) {
  state.feeds ??= {};
  state.ran ??= {};
  state.cache ??= {};
  state.errors ??= {};
  state.history ??= [];
  state.log ??= [];
  const firstRun = !Object.keys(state.feeds).length;
  const iso = new Date(now).toISOString();
  const started = Date.now();

  const due = ADAPTERS.filter((a) => state.errors[a.id] || !state.ran[a.id] || now - state.ran[a.id] >= (a.every - 3) * 60e3);
  await pool(due, CONCURRENCY, async (a) => {
    const cache = (state.cache[a.id] ??= {});
    const ctx = {
      get, now, cache,
      // Reuses a value for some minutes, and falls back to the old value if a refresh fails.
      async memo(key, minutes, fn) {
        const store = (cache.memo ??= {}), hit = store[key];
        if (hit && now - hit.t < minutes * 60e3) return hit.v;
        try {
          const v = await fn();
          store[key] = { t: now, v };
          return v;
        } catch (e) {
          if (hit) return hit.v;
          throw e;
        }
      },
    };
    try {
      const result = await withTimeout(a.run(ctx), ADAPTER_TIMEOUT, a.id);
      for (const doc of Array.isArray(result) ? result : [{ id: a.id, ...result }]) {
        state.feeds[doc.id] = { ...doc, checkedAt: iso, ok: true };
      }
      state.ran[a.id] = now;
      delete state.errors[a.id];
    } catch (e) {
      state.errors[a.id] = { msg: String(e.message ?? e).slice(0, 240), since: state.errors[a.id]?.since ?? iso, at: iso };
    }
  });

  for (const [id, f] of Object.entries(state.feeds)) if (now - Date.parse(f.checkedAt) > DROP_AFTER) delete state.feeds[id];

  // Headlines ride along with the readings but are context only: never scored, logged or charted.
  const readings = Object.values(state.feeds).filter((f) => f.kind !== "news" && f.kind !== "weather");
  // Score every reading with the same rules the page uses.
  const feeds = readings.map((f) => ({ ...f, _c: calc(f, now) }));
  const dials = { national: dial(feeds, "national", now), home: dial(feeds, "home", now) };
  const scores = { national: dials.national.score, home: dials.home.score };

  // Entries written before the wording changed are reworded once, so the card reads the same throughout.
  if (state.logV !== 2) {
    for (const x of state.log) {
      const m = x.text.match(/^(.*?): (.*)\. Signal ([\d.]+), was ([\d.]+)\.?$/);
      const d = x.text.match(/^(USA|Home) moved to (\w+)(?: at \d+)?, from \w+(?: at \d+)?\.?$/);
      if (m) x.text = `${m[1]} ${change(band(Number(m[4])), band(Number(m[3])), Number(m[3]))}: ${m[2]}`;
      else if (d) x.text = `${d[1]} ${x.dir === "down" ? "eased" : "rose"} to ${d[2]}`;
    }
    state.logV = 2;
  }
  // One-time tidy after the Money rescoring: gold, Bitcoin and the 10-year yield no longer score, so their old lines go.
  if (state.logV === 2) {
    const context = new Set(["bitcoin", "gold", "ust10"]);
    state.log = state.log.filter((x) => !context.has(x.id));
    state.logV = 3;
  }

  // What changed: one line whenever a reading or a dial crosses into a different band,
  // worded as what happened. The numbers behind it are in each reading's detail.
  const prev = state.prev ?? {};
  const seen = {};
  const entries = [];
  for (const f of feeds) {
    if (!live(f, now)) continue;
    const b = band(f._c.sev);
    seen[f.id] = { b, sev: f._c.sev };
    const was = prev[f.id];
    if (!was || was.b === b) continue;
    const text = rowText(f, f._c, now).filter(Boolean).join(", ");
    entries.push({ t: iso, id: f.id, dir: b > was.b ? "up" : "down", text: `${f.label} ${change(was.b, b, f._c.sev)}: ${text}` });
  }
  for (const [scope, label] of [["national", "USA"], ["home", "Home"]]) {
    const s = scores[scope];
    if (s == null) continue;
    const b = band(s);
    seen["dial:" + scope] = { b, sev: s };
    const was = prev["dial:" + scope];
    if (!was || was.b === b) continue;
    // A rise names the domain doing the most, and the reading inside it that leads.
    const part = dials[scope].parts[0];
    const lead = part && feeds.filter((f) => f.scope === scope && f.tile === part.id && live(f, now)).sort((x, y) => y._c.sev - x._c.sev)[0];
    const why = b > was.b && part ? `, led by ${tileName(part.id)}${lead && lead._c.sev > 0 ? ` (${lead.label})` : ""}` : "";
    entries.push({ t: iso, id: "dial:" + scope, dir: b > was.b ? "up" : "down", text: `${label} ${b > was.b ? "rose" : "eased"} to ${BANDS[b]}${why}` });
  }
  if (firstRun) entries.push({ t: iso, id: "start", dir: "", text: `Monitoring started at ${etClock(now)} ET with ${feeds.length} readings.` });
  state.prev = seen;
  state.log = [...entries.sort((a, b) => (a.id.startsWith("dial") ? -1 : 0) - (b.id.startsWith("dial") ? -1 : 0)), ...state.log].slice(0, LOG_KEEP);

  // Each reading's score over the past day, one value per run, lined up with trailT.
  state.trailT ??= [];
  state.trails ??= {};
  const runs = state.trailT.length;
  state.trailT.push(Math.round(now / 60000));
  for (const f of feeds) (state.trails[f.id] ??= new Array(runs).fill(null));
  for (const [id, list] of Object.entries(state.trails)) {
    const f = feeds.find((x) => x.id === id);
    list.push(f && live(f, now) ? f._c.sev : null);
    if (!f) delete state.trails[id];
  }
  if (state.trailT.length > TRAIL_KEEP) {
    state.trailT = state.trailT.slice(-TRAIL_KEEP);
    for (const id of Object.keys(state.trails)) state.trails[id] = state.trails[id].slice(-TRAIL_KEEP);
  }

  state.history.push({ t: iso, national: scores.national, home: scores.home });
  state.history = state.history.slice(-HISTORY_KEEP);

  const errors = Object.entries(state.errors).map(([id, e]) => ({ id, ...e }));
  const latest = {
    scannedAt: iso,
    scores,
    feeds: readings,
    news: state.feeds.news ?? null,
    weather: state.feeds.weather ?? null,
    history: state.history.slice(-HISTORY_SHOWN),
    log: state.log,
    trailT: state.trailT,
    trails: state.trails,
    errors,
  };
  const summary = { t: iso, event, ms: Date.now() - started, ran: due.length, adapters: ADAPTERS.length, readings: feeds.length, ...scores, failed: errors.map((e) => e.id) };
  // One compact line per run for the long-term archive: both dials, every non-zero
  // reading score, and the raw numbers behind each reading that was refreshed this run.
  // Most sources only publish the present moment, so this is the only record of what normal looks like.
  const raw = (f) => f.track ?? (f.kind === "price" ? { v: f.num } : f.kind === "events" ? { n: (f.events ?? []).length } : f.kind === "count" ? { n: f.num } : null);
  const archive = {
    t: iso, n: scores.national, h: scores.home, live: feeds.filter((f) => live(f, now)).length,
    s: Object.fromEntries(feeds.filter((f) => live(f, now) && f._c.sev > 0).map((f) => [f.id, f._c.sev])),
    v: Object.fromEntries(feeds.filter((f) => f.checkedAt === iso && raw(f)).map((f) => [f.id, raw(f)])),
  };
  return { latest, state, summary, archive };
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return fallback;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await mkdir(OUT, { recursive: true });
  const state = await readJson(`${OUT}/state.json`, {});
  const { latest, summary, archive } = await runOnce({ state, event: process.env.GITHUB_EVENT_NAME ?? "local" });
  await writeFile(`${OUT}/latest.json`, JSON.stringify(latest));
  await writeFile(`${OUT}/state.json`, JSON.stringify(state));
  await appendFile(`${OUT}/runs.jsonl`, JSON.stringify(summary) + "\n");

  // Archive: one file per day, compressed once the day is over.
  const today = archive.t.slice(0, 10);
  await mkdir(`${OUT}/archive`, { recursive: true });
  await appendFile(`${OUT}/archive/${today}.jsonl`, JSON.stringify(archive) + "\n");
  for (const name of await readdir(`${OUT}/archive`)) {
    if (!name.endsWith(".jsonl") || name.slice(0, 10) >= today) continue;
    await writeFile(`${OUT}/archive/${name}.gz`, gzipSync(await readFile(`${OUT}/archive/${name}`)));
    await unlink(`${OUT}/archive/${name}`);
  }
  console.log(`${summary.readings} readings from ${summary.ran} of ${summary.adapters} adapters in ${summary.ms} ms. USA ${summary.national}, Home ${summary.home}.`);
  for (const e of latest.errors) console.log(`FAILED ${e.id}: ${e.msg} (since ${e.since})`);
}
