import { json, need, fetchOk, strip, clip, commas, short, pct } from "../lib/util.mjs";

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
    every: 30,
    async run(ctx) {
      const text = strip(await fetchOk(ctx, "https://www.smcmua.org/"));
      need(/Southeast Morris County/i.test(text), "not the SMCMUA page");
      // The standing emergency phone line is boilerplate, not a notice.
      const body = text.replace(/24-Hour Emergencies[^.]*?\d{3}-\d{3}-\d{4}/i, " ");
      const major = body.match(/boil[- ]water|do not drink|do not use|water emergency|contaminat\w+/i);
      const minor = body.match(/main break|water main|low pressure|discolou?red water|service interruption|water restriction|outage/i);
      const hit = major ?? minor;
      let near = "";
      if (hit) near = clip(body.slice(Math.max(0, hit.index - 80), hit.index + 160), 200);
      return {
        name: "SMCMUA water notices", label: "SMCMUA water", tile: "power", scope: "home", kind: "status",
        note: hit ? `Found on the utility's home page: “${near}”` : "Read from the utility's home page, where it posts main breaks, boil-water advisories and supply emergencies.",
        source: "https://www.smcmua.org/",
        state: major ? "major" : minor ? "minor" : "ok",
        short: hit ? hit[0].toLowerCase() : "no notice",
        track: { notice: major ? 2 : minor ? 1 : 0 },
      };
    },
  },
];
