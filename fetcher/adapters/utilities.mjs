import { json, need, fetchOk, strip, clip, commas, short, pct, etDay } from "../lib/util.mjs";

// Notices sent by text that the utility hasn't added to its alerts page yet.
const UNLISTED = [
  { url: "https://www.smcmua.org/WaterRepairs_208LakeRd_MorrisTwp.htm", title: "Water Repairs in Morris Township - Lake Road", at: Date.parse("2026-11-18T02:04:44Z") },
];

const SHARE_STEPS = ["Normal", "Scattered", "Elevated", "Major", "Severe"];
const SHARE_LADDER = ["under 0.1% out", "0.1% to 0.5%", "0.5% to 2%", "2% to 10%", "over 10%"];
const shareStep = (p) => (p >= 10 ? 4 : p >= 2 ? 3 : p >= 0.5 ? 2 : p >= 0.1 ? 1 : 0);

// Kubra hosts both utilities' outage maps. The data folder changes every few
// minutes, and each map publishes several summary files for different areas,
// so the one matching the utility's whole customer base is picked by size.
function kubra({ id, name, label, note, stormcenter, view, customers, source }) {
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
        name, label, tile: "power", scope: "home", kind: "level", note, source,
        steps: SHARE_STEPS, ladder: SHARE_LADDER, step: shareStep(share),
        short: `${short(out)} out`,
        detail: `${commas(out)} of ${commas(served)} customers without power, or ${pct(share)}, across ${commas(best.t.total_outages ?? 0)} outages.`,
        dataAt: best.at,
        track: { out, served, outages: best.t.total_outages ?? 0 },
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
        name: "Power outages, nationwide (DOE ODIN)", label: "US outages", tile: "power", scope: "national", kind: "level",
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
    id: "jcpl", name: "JCP&L outages", label: "JCP&L", note: "All of JCP&L's New Jersey territory, from its own outage map.",
    stormcenter: "6c715f0e-bbec-465f-98cc-0b81623744be", view: "fcd7c23d-de37-4471-8ca3-37c3260f94fa", customers: 1161627,
    source: "https://outages-nj.firstenergycorp.com/",
  }),
  kubra({
    id: "pseg", name: "PSE&G outages", label: "PSE&G", note: "PSE&G's electric map. Gas outages aren't published.",
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
      return {
        name: "PJM grid emergency postings", label: "PJM grid", tile: "power", scope: "home", kind: "level",
        note: "PJM runs the grid for New Jersey and 12 other states. Drill postings are ignored.",
        source: "https://emergencyprocedures.pjm.com/ep/pages/dashboard.jsf",
        steps: ["Normal", "Local warnings", "Alert", "Emergency"], sevs: [0, 5, 45, 90],
        ladder: ["nothing posted for NJ zones", "warnings in JCP&L or PSE&G zones", "grid-wide alert", "emergency action or load shed"],
        step,
        short: nj.length ? `${nj.length} for NJ` : drills ? "drill posted" : `${posts.length} posted`,
        detail: `${posts.length} active postings: ${nj.length} touching New Jersey zones, ${elsewhere.length} elsewhere, ${drills} drill.`,
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
      // Emergency notices go out by text first and can reach that list hours later.
      const base = "https://www.smcmua.org/";
      const html = await fetchOk(ctx, base + "alerts.htm");
      need(/ALERTS/i.test(html), "not the SMCMUA alerts page");
      const seen = (ctx.cache.seen ??= {});
      for (const [, href, inner] of html.matchAll(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
        const m = strip(inner).match(/^(.*?)\s*\((\d{1,2})\/(\d{1,2})\/(\d{2,4})\)\s*$/);
        if (!m || !/repair|break|boil|emergency|interruption|advisory|outage/i.test(m[1])) continue;
        const year = Number(m[4]) < 100 ? 2000 + Number(m[4]) : Number(m[4]);
        seen[new URL(href, base).href] ??= { title: m[1], at: Date.UTC(year, m[2] - 1, m[3], 17) };
      }
      for (const n of UNLISTED) seen[n.url] ??= { title: n.title, at: n.at };
      for (const [url, n] of Object.entries(seen)) if (ctx.now - n.at > 5 * 86400e3) delete seen[url];

      // Open each notice from the past two days to see whether the work is still under way.
      const recent = Object.entries(seen).filter(([, n]) => ctx.now - n.at < 2.5 * 86400e3).sort((x, y) => y[1].at - x[1].at).slice(0, 8);
      for (const [url, n] of recent) {
        const res = await ctx.get(url);
        if (!res.ok) continue;
        const text = strip(res.text);
        n.status = /boil[- ]water advisory/i.test(text) && !/no boil[- ]water advisory/i.test(text) ? "boil" : /in progress/i.test(text) ? "active" : /complete|restored/i.test(text) ? "done" : "posted";
        n.where = clip(text.match(/at or near ([^.]{3,90})\./i)?.[1] ?? "", 80);
      }
      const local = (n) => /Morristown|Morris Township|Morris Twp/i.test(`${n.title} ${n.where ?? ""}`);
      const open = recent.map(([, n]) => n).filter((n) => n.status === "active" || n.status === "boil");
      const boil = open.some((n) => n.status === "boil"), nearMe = open.filter(local);
      const say = (n) => `${n.status === "boil" ? "Boil water" : n.status === "active" ? "In progress" : n.status === "done" ? "Completed" : "Posted"}: ${n.where || n.title.replace(/^Water Repairs in /i, "")} (${etDay(n.at)})`;
      return {
        name: "SMCMUA water notices", label: "SMCMUA water", tile: "power", scope: "home", kind: "status",
        state: boil ? "critical" : nearMe.length ? "major" : open.length ? "minor" : "ok",
        short: boil ? "boil water" : nearMe.length ? "repairs near you" : open.length ? `${open.length} repair${open.length > 1 ? "s" : ""} nearby` : "no active notice",
        items: recent.map(([, n]) => say(n)).slice(0, 6),
        note: "From the utility's alerts page and each notice it links to. A repair under way in Morristown or Morris Township counts as major, one in a neighboring town as minor, and a boil-water advisory as critical. Emergency notices go out by text first and can take hours to reach that page, so a new one may not show here right away.",
        source: "https://www.smcmua.org/alerts.htm",
        track: { open: open.length, local: nearMe.length, boil: boil ? 1 : 0 },
      };
    },
  },
];
