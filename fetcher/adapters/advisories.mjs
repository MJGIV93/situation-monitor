import { json, need, fetchOk, strip, clip, etDay, agoText } from "../lib/util.mjs";

const title = (s) => String(s ?? "").toLowerCase().replace(/(^|[\s-])\w/g, (c) => c.toUpperCase());
const FEMA_TYPE = { DR: "Major disaster", EM: "Emergency", FM: "Fire" };

// "5 days, 11 hours ago" -> milliseconds
function relativeMs(text) {
  const unit = { minute: 60e3, hour: 3600e3, day: 86400e3, week: 7 * 86400e3, month: 30 * 86400e3, year: 365 * 86400e3 };
  let ms = 0;
  for (const m of text.matchAll(/(\d+)\s*(minute|hour|day|week|month|year)/gi)) ms += Number(m[1]) * unit[m[2].toLowerCase()];
  return ms;
}
const URGENT = /boil[- ]water|do not drink|do not use water|evacuat|shelter in place|gas leak|active shooter|hazmat|state of emergency/i;

async function fema(ctx) {
  return ctx.memo("fema", 60, async () => {
    const from = new Date(ctx.now - 30 * 86400e3).toISOString().slice(0, 10);
    const j = json(await fetchOk(ctx, `https://www.fema.gov/api/open/v2/DisasterDeclarationsSummaries?$filter=declarationDate%20ge%20%27${from}T00:00:00.000z%27&$orderby=declarationDate%20desc&$top=1000`));
    need(Array.isArray(j.DisasterDeclarationsSummaries), "no declarations list");
    const by = new Map();
    for (const d of j.DisasterDeclarationsSummaries) {
      const k = d.femaDeclarationString;
      if (!by.has(k)) by.set(k, { id: k, state: d.state, type: d.declarationType, title: title(d.declarationTitle), date: d.declarationDate, areas: [] });
      by.get(k).areas.push(d.designatedArea ?? "");
    }
    return [...by.values()];
  });
}
const femaEvent = (d) => ({ event: `${FEMA_TYPE[d.type] ?? d.type}: ${d.title}, ${d.state}`, at: d.date, text: etDay(Date.parse(d.date)) });

async function ntas(ctx) {
  return ctx.memo("ntas", 20, async () => {
    const xml = await fetchOk(ctx, "https://www.dhs.gov/ntas/1.1/alerts.xml");
    need(/<alerts/i.test(xml), "not the NTAS feed");
    return [...xml.matchAll(/<alert\b([^>]*)>([\s\S]*?)<\/alert>/gi)].map(([, attrs, body]) => {
      const all = attrs + " " + body, summary = strip(body.match(/<summary>([\s\S]*?)<\/summary>/i)?.[1] ?? body);
      const type = /imminent/i.test(attrs) ? "imminent" : /elevated/i.test(attrs) ? "elevated" : "bulletin";
      return { event: `${type[0].toUpperCase() + type.slice(1)}: ${clip(summary, 120)}`, type, nyc: /New York|New Jersey|NYC/i.test(all) || undefined, ends: attrs.match(/end="([^"]*)"/i)?.[1] };
    });
  });
}

export default [
  {
    id: "fema",
    every: 60,
    async run(ctx) {
      const all = await fema(ctx);
      const recent = all;
      const local = all.filter((d) => (d.state === "NJ" && d.areas.some((a) => /Morris|Statewide/i.test(a))) || (d.state === "NY" && d.areas.some((a) => /New York \(County\)|Statewide/i.test(a))));
      const source = "https://www.fema.gov/disaster/declarations";
      return [
        {
          id: "fema", name: "FEMA disaster declarations", label: "FEMA, national", tile: "gov", scope: "national", kind: "events", rule: "context",
          events: recent.map(femaEvent), short: `${recent.length} in 30 days`,
          note: "Federal declarations usually come days after the event, so this confirms more than it warns.", source,
        },
        {
          id: "fema-home", name: "FEMA declarations covering Morris County or Manhattan", label: "FEMA, local", tile: "gov", scope: "home", kind: "events", rule: "femaHome",
          events: local.map(femaEvent), short: local.length ? "declared" : "none in 30 days",
          note: "Declarations from the past 30 days that name Morris County, Manhattan, or either state as a whole.", source,
        },
      ];
    },
  },
  {
    id: "ntas",
    every: 20,
    async run(ctx) {
      const events = await ntas(ctx);
      const base = { tile: "gov", kind: "events", rule: "ntas", events, short: events.length ? events[0].type : "none active", source: "https://www.dhs.gov/national-terrorism-advisory-system" };
      return [
        { ...base, id: "ntas", name: "DHS terrorism advisories", label: "DHS advisories", scope: "national", note: "National Terrorism Advisory System." },
        { ...base, id: "ntas-home", name: "DHS terrorism advisories, New York area", label: "DHS advisories", scope: "home", half: true, note: "The same national feed. It counts at half strength here unless the alert names the New York area." },
      ];
    },
  },
  {
    id: "nrc",
    every: 60,
    async run(ctx) {
      const html = await fetchOk(ctx, "https://www.nrc.gov/reading-rm/doc-collections/event-status/reactor-status/ps.html");
      const units = [...html.matchAll(/<tr[^>]*>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => [strip(m[1]), Number(strip(m[2]))]).filter(([u, p]) => u && isFinite(p) && !/^Unit$/i.test(u));
      need(units.length > 60, "reactor table not found");
      const full = units.filter(([, p]) => p >= 100).length, off = units.filter(([, p]) => p === 0);
      let classes = [];
      const ev = await ctx.get("https://www.nrc.gov/reading-rm/doc-collections/event-status/event/en.html");
      if (ev.ok) classes = [...strip(ev.text).matchAll(/Emergency Class:\s*(.+?)\s*10 CFR Section/gi)].map((m) => m[1].trim());
      const worst = classes.some((c) => /General|Site Area/i.test(c)) ? "critical" : classes.some((c) => /^Alert/i.test(c)) ? "major" : classes.some((c) => /Unusual/i.test(c)) ? "minor" : "ok";
      const nearby = units.filter(([u]) => /^(Salem|Hope Creek|Limerick)/i.test(u)).map(([u, p]) => `${u} ${p}%`);
      const declared = classes.filter((c) => !/Non Emergency/i.test(c));
      return {
        name: "NRC nuclear plant status", label: "Nuclear plants", tile: "gov", scope: "national", kind: "status",
        state: worst,
        short: `${full} of ${units.length} full`,
        track: { full, offline: off.length, reports: classes.length, declared: declared.length },
        note: `${off.length} reactors offline. ${classes.length} event reports today, ${declared.length ? declared.length + " with a declared emergency class (" + [...new Set(declared)].join(", ") + ")" : "none declaring an emergency"}. Nearest plants: ${nearby.join(", ")}.`,
        source: "https://www.nrc.gov/reading-rm/doc-collections/event-status/reactor-status/ps.html",
      };
    },
  },
  {
    id: "nixle-morristown",
    every: 10,
    async run(ctx) {
      // One page per municipality. Morris Township is listed by Nixle as "Morris".
      const pages = [["Morristown", "https://nixle.us/city/nj/morristown/"], ["Morris Township", "https://nixle.us/city/nj/morris/"]];
      const posts = [], missing = [];
      for (const [place, url] of pages) {
        const res = await ctx.get(url);
        if (!res.ok || !/id="wire"/.test(res.text)) { missing.push(place); continue; }
        for (const s of res.text.split(/<li id="pub_/).slice(1)) {
          const tier = (s.match(/class="priority (\w+)"/)?.[1] ?? "advisory").toLowerCase();
          const agency = strip(s.match(/<h2 class="certified">([\s\S]*?)<\/h2>/)?.[1] ?? "").replace(/\s+(NJ\s+)?Police Department$/i, "") || place;
          const entered = strip(s.match(/<p class="time">([\s\S]*?)<\/p>/)?.[1] ?? "");
          const text = strip((s.match(/<p class="time">[\s\S]*?<\/p>\s*<p>([\s\S]*?)<\/p>/)?.[1] ?? "").replace(/<a[\s\S]*?<\/a>/g, ""));
          const ago = relativeMs(entered);
          if (text) posts.push({ event: clip(`${agency}: ${text}`, 170), tier, at: new Date(ctx.now - ago).toISOString(), text: agoText(ago), urgent: URGENT.test(text) || undefined, ago });
        }
      }
      need(missing.length < pages.length, "neither Nixle page answered");
      posts.sort((x, y) => x.ago - y.ago);
      const last = posts[0];
      return {
        name: "Morristown and Morris Township alerts (Nixle)", label: "Town alerts", tile: "gov", scope: "home", kind: "events", rule: "town",
        events: posts.slice(0, 6).map(({ ago, ...p }) => p),
        short: last ? "last " + agoText(last.ago) : "none posted",
        note: "The public pages behind the text alerts from Morristown Police and Morris Township Police. Both also relay SMCMUA water notices." + (missing.length ? ` The ${missing[0]} page didn't answer on the last check.` : ""),
        source: "https://nixle.us/city/nj/morris/",
      };
    },
  },
];
