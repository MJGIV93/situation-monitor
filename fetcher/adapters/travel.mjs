import { json, need, fetchOk, strip, clip } from "../lib/util.mjs";

/* ---- FAA ---- */
const FAA_STEPS = ["Clear", "Delays", "Delay programs", "Ground stops", "Nationwide stop"];
const FAA_SEVS = [0, 5, 25, 55, 95];
const FAA_LADDER = ["no delays posted", "weather or volume delays", "ground delay programs", "ground stops at major hubs", "nationwide ground stop"];
const HUBS = new Set("ATL ORD DFW DEN LAX JFK EWR LGA SFO SEA MIA MCO CLT PHX IAH BOS LAS MSP DTW PHL DCA IAD BWI SLC SAN FLL".split(" "));
const NYC = ["EWR", "JFK", "LGA"];

function faaParse(xml) {
  need(/AIRPORT_STATUS_INFORMATION/.test(xml), "not FAA xml");
  const out = { delays: new Map(), programs: new Map(), stops: new Map() };
  for (const block of xml.split("<Delay_type>").slice(1)) {
    const name = block.match(/<Name>([^<]*)</)?.[1] ?? "";
    const bucket = /Ground Stop/i.test(name) ? out.stops : /Ground Delay|Airspace Flow/i.test(name) ? out.programs : /General Arrival/i.test(name) ? out.delays : null;
    if (!bucket) continue; // closures here are mostly notices for private aircraft
    for (const item of block.split(/<(?:Delay|Ground_Delay|Program)>/).slice(1)) {
      const arpt = item.match(/<ARPT>([^<]*)</)?.[1];
      if (!arpt) continue;
      const reason = (item.match(/<Reason>([^<]*)</)?.[1] ?? "").replace(/^.*:/, "").trim().toLowerCase();
      const max = item.match(/<Max>([^<]*)</)?.[1] ?? item.match(/<Avg>([^<]*)</)?.[1] ?? "";
      bucket.set(arpt, { reason, max });
    }
  }
  return out;
}
function faaDoc(f, only) {
  const pick = (m) => [...m].filter(([a]) => !only || only.includes(a));
  const delays = pick(f.delays), programs = pick(f.programs), stops = pick(f.stops);
  let step = 0;
  if (delays.length) step = 1;
  if (programs.length) step = 2;
  if (stops.length) step = only || stops.some(([a]) => HUBS.has(a)) ? 3 : 2;
  if (f.stops.size >= 12) step = 4;
  const say = (list, what) => list.map(([a, d]) => `${a} ${what}${d.max ? ", up to " + d.max : ""}${d.reason ? " (" + d.reason + ")" : ""}`);
  const lines = [...say(stops, "ground stop"), ...say(programs, "delay program"), ...say(delays, "delays")];
  const n = new Set([...delays, ...programs, ...stops].map(([a]) => a)).size;
  return { step, n, lines };
}

/* ---- NJ Transit ---- */
const NJT = "https://www.njtransit.com/api/graphql/graphql";
const BOARD_QUERY = "query TrainDepartureScreens($station: String!) { getTrainDepartureScreens(station: $station) { items { departureDate destination inlineMessage line lineAbbreviation status track trainID } bannerMsg fullScreenMsg } }";
const STATUS_QUERY = "query SystemStatus { getSystemStatus { abbreviation message service advisoryAlert } }";
async function njt(ctx, query, variables) {
  const text = await fetchOk(ctx, NJT, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query, variables }) });
  const j = json(text);
  need(j.data, "NJ Transit returned no data: " + text.slice(0, 120));
  return j.data;
}
// Trains from the terminals that continue through Morristown.
const THROUGH_MORRISTOWN = /Dover|Hopatcong|Hackettstown|Olive|Morristown|Netcong|Denville/i;
function trainState(item) {
  const text = `${item.status ?? ""} ${item.inlineMessage ?? ""}`;
  if (/cancel/i.test(text)) return { s: "cancelled" };
  const m = text.match(/(\d+)\s*min\w*\.?\s*late/i) ?? text.match(/(?:late|delay\w*)\D{0,12}(\d+)\s*min/i);
  if (m) return Number(m[1]) >= 3 ? { s: "late", d: Number(m[1]) } : { s: "ok" };
  if (/\blate\b|delay/i.test(text)) return { s: "late" };
  return { s: "ok" };
}
const toTrain = (i) => ({ t: i.departureDate, n: i.trainID, ...trainState(i) });
function lineAlerts(system, abbr) {
  const live = system.filter((s) => s.service === "Rail" && s.abbreviation === abbr && String(s.advisoryAlert) === "0").map((s) => strip(s.message ?? ""));
  let delay = 0;
  for (const m of live) {
    for (const hit of m.matchAll(/(\d+)[- ]?(?:to[- ]\d+[- ])?min(?:ute)?s?[- ]?delays?|delays? of (?:up to )?(\d+)/gi)) delay = Math.max(delay, Number(hit[1] ?? hit[2]));
  }
  const suspended = live.some((m) => /suspended/i.test(m) && !/resum|restor/i.test(m));
  const lineWide = live.filter((m) => !/^.{0,40}train #\d+/i.test(m) || /delays/i.test(m));
  return { live, delay, suspended, lineWide };
}

/* ---- MTA ---- */
const MY_LINES = ["2", "3", "A", "C"];
function mtaKind(type) {
  if (/^Planned|Station Notice|Boarding Change|Extra Service|Reduced Service|Special/i.test(type)) return null;
  if (/Suspended/i.test(type)) return "suspended";
  return "delays";
}

export default [
  {
    id: "faa",
    every: 10,
    async run(ctx) {
      const f = faaParse(await fetchOk(ctx, "https://nasstatus.faa.gov/api/airport-status-information"));
      const nat = faaDoc(f), nyc = faaDoc(f, NYC);
      const base = { tile: "air", kind: "level", steps: FAA_STEPS, sevs: FAA_SEVS, ladder: FAA_LADDER, source: "https://nasstatus.faa.gov/" };
      return [
        {
          ...base, id: "faa-nas", name: "FAA national airspace", label: "FAA, national", scope: "national",
          note: "The FAA updates this feed about every minute.",
          step: nat.step, short: nat.n ? `${nat.n} airport${nat.n > 1 ? "s" : ""}` : "none posted",
          detail: nat.n ? "" : "No delays, delay programs or ground stops posted.",
          items: nat.lines.slice(0, 8),
        },
        {
          ...base, id: "faa-nyc", name: "EWR / JFK / LGA", label: "NYC airports", scope: "home", note: "",
          step: nyc.step, short: "EWR JFK LGA",
          detail: nyc.n ? "" : "Nothing posted for Newark, JFK or LaGuardia.",
          items: nyc.lines,
        },
      ];
    },
  },
  {
    id: "njt",
    every: 10,
    async run(ctx) {
      const [mr, ny, hb, sys] = await Promise.all([
        njt(ctx, BOARD_QUERY, { station: "MR" }),
        njt(ctx, BOARD_QUERY, { station: "NY" }),
        njt(ctx, BOARD_QUERY, { station: "HB" }),
        njt(ctx, STATUS_QUERY),
      ]);
      const items = (d) => d.getTrainDepartureScreens?.items ?? [];
      const outbound = (d) => items(d).filter((i) => i.lineAbbreviation === "M&E" && THROUGH_MORRISTOWN.test(i.destination ?? "")).slice(0, 4).map(toTrain);
      const from = (re) => items(mr).filter((i) => re.test(i.destination ?? "")).slice(0, 4).map(toTrain);
      const me = lineAlerts(sys.getSystemStatus ?? [], "MNE"), nec = lineAlerts(sys.getSystemStatus ?? [], "NEC");
      const banner = strip(mr.getTrainDepartureScreens?.bannerMsg ?? "");
      const shared = {
        tile: "air", scope: "home", kind: "trains", suspended: me.suspended || undefined, lineDelay: me.delay || undefined,
        items: me.lineWide.slice(0, 3).map((m) => clip(m, 180)),
      };
      const necWorst = nec.suspended ? "critical" : nec.delay >= 30 ? "major" : nec.lineWide.length ? "minor" : "ok";
      return [
        {
          ...shared, id: "njt-me", name: "NJ Transit, Morristown and NY Penn", label: "Penn trains",
          dirs: [{ to: "To Penn from Morristown", trains: from(/New York/i) }, { to: "From Penn toward Morristown", trains: outbound(ny) }],
          note: "From NJ Transit's live departure boards and line alerts." + (banner ? " Station notice: " + clip(banner, 160) : ""),
          source: "https://www.njtransit.com/dv-to/Morristown",
        },
        {
          ...shared, id: "njt-hob", name: "NJ Transit, Morristown and Hoboken", label: "Hoboken trains",
          dirs: [{ to: "To Hoboken from Morristown", trains: from(/Hoboken/i) }, { to: "From Hoboken toward Morristown", trains: outbound(hb) }],
          note: "From the live departure boards. PATH covers Hoboken to 33rd St and has its own reading.",
          source: "https://www.njtransit.com/dv-to/Hoboken",
        },
        {
          id: "njt-nec", name: "NJ Transit, Northeast Corridor", label: "NE Corridor", tile: "air", scope: "home", kind: "status",
          state: necWorst,
          short: nec.suspended ? "suspended" : nec.delay ? `${nec.delay} min delays` : nec.lineWide.length ? `${nec.lineWide.length} alert${nec.lineWide.length > 1 ? "s" : ""}` : "no alerts",
          note: "Shares the Penn Station tunnels with your line, so trouble here usually reaches the Morristown Line.",
          items: nec.live.slice(0, 3).map((m) => clip(m, 180)),
          source: "https://www.njtransit.com/travel-alerts-to?tab=Rail&line=NEC",
        },
      ];
    },
  },
  {
    id: "subway",
    every: 10,
    async run(ctx) {
      const feed = json(await fetchOk(ctx, "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/camsys%2Fsubway-alerts.json"));
      need(Array.isArray(feed.entity), "no alert list");
      const now = ctx.now / 1000;
      const state = Object.fromEntries(MY_LINES.map((l) => [l, { s: "ok", text: "" }]));
      let citywide = 0;
      for (const e of feed.entity) {
        const a = e.alert ?? {};
        const active = (a.active_period ?? []).some((p) => (p.start ?? 0) <= now && (!p.end || p.end >= now));
        const kind = mtaKind(a["transit_realtime.mercury_alert"]?.alert_type ?? "");
        if (!active || !kind) continue;
        citywide++;
        const text = a.header_text?.translation?.find((t) => t.language === "en")?.text ?? "";
        for (const ent of a.informed_entity ?? []) {
          const line = state[ent.route_id];
          if (!line || line.s === "suspended") continue;
          line.s = kind;
          line.text = text;
        }
      }
      const hit = MY_LINES.filter((l) => state[l].s !== "ok");
      return {
        name: "Subway, Penn Station to the office", label: "Subway", tile: "air", scope: "home", kind: "lines",
        lines: MY_LINES.map((id) => ({ id, s: state[id].s })),
        short: `${citywide} citywide`,
        note: "From the MTA's official alert feed. Planned work is left out.",
        items: [...new Set(hit.map((l) => clip(state[l].text.replace(/\[(\w+)\]/g, "$1"), 180)))].slice(0, 3),
        source: "https://www.mta.info/alerts",
      };
    },
  },
  {
    id: "path",
    every: 10,
    async run(ctx) {
      const j = json(await fetchOk(ctx, "https://www.panynj.gov/bin/portauthority/everbridge/incidents?status=All&department=Path"));
      need(j.status === "Success" || Array.isArray(j.data), "unexpected PATH response");
      const open = (j.data ?? []).filter((i) => !/closed|resolved/i.test(String(i.status ?? i.incidentStatus ?? "")));
      const texts = open.map((i) => strip(String(i.incidentMessage?.subject ?? i.subject ?? i.title ?? i.message ?? i.preMessage ?? JSON.stringify(i)))).map((t) => clip(t, 180));
      const all = texts.join(" ");
      return {
        name: "PATH", label: "PATH", tile: "air", scope: "home", kind: "status",
        state: /suspend/i.test(all) ? "major" : open.length ? "minor" : "ok",
        short: `${open.length} incident${open.length === 1 ? "" : "s"}`,
        note: "From the Port Authority's incident feed. Your backup route across the Hudson.",
        items: texts.slice(0, 3),
        source: "https://www.panynj.gov/path/en/alerts.html",
      };
    },
  },
];
