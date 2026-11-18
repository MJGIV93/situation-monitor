import { json, need, fetchOk, strip, clip, commas, short, pct, etDay, etWeekdayClock } from "../lib/util.mjs";

const SHARE_STEPS = ["Normal", "Scattered", "Elevated", "Major", "Severe"];
const SHARE_LADDER = ["under 0.1% out", "0.1% to 0.5%", "0.5% to 2%", "2% to 10%", "over 10%"];
const shareStep = (p) => (p >= 10 ? 4 : p >= 2 ? 3 : p >= 0.5 ? 2 : p >= 0.1 ? 1 : 0);

// Kubra hosts both utilities' outage maps. The data folder changes every few
// minutes, and each map publishes several summary files for different areas,
// so the one matching the utility's whole customer base is picked by size.
function kubra({ id, name, label, rowLabel, order, note, stormcenter, view, customers, source, w, wWhy }) {
  return {
    id,
    every: 10,
    async run(ctx) {
      const state = json(await fetchOk(ctx, `https://kubra.io/stormcenter/api/v1/stormcenters/${stormcenter}/views/${view}/currentState?preview=false`));
      const path = state?.data?.interval_generation_data;
      need(path, "no data path");
      const order = [ctx.cache.summary, 1, 2, 3, 4, 5, 6].filter((n, i, a) => n && a.indexOf(n) === i);
      let best = null;
      for (const n of order) {
        const res = await ctx.get(`https://kubra.io/${path}/public/summary-${n}/data.json`);
        if (!res.ok) continue;
        const data = json(res.text).summaryFileData;
        for (const t of data?.totals ?? []) {
          const miss = Math.abs(t.total_cust_s - customers) / customers;
          if (!best || miss < best.miss) best = { n, miss, t, at: data.date_generated };
        }
        if (best && best.miss < 0.1) break;
      }
      need(best, "no summary file");
      ctx.cache.summary = best.n;
      const out = best.t.total_cust_a?.val ?? 0, served = best.t.total_cust_s, share = (out / served) * 100;
      return {
        name, label, rowLabel, order, tile: "power", scope: "home", kind: "level", note, source, w, wWhy,
        // A whole utility's territory is background. Scattered outages there are an ordinary day.
        steps: SHARE_STEPS, ladder: SHARE_LADDER, sevs: [0, 3, 10, 45, 80], step: shareStep(share),
        short: `${short(out)} out`,
        detail: `${commas(out)} of ${commas(served)} customers without power${share >= 0.01 ? `, or ${pct(share)}` : ""}, across ${commas(best.t.total_outages ?? 0)} outage${best.t.total_outages === 1 ? "" : "s"}.`,
        dataAt: best.at,
        track: { out, served, outages: best.t.total_outages ?? 0 },
      };
    },
  };
}

// The same map publishes a report with a row for every municipality.
const TOWN_STEPS = ["Normal", "Scattered", "Neighborhood", "Widespread", "Town-wide"];
const TOWN_LADDER = ["under 0.1% out", "0.1% to 1%", "1% to 5%", "5% to 25%", "over 25%"];
function kubraTowns({ id, name, label, rowLabel, order, note, stormcenter, view, county, towns, source }) {
  const api = `https://kubra.io/stormcenter/api/v1/stormcenters/${stormcenter}/views/${view}`;
  return {
    id,
    every: 10,
    async run(ctx) {
      const state = json(await fetchOk(ctx, `${api}/currentState?preview=false`));
      const path = state?.data?.interval_generation_data;
      need(path, "no data path");
      // The report's file name is in the map's configuration, which rarely changes.
      const file = await ctx.memo("report-" + state.stormcenterDeploymentId, 1440, async () => {
        const config = json(await fetchOk(ctx, `${api}/configuration/${state.stormcenterDeploymentId}?preview=false`));
        const found = config?.config?.reports?.data?.interval_generation_data?.[0]?.source;
        need(found, "no report in the map configuration");
        return found;
      });
      const report = json(await fetchOk(ctx, `https://kubra.io/${path}/${file}`));
      const rows = [];
      const walk = (a) => { if (a?.key === "Township" && a.county === county && towns[a.name]) rows.push(a); (a?.areas ?? []).forEach(walk); };
      (report?.file_data?.areas ?? []).forEach(walk);
      need(rows.length === Object.keys(towns).length, "town rows not found in the outage report");
      rows.sort((a, b) => Object.keys(towns).indexOf(a.name) - Object.keys(towns).indexOf(b.name));
      // Counts under a threshold are masked: val 19 with mask 20 means fewer than 20.
      const masked = rows.some((r) => r.cust_a?.mask && r.cust_a.val > 0);
      const out = rows.reduce((a, r) => a + (r.cust_a?.val ?? 0), 0), served = rows.reduce((a, r) => a + (r.cust_s ?? 0), 0);
      const outages = rows.reduce((a, r) => a + (r.n_out ?? 0), 0), share = (out / served) * 100;
      const etr = rows.map((r) => Date.parse(r.etr)).filter((t) => t > ctx.now).sort((a, b) => b - a)[0];
      const say = (r) => `${towns[r.name]}: ${r.cust_a?.mask && r.cust_a.val > 0 ? "fewer than " + r.cust_a.mask : commas(r.cust_a?.val ?? 0)} of ${commas(r.cust_s)} out`;
      return {
        name, label, rowLabel, order, tile: "power", scope: "home", kind: "level", note, source,
        // Power in your own town is the reading that matters most here, so it climbs fastest.
        steps: TOWN_STEPS, ladder: TOWN_LADDER, sevs: [0, 8, 25, 55, 85],
        step: share >= 25 ? 4 : share >= 5 ? 3 : share >= 1 ? 2 : share >= 0.1 ? 1 : 0,
        short: out ? `${masked && out < 40 ? "under " + (Math.ceil((out + 1) / 20) * 20) : commas(out)} out` : "none out",
        detail: rows.map(say).join(". ") + "." + (etr ? ` JCP&L estimates power back by ${etWeekdayClock(etr)}.` : ""),
        track: { out, served, outages },
      };
    },
  };
}

const ODIN = "https://ornl.opendatasoft.com/api/explore/v2.1/catalog/datasets/odin-real-time-outages-county/records";
async function odinByState(ctx) {
  const grouped = await ctx.get(`${ODIN}?select=state%2C%20sum(metersaffected)%20as%20out&group_by=state&order_by=out%20desc&limit=100`);
  if (grouped.ok) {
    const rows = json(grouped.text).results ?? [];
    if (rows.length && rows[0].out != null) return rows.map((r) => ({ state: r.state, out: Number(r.out) || 0 }));
  }
  // Fallback: page through the county rows and add them up here.
  const by = new Map();
  for (let offset = 0; offset < 4000; offset += 100) {
    const page = json(await fetchOk(ctx, `${ODIN}?select=state%2Cmetersaffected&limit=100&offset=${offset}`)).results ?? [];
    for (const r of page) by.set(r.state, (by.get(r.state) ?? 0) + (Number(r.metersaffected) || 0));
    if (page.length < 100) break;
  }
  return [...by].map(([state, out]) => ({ state, out })).sort((a, b) => b.out - a.out);
}

const NJ_ZONES = /PJM-RTO|MIDATL|MID-ATL|FE-JC|JCPL|PSEG|\bPS\b/i;
const GRID_WIDE = /PJM-RTO|MIDATL|MID-ATL/i;
const EMERGENCY = /Emergency|Load Shed|Load Dump|Voltage Reduction Action|Deploy All|Maximum Generation.*Action|EEA ?[23]/i;
const GRID_ALERT = /Conservative Operations|Voltage Reduction (Alert|Warning)|Reserve|Geomagnetic|Maximum Generation|EEA ?1|Load Management/i;

export default [
  {
    id: "odin",
    every: 10,
    async run(ctx) {
      const states = (await odinByState(ctx)).filter((s) => s.out > 0);
      const total = states.reduce((a, s) => a + s.out, 0);
      const top = states.slice(0, 2).map((s) => `${s.state} ${commas(s.out)}`);
      return {
        name: "Power outages, nationwide (DOE ODIN)", label: "US power outages", rowLabel: ["Power outages", "nationwide"], tile: "power", scope: "national", kind: "level",
        note: "Energy Department data from utilities that choose to report, so it undercounts.",
        source: "https://ornl.opendatasoft.com/explore/dataset/odin-real-time-outages-county/",
        steps: ["Normal", "Raised", "Elevated", "Major", "Severe"],
        ladder: ["under 250k out", "250k to 1M", "1M to 3M", "3M to 10M", "over 10M"],
        step: total >= 10e6 ? 4 : total >= 3e6 ? 3 : total >= 1e6 ? 2 : total >= 250e3 ? 1 : 0,
        short: `${short(total)} out`,
        detail: `${commas(total)} customers out across ${states.length} reporting states.` + (top.length ? ` Largest: ${top.join(" and ")}.` : ""),
        track: { out: total, states: states.length },
      };
    },
  },
  kubra({
    id: "jcpl", name: "Power outages, all of JCP&L", label: "JCP&L territory", rowLabel: ["Power, JCP&L", "all of its NJ area"], order: 3,
    note: "All of JCP&L's New Jersey territory, from its own outage map. Scattered outages somewhere in it are an ordinary day, so this only counts when a large share is out.",
    stormcenter: "6c715f0e-bbec-465f-98cc-0b81623744be", view: "fcd7c23d-de37-4471-8ca3-37c3260f94fa", customers: 1161627,
    source: "https://outages-nj.firstenergycorp.com/",
  }),
  kubraTowns({
    id: "jcpl-town", name: "Power outages in Morristown and Morris Township", label: "Power in town", rowLabel: ["Power in town", "JCP&L, Morristown"], order: 2,
    note: "Customers without power in Morristown and Morris Township together, from the town rows of JCP&L's outage map. JCP&L hides exact counts under 20.",
    stormcenter: "6c715f0e-bbec-465f-98cc-0b81623744be", view: "fcd7c23d-de37-4471-8ca3-37c3260f94fa",
    county: "MORRIS", towns: { "MORRISTOWN TOWN": "Morristown", "MORRIS TOWNSHIP": "Morris Township" },
    source: "https://outages-nj.firstenergycorp.com/",
  }),
  kubra({
    id: "pseg", name: "Power outages, all of PSE&G", label: "PSE&G territory", rowLabel: ["Power, PSE&G", "neighboring utility"], order: 5, note: "PSE&G's electric map. Gas outages aren't published.",
    w: 0.4, wWhy: "PSE&G supplies your gas, not your power, so its electric outages only matter as a sign of a regional storm",
    stormcenter: "79d82478-c10a-4956-a045-89de3cda618c", view: "bdb7f5be-1c1a-46fa-862e-ebdf21851d2e", customers: 2336556,
    source: "https://outagecenter.pseg.com/external/default.html",
  }),
  {
    id: "pjm",
    every: 10,
    async run(ctx) {
      const html = await fetchOk(ctx, "https://emergencyprocedures.pjm.com/ep/pages/dashboard.jsf");
      need(/Emergency Procedures/i.test(html), "not the PJM dashboard");
      const posts = html.split(/<tr data-ri="\d+" data-rk="/).slice(1).map((s) => {
        const cell = (re) => strip(s.match(re)?.[1] ?? "");
        return {
          id: s.slice(0, s.indexOf('"')),
          priority: cell(/txtPriority">([^<]*)</),
          type: cell(/lnkMessageDef"[^>]*>([\s\S]*?)<\/a>/),
          start: cell(/txtEffectiveStartTime">([^<]*)</),
          regions: cell(/txtEffectiveStartTime">[^<]*<\/span><\/td><td[^>]*>([\s\S]*?)<\/td>/),
          text: cell(/txtMessage"[^>]*>([\s\S]*?)<\/span>/),
        };
      });
      const drill = (p) => /^DRILL/i.test(p.type) || /\bdrill\b/i.test(p.text.slice(-200));
      const real = posts.filter((p) => !drill(p));
      const nj = real.filter((p) => NJ_ZONES.test(p.regions) && /Alert|Warning|Action/i.test(p.priority));
      let step = 0;
      if (nj.some((p) => /Action/i.test(p.priority) || EMERGENCY.test(p.type))) step = 3;
      else if (nj.some((p) => GRID_WIDE.test(p.regions) && GRID_ALERT.test(p.type))) step = 2;
      else if (nj.length) step = 1;
      const drills = posts.length - real.length;
      const elsewhere = real.filter((p) => !NJ_ZONES.test(p.regions));
      const info = real.length - nj.length - elsewhere.length;
      return {
        name: "Regional grid, PJM emergency postings", label: "Regional grid", rowLabel: ["Regional grid", "PJM postings"], order: 4, tile: "power", scope: "home", kind: "level",
        note: "PJM runs the grid for New Jersey and 12 other states. Drills are ignored. Routine alerts barely count; an emergency action that reaches New Jersey does.",
        source: "https://emergencyprocedures.pjm.com/ep/pages/dashboard.jsf",
        steps: ["Normal", "Local warnings", "Alert", "Emergency"], sevs: [0, 3, 15, 85],
        ladder: ["nothing that counts for NJ", "warnings in JCP&L or PSE&G zones", "grid-wide alert", "emergency action or load shed"],
        step,
        short: nj.length ? `${nj.length} for NJ` : "nothing for NJ",
        detail: `${posts.length} active posting${posts.length === 1 ? "" : "s"}: ${nj.length} that count for New Jersey, ${info} for New Jersey that are informational only, ${elsewhere.length} elsewhere and ${drills} drill${drills === 1 ? "" : "s"}.`,
        items: nj.slice(0, 4).map((p) => `${p.priority}: ${p.type} (${p.regions})`),
        track: { step, posts: posts.length, nj: nj.length, drills },
      };
    },
  },
  {
    id: "smcmua",
    every: 10,
    async run(ctx) {
      // Notices are listed on the utility's alerts page, each linking to its own page.
      // The site is heavily cached, so every request carries a throwaway query to get the current copy.
      const base = "https://www.smcmua.org/", fresh = "?t=" + Math.floor(ctx.now / 60000);
      const html = await fetchOk(ctx, base + "alerts.htm" + fresh);
      need(/ALERTS/i.test(html), "not the SMCMUA alerts page");
      const seen = (ctx.cache.seen ??= {});
      for (const [, href, inner] of html.matchAll(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
        const m = strip(inner).match(/^(.*?)\s*\((\d{1,2})\/(\d{1,2})\/(\d{2,4})\)\s*$/);
        if (!m || !/repair|break|boil|emergency|interruption|advisory|outage/i.test(m[1])) continue;
        const year = Number(m[4]) < 100 ? 2000 + Number(m[4]) : Number(m[4]);
        seen[new URL(href, base).href] ??= { title: m[1], at: Date.UTC(year, m[2] - 1, m[3], 17) };
      }
      for (const [url, n] of Object.entries(seen)) if (ctx.now - n.at > 5 * 86400e3) delete seen[url];

      // Open each notice from the past two days to see whether the work is still under way.
      const recent = Object.entries(seen).filter(([, n]) => ctx.now - n.at < 2.5 * 86400e3).sort((x, y) => y[1].at - x[1].at).slice(0, 8);
      for (const [url, n] of recent) {
        const res = await ctx.get(url + fresh);
        if (!res.ok) continue;
        const text = strip(res.text);
        n.status = /boil[- ]water advisory/i.test(text) && !/no boil[- ]water advisory/i.test(text) ? "boil" : /in progress/i.test(text) ? "active" : /complete|restored/i.test(text) ? "done" : "posted";
        // A finished notice is reworded and drops the address, so the one already read is kept.
        n.where = clip(text.match(/at or near ([^.]{3,90})\./i)?.[1] ?? "", 80) || n.where || "";
        // The notice's address is public. Its coordinates let each viewer's browser judge how close the work is.
        if (n.where && !n.pt && (n.tries ?? 0) < 3 && (n.status === "active" || n.status === "boil")) {
          n.tries = (n.tries ?? 0) + 1;
          const geo = await ctx.get("https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?benchmark=Public_AR_Current&format=json&address=" + encodeURIComponent(n.where.replace(/\s+in\s+/i, ", ") + ", NJ"));
          let at = null;
          try { at = geo.ok ? json(geo.text).result?.addressMatches?.[0]?.coordinates : null; } catch { at = null; }
          if (at && Math.abs(at.y - 40.8) < 0.5 && Math.abs(at.x + 74.5) < 0.5) n.pt = [Math.round(at.y * 1e4) / 1e4, Math.round(at.x * 1e4) / 1e4];
        }
      }
      const local = (n) => /Morristown|Morris Township|Morris Twp/i.test(`${n.title} ${n.where ?? ""}`);
      const open = recent.map(([, n]) => n).filter((n) => n.status === "active" || n.status === "boil");
      const boil = open.some((n) => n.status === "boil"), nearMe = open.filter(local);
      const say = (n) => `${n.status === "boil" ? "Boil water" : n.status === "active" ? "In progress" : n.status === "done" ? "Completed" : "Posted"}: ${n.where || n.title.replace(/^Water Repairs in /i, "")} (${etDay(n.at)})`;
      const isOpen = (n) => n.status === "active" || n.status === "boil";
      const street = (n) => clip((n.where || n.title.replace(/^Water Repairs in /i, "")).replace(/\s+in\s+.*$/i, ""), 22);
      return {
        name: "Water notices, SMCMUA", label: "Water", rowLabel: ["Water", "SMCMUA notices"], order: 1, tile: "power", scope: "home", kind: "level",
        // "Across town" and "Near you" are only ever set in the browser, from a location saved on that device.
        steps: ["No notice", "Other towns", "Across town", "In town", "Near you", "Boil water"], sevs: [0, 2, 10, 25, 40, 80],
        // Three segments: something nearby, something in town, a boil-water advisory.
        meter: { of: 3, at: [0, 1, 1, 2, 2, 3] },
        ladder: ["nothing under way", "work in a neighboring town", "work in town, over 2 miles from you", "work in Morristown or Morris Township", "work within three-quarters of a mile of you", "boil-water advisory"],
        step: boil ? 5 : nearMe.length ? 3 : open.length ? 1 : 0,
        places: open.map((n) => ({ name: n.where || n.title.replace(/^Water Repairs in /i, ""), lat: n.pt?.[0], lon: n.pt?.[1], local: local(n) })),
        byDistance: { near: 0.75, far: 2, nearStep: 4, farStep: 2, townStep: 3, elseStep: 1, top: 5 },
        short: nearMe.length === 1 ? street(nearMe[0]) : nearMe.length ? `${nearMe.length} repairs in town` : open.length ? `${open.length} in other towns` : "none active",
        detail: nearMe.length ? "A repair in town usually affects the streets around it for a few hours. Save your location at the bottom of the page and this is judged by distance instead of by town." : "",
        // Work still under way is listed first.
        items: recent.map(([, n]) => n).sort((a, b) => isOpen(b) - isOpen(a) || b.at - a.at).map(say).slice(0, 6),
        note: "From the utility's alerts page and each notice it links to. Checked every 10 minutes.",
        source: "https://www.smcmua.org/alerts.htm",
        track: { open: open.length, local: nearMe.length, boil: boil ? 1 : 0 },
      };
    },
  },
];
