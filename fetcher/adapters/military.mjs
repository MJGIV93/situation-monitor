import { json, need, fetchOk, round, commas } from "../lib/util.mjs";

// Community receiver networks publish every military aircraft they can currently see.
// adsb.fi asks for attribution and non-commercial use; adsb.lol is the backup.
async function milAircraft(ctx) {
  for (const url of ["https://opendata.adsb.fi/api/v2/mil", "https://api.adsb.lol/v2/mil"]) {
    const res = await ctx.get(url, { timeout: 30000 });
    if (!res.ok) continue;
    try {
      const ac = json(res.text).ac;
      if (Array.isArray(ac) && ac.length) return { ac, from: new URL(url).host.replace(/^(opendata|api)\./, "") };
    } catch {}
  }
  throw new Error("no military aircraft feed answered");
}
const TYPES = {
  Tankers: /^(K35R|K35E|K46|KC10|DC10|A332|MRTT|KC2|KC3|A310)$/,
  Transports: /^(C17|C30J|C130|C5M|C5|A400|C2|C160|C27J|CN35|C295|B762|B752|C40|C32|C37|GLF5|GLF6|GLF4)$/,
  "Patrol and surveillance": /^(P8|P3|R135|RC135|E3TF|E3CF|E3|E6|E4|E8|U2|GLHK|Q4|Q9|E2|E7|RQ4|MQ9|BE20|B350|BE9L|TWR)$/,
  Bombers: /^(B52|B1|B2|B21)$/,
  Fighters: /^(F16|F15|F18|F18S|F18H|F35|F22|A10|EUFI|RFAL|F5|T38|HAWK)$/,
  Trainers: /^(TEX2|PC21|PC7|PC9|G120|T6|T1|T45|T34|PC12)$/,
};
function classify(a) {
  const t = String(a.t ?? "").toUpperCase();
  if (a.category === "A7" || /^(H60|H47|H64|H53|H1|UH1|AS65|EC45|A119|B212|R66|V22|H72|AS32|EC35|NH90|A139)$/.test(t)) return "Helicopters";
  for (const [name, re] of Object.entries(TYPES)) if (re.test(t)) return name;
  return "Other";
}
const airborne = (a) => a.alt_baro != null && a.alt_baro !== "ground" && (a.seen ?? 0) < 120;
const inUS = (a) => a.lat != null && a.lat > 24 && a.lat < 50 && a.lon > -125 && a.lon < -66;
const tag = (a) => `${String(a.flight ?? "").trim() || a.r || a.hex}${typeof a.alt_baro === "number" ? " at " + commas(Math.round(a.alt_baro / 1000) * 1000) + " ft" : ""}`;

// Running average for each hour of the day, since flying follows a daily rhythm.
function hourlyBase(cache, key, hour, value) {
  const slot = ((cache[key] ??= {})[hour] ??= { n: 0, mean: 0 });
  const before = slot.n >= 18 ? slot.mean : null; // about three days of this hour
  slot.n += 1;
  slot.mean += (value - slot.mean) / Math.min(slot.n, 84); // settles over about two weeks
  return before == null ? null : round(before, 1);
}

export default [
  {
    id: "mil-air",
    every: 10,
    async run(ctx) {
      const { ac, from } = await milAircraft(ctx);
      const up = ac.filter(airborne), hour = new Date(ctx.now).getUTCHours();
      const groups = new Map();
      for (const a of up) groups.set(classify(a), (groups.get(classify(a)) ?? 0) + 1);
      const tankers = up.filter((a) => classify(a) === "Tankers");
      const e4 = up.filter((a) => /^E4/i.test(a.t ?? "")), e6 = up.filter((a) => /^E6/i.test(a.t ?? ""));
      const base = hourlyBase(ctx.cache, "all", hour, up.length), tankerBase = hourlyBase(ctx.cache, "tankers", hour, tankers.length);
      const learning = "Scoring starts once it has three days of its own record for this hour of day.";
      const credit = `Aircraft data from ${from}, a volunteer receiver network. It only sees aircraft that are broadcasting their position, and many military flights don't.`;
      const source = "https://adsb.fi/";
      const breakdown = [...groups].sort((a, b) => b[1] - a[1]).map(([g, n]) => `${g}: ${n}`);
      let step = 0;
      if (e4.length >= 1 || e6.length >= 1) step = 1;
      if ((e4.length === 1 && e6.length >= 4) || e6.length === 5) step = 2;
      if (e4.length >= 2 || e6.length >= 6) step = 3;
      return [
        {
          id: "mil-air", name: "Military aircraft airborne, worldwide", label: "Aircraft airborne", tile: "mil", scope: "national", kind: "count",
          num: up.length, base: base ?? undefined, tol: 1.5, sev: 0,
          short: base ? `usual ${Math.round(base)}` : "building baseline",
          items: breakdown,
          note: `${up.filter(inUS).length} of them are over the continental US. ` + (base ? "Compared with the usual count for this hour of day. " : learning + " ") + credit,
          source, track: { up: up.length, us: up.filter(inUS).length, ...Object.fromEntries(groups) },
        },
        {
          id: "mil-tankers", name: "Refueling tankers airborne", label: "Tankers airborne", tile: "mil", scope: "national", kind: "count",
          num: tankers.length, base: tankerBase && tankerBase >= 1 ? tankerBase : undefined, tol: 2, sev: 0,
          short: tankerBase ? `usual ${Math.round(tankerBase)}` : "building baseline",
          items: tankers.slice(0, 6).map(tag),
          note: "Tankers are what long-range operations run on, so an unusual number in the air is one of the earlier public signs of a large movement. " + (tankerBase ? "Scores once the count is double the usual for this hour. " : learning + " ") + credit,
          source, track: { up: tankers.length },
        },
        {
          id: "mil-command", name: "Airborne command posts (E-4B and E-6B)", label: "Command aircraft", tile: "mil", scope: "national", kind: "level",
          steps: ["None up", "Routine", "Unusual", "Surge"], sevs: [0, 0, 25, 60],
          ladder: ["none visible", "E-6Bs on patrol, or one E-4B", "one E-4B with four or more E-6Bs", "two E-4Bs, or six or more E-6Bs"],
          step, short: `${e4.length} E-4B, ${e6.length} E-6B`,
          detail: "The E-4B is the national command aircraft often called the doomsday plane. The E-6B relays orders to missile submarines, and a few are airborne on most days.",
          items: [...e4.map((a) => "E-4B " + tag(a)), ...e6.map((a) => "E-6B " + tag(a))],
          note: "The thresholds here are a first estimate and will be reset from recorded history. " + credit,
          source, track: { e4: e4.length, e6: e6.length },
        },
      ];
    },
  },
  {
    id: "pizza",
    every: 20,
    async run(ctx) {
      const j = json(await fetchOk(ctx, "https://www.pizzint.watch/api/dashboard-data", { timeout: 30000 }));
      need(j.success && Array.isArray(j.data) && typeof j.defcon_level === "number", "unexpected pizza index response");
      const level = Math.min(5, Math.max(1, j.defcon_level)), d = j.defcon_details ?? {};
      const open = j.data.filter((p) => p.current_popularity != null);
      return {
        name: "Pentagon pizza index (PizzINT)", label: "Pizza index", tile: "mil", scope: "national", kind: "level",
        steps: ["DOUGHCON 5", "DOUGHCON 4", "DOUGHCON 3", "DOUGHCON 2", "DOUGHCON 1"], sevs: [0, 5, 10, 15, 20],
        ladder: ["quiet", "above usual", "busy", "several shops spiking", "everything spiking"],
        step: 5 - level,
        short: j.active_spikes ? `${j.active_spikes} spiking` : open.length ? `${open.length} of ${j.data.length} open` : "shops closed",
        detail: open.length ? "" : "None of the tracked shops is reporting live busyness right now, which is normal when they're closed.",
        items: open.map((p) => `${p.name}: ${p.percentage_of_usual != null ? Math.round(p.percentage_of_usual) + "% of usual" : "busyness " + p.current_popularity}${p.is_spike ? ", spiking" : ""}`),
        note: "How busy the pizza shops nearest the Pentagon are compared with their usual, as tracked by the hobby site PizzINT from Google's live busyness figures. The idea is that late-night orders rise when staff are kept in. It's a fun signal, so it can add at most 20 to this domain.",
        source: "https://www.pizzint.watch/",
        track: { level, index: j.overall_index ?? 0, spikes: j.active_spikes ?? 0, open: open.length, max: d.max_pct ?? 0 },
      };
    },
  },
];
