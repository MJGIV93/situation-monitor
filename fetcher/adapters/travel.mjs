import { json, need, fetchOk, strip, clip, etClock } from "../lib/util.mjs";

/* ---- FAA ---- */
const FAA = "https://nasstatus.faa.gov/api";
// The national level goes by how many of the 30 major hubs are held at once, by a ground stop,
// a delay program or a closure. One hub held for thunderstorms is an ordinary day.
const FAA_STEPS = ["Normal", "Scattered", "Regional", "Widespread", "Nationwide"];
const FAA_SEVS = [0, 5, 15, 40, 95];
const FAA_LADDER = ["no hub held, and delays at fewer than three", "one or two hubs held, or delays at three or more", "three to five hubs held", "six to eleven hubs held", "twelve or more hubs held"];
const HUBS = "ATL BOS BWI CLT DCA DEN DFW DTW EWR FLL HNL IAD IAH JFK LAS LAX LGA MCO MDW MEM MIA MSP ORD PHL PHX SAN SEA SFO SLC TPA".split(" ");
const NYC = [["EWR", "Newark"], ["JFK", "Kennedy"], ["LGA", "LaGuardia"]];

// "1 hour and 5 minutes", "16 minutes", "45" -> minutes
function minutes(v) {
  if (v == null) return 0;
  if (typeof v === "number") return v;
  const s = String(v), h = s.match(/(\d+)\s*h/i), m = s.match(/(\d+)\s*m/i);
  if (h || m) return (h ? Number(h[1]) * 60 : 0) + (m ? Number(m[1]) : 0);
  return Number(s) || 0;
}
const reasonText = (r) => String(r ?? "").replace(/^.*:/, "").trim().toLowerCase();
// Largest delay figure found anywhere in an FAA delay object, whatever the field is called.
function worstMinutes(o) {
  let best = 0;
  const walk = (x) => {
    if (x == null) return;
    if (typeof x === "object") return Object.entries(x).forEach(([k, v]) => { if (typeof v === "object") walk(v); else if (/min|max|avg|average|delay/i.test(k) && !/time|trend|reason|id/i.test(k)) best = Math.max(best, minutes(v)); });
  };
  walk(o);
  return best;
}
// One record per airport with something posted: its state, worst delay in minutes, and why.
async function faaAirports(ctx) {
  const list = json(await fetchOk(ctx, `${FAA}/airport-events`));
  need(Array.isArray(list), "unexpected FAA response");
  const out = new Map();
  for (const a of list) {
    const delays = [a.arrivalDelay, a.departureDelay].filter(Boolean);
    // Closures posted for private aircraft or overnight curfews are not counted.
    const closed = a.airportClosure && !/NON SKED|TRANSIENT|\bGA\b|DLY \d{4}-\d{4}/i.test(a.airportClosure.simpleText ?? "") && Date.parse(a.airportClosure.startTime) <= ctx.now && Date.parse(a.airportClosure.endTime) > ctx.now;
    let rec = null;
    if (closed) rec = { s: "closed", min: 0, why: "airport closed" };
    else if (a.groundStop) rec = { s: "stop", min: worstMinutes(a.groundStop), why: reasonText(a.groundStop.impactingCondition ?? a.groundStop.reason), until: a.groundStop.endTime };
    else if (a.groundDelay) rec = { s: "program", min: worstMinutes(a.groundDelay), why: reasonText(a.groundDelay.impactingCondition ?? a.groundDelay.reason) };
    else if (delays.length) rec = { s: "delays", min: Math.max(...delays.map(worstMinutes)), why: reasonText(delays[0].reason), kind: delays.map((d) => String(d.arrivalDeparture?.type ?? "").toLowerCase()).filter(Boolean).join(" and ") };
    if (rec) out.set(a.airportId, { ...rec, deicing: a.deicing ? true : undefined, rate: a.airportConfig?.arrivalRate });
  }
  return out;
}
// The FAA command center's plan for the rest of the day: programs it expects it may need.
async function faaPlan(ctx) {
  const res = await ctx.get(`${FAA}/operations-plan`);
  if (!res.ok) return [];
  try {
    return (json(res.text).terminalPlanned ?? []).map((e) => String(e.event ?? "").replace(/\s+/g, " ").trim()).filter(Boolean);
  } catch {
    return [];
  }
}
function planLine(e) {
  const m = e.match(/^AFTER (\d{2})(\d{2})\s*-?\s*(.*)$/i);
  if (!m) return e.toLowerCase();
  const d = new Date(); d.setUTCHours(Number(m[1]), Number(m[2]), 0, 0);
  return `After ${etClock(d.getTime())}: ${m[3].toLowerCase().replace(/\b([a-z]{3})\b(?=[\/ ]|$)/g, (x) => (x.length === 3 && /^(den|sfo|mia|fll|djt|ewr|jfk|lga|ord|atl|bos|dca|iad|phl|lax|las|sea|dfw|iah|clt|mco|tpa|msp|dtw|phx|slc|san|bwi|teb)$/.test(x) ? x.toUpperCase() : x))}`;
}
const stateText = (r) => (r.s === "closed" ? "Closed" : r.s === "stop" ? "Ground stop" : r.s === "program" ? "Delay program" : "Delays") + (r.min ? `, ${r.min} min` : "") + (r.why ? ` (${r.why})` : "");

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
const toTrain = (i) => ({ t: i.departureDate, n: i.trainID, k: /^\w{1,3}$/.test(String(i.track ?? "").trim()) ? String(i.track).trim() : undefined, ...trainState(i) });
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
  if (/Part Suspended/i.test(type)) return "part";
  if (/Suspended|No Scheduled Service/i.test(type)) return "suspended";
  return "delays";
}

export default [
  {
    id: "faa",
    every: 10,
    async run(ctx) {
      const [airports, plan] = await Promise.all([faaAirports(ctx), faaPlan(ctx)]);
      const all = [...airports];
      const hubs = all.filter(([id]) => HUBS.includes(id));
      const count = (list, state) => list.filter(([, r]) => r.s === state).length;
      const heldHubs = hubs.filter(([, r]) => r.s !== "delays").map(([id]) => id), held = heldHubs.length, delayed = count(hubs, "delays");
      const step = held >= 12 ? 4 : held >= 6 ? 3 : held >= 3 ? 2 : held >= 1 || delayed >= 3 ? 1 : 0;
      const order = { closed: 0, stop: 1, program: 2, delays: 3 };
      const lines = all.sort((x, y) => order[x[1].s] - order[y[1].s] || y[1].min - x[1].min).map(([id, r]) => `${id}: ${stateText(r)}`);

      const nyc = NYC.map(([id, name]) => ({ id, name, ...(airports.get(id) ?? { s: "ok", min: 0 }) }));
      const nycPlan = plan.filter((e) => /\b(EWR|JFK|LGA|N90|NY METRO|NYC)\b/i.test(e));
      const planned = nycPlan.some((e) => /PROBABLE|EXPECTED|LIKELY/i.test(e)) ? 10 : nycPlan.length ? 5 : 0;
      const source = "https://nasstatus.faa.gov/";
      return [
        {
          id: "faa-nas", name: "US airports, FAA delays and ground stops", label: "US airports", tile: "air", scope: "national", kind: "level",
          steps: FAA_STEPS, sevs: FAA_SEVS, ladder: FAA_LADDER, step,
          short: held ? `${held} of ${HUBS.length} hubs held` : delayed ? `delays at ${delayed}` : "no hubs held",
          detail: all.length
            ? `${held ? `${held} of the ${HUBS.length} major hubs ${held === 1 ? "is" : "are"} held by a ground stop, delay program or closure: ${heldHubs.join(", ")}.` : `None of the ${HUBS.length} major hubs is held.`}${delayed ? ` ${delayed}${held ? " more" : ""} ${delayed === 1 ? "has" : "have"} delays.` : ""}${all.length - hubs.length ? ` ${all.length - hubs.length} smaller airport${all.length - hubs.length === 1 ? " has" : "s have"} something posted.` : ""}`
            : "No delays, delay programs or ground stops posted anywhere.",
          items: lines.slice(0, 8),
          later: plan.slice(0, 5).map(planLine),
          note: "From the FAA's command center, updated about every minute. A hub is held when it has a ground stop, a delay program or a closure. Later today lists what the FAA expects it may need.",
          source,
          track: { step, held, hubs: hubs.length, airports: all.length, stops: count(all, "stop") + count(all, "closed"), programs: count(all, "program"), worst: Math.max(0, ...all.map(([, r]) => r.min)) },
        },
        {
          id: "faa-nyc", name: "Newark, JFK and LaGuardia", label: "NYC airports", order: 6, tile: "air", scope: "home", kind: "airports",
          w: 0.4, wWhy: "the airports only matter on days you fly",
          airports: nyc.map((a) => ({ id: a.id, name: a.name, s: a.s, min: a.min || undefined, why: a.why || undefined, until: a.until || undefined, deicing: a.deicing })),
          planned,
          later: nycPlan.map(planLine),
          note: "Each airport's worst posted delay, from the FAA's command center.",
          source,
          track: Object.fromEntries(nyc.map((a) => [a.id, a.s === "ok" ? 0 : a.s === "delays" ? a.min || 1 : a.s === "program" ? 1000 + a.min : 2000])),
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
      const outbound = (d) => items(d).filter((i) => i.lineAbbreviation === "M&E" && THROUGH_MORRISTOWN.test(i.destination ?? "")).slice(0, 3).map(toTrain);
      const from = (re) => items(mr).filter((i) => re.test(i.destination ?? "")).slice(0, 3).map(toTrain);
      const me = lineAlerts(sys.getSystemStatus ?? [], "MNE"), nec = lineAlerts(sys.getSystemStatus ?? [], "NEC");
      const banner = strip(mr.getTrainDepartureScreens?.bannerMsg ?? "");
      const shared = {
        tile: "air", scope: "home", kind: "trains", suspended: me.suspended || undefined, lineDelay: me.delay || undefined,
        items: me.lineWide.slice(0, 3).map((m) => clip(m, 180)),
      };
      const tally = (dirs) => {
        const all = dirs.flatMap((d) => d.trains);
        return { trains: all.length, late: all.filter((t) => t.s === "late").length, cancelled: all.filter((t) => t.s === "cancelled").length, maxLate: Math.max(0, ...all.map((t) => t.d ?? 0)), lineDelay: me.delay, suspended: me.suspended ? 1 : 0 };
      };
      const penn = [{ to: "Morristown to Penn Station", trains: from(/New York/i) }, { to: "Penn Station to Morristown", trains: outbound(ny) }];
      const hoboken = [{ to: "Morristown to Hoboken", trains: from(/Hoboken/i) }, { to: "Hoboken to Morristown", trains: outbound(hb) }];
      const necWorst = nec.suspended ? "critical" : nec.delay >= 30 ? "major" : nec.lineWide.length ? "minor" : "ok";
      return [
        {
          ...shared, id: "njt-me", name: "Morristown to and from Penn Station, NJ Transit", label: "Morristown / Penn", rowLabel: ["Morristown", "to/from Penn Station"], order: 1,
          dirs: penn, track: tally(penn),
          note: "The next three trains each way, from NJ Transit's live departure boards, plus any alert for the whole line." + (banner ? " Station notice: " + clip(banner, 160) : ""),
          source: "https://www.njtransit.com/dv-to/Morristown",
        },
        {
          ...shared, id: "njt-hob", name: "Morristown to and from Hoboken, NJ Transit", label: "Morristown / Hoboken", rowLabel: ["Morristown", "to/from Hoboken"], order: 2, w: 0.5, wWhy: "Hoboken is your backup route",
          dirs: hoboken, track: tally(hoboken),
          note: "The next three trains each way, from NJ Transit's live departure boards. PATH covers Hoboken to 33rd Street and has its own reading.",
          source: "https://www.njtransit.com/dv-to/Hoboken",
        },
        {
          id: "njt-nec", name: "Northeast Corridor, NJ Transit", label: "NE Corridor", rowLabel: ["NE Corridor", "via Penn tunnels"], order: 5, tile: "air", scope: "home", kind: "status",
          w: 0.5, wWhy: "it isn't your line, and matters only when its trouble reaches the shared Penn Station tunnels",
          state: necWorst,
          short: nec.suspended ? "suspended" : nec.delay ? `${nec.delay} min delays` : nec.lineWide.length ? `${nec.lineWide.length} alert${nec.lineWide.length > 1 ? "s" : ""}` : "no alerts",
          note: "A neighboring line, from NJ Transit's line alerts. It shares the Penn Station tunnels with the Morristown Line, so serious trouble here usually reaches your trains.",
          items: nec.live.slice(0, 3).map((m) => clip(m, 180)),
          track: { alerts: nec.live.length, lineWide: nec.lineWide.length, delay: nec.delay, suspended: nec.suspended ? 1 : 0 },
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
      const RANK = { ok: 0, delays: 1, part: 2, suspended: 3 };
      const out = new Set(), cut = new Set();
      let citywide = 0;
      for (const e of feed.entity) {
        const a = e.alert ?? {};
        const active = (a.active_period ?? []).some((p) => (p.start ?? 0) <= now && (!p.end || p.end >= now));
        const kind = mtaKind(a["transit_realtime.mercury_alert"]?.alert_type ?? "");
        if (!active || !kind) continue;
        citywide++;
        const text = a.header_text?.translation?.find((t) => t.language === "en")?.text ?? "";
        for (const ent of a.informed_entity ?? []) {
          if (ent.route_id && kind === "suspended") out.add(ent.route_id);
          if (ent.route_id && kind === "part") cut.add(ent.route_id);
          const line = state[ent.route_id];
          if (!line || RANK[kind] <= RANK[line.s]) continue;
          line.s = kind;
          line.text = text;
        }
      }
      const hit = MY_LINES.filter((l) => state[l].s !== "ok");
      return {
        name: "NYC subway, 2, 3, A and C lines", label: "Subway", rowLabel: ["Subway", "from Penn Station"], order: 3, tile: "air", scope: "home", kind: "lines",
        lines: MY_LINES.map((id) => ({ id, s: state[id].s })),
        // How much of the whole subway is out, so a systemwide failure registers even off your lines.
        system: { suspended: out.size, part: cut.size },
        short: `${citywide} citywide`,
        track: { citywide, out: out.size, ...Object.fromEntries(MY_LINES.map((l) => [l, RANK[state[l].s]])) },
        note: `From the MTA's official alert feed. Planned work is left out. Delays are an everyday event and barely count; a suspended line or a systemwide failure does. Across the whole subway, ${citywide} unplanned alert${citywide === 1 ? " is" : "s are"} active and ${out.size} line${out.size === 1 ? " is" : "s are"} suspended.`,
        items: [...new Set(hit.map((l) => clip(state[l].text.replace(/\]\s*\[/g, "/").replace(/\[([\w/]+)\]/g, "$1"), 180)))].slice(0, 3),
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
        name: "PATH, Hoboken to NYC", label: "PATH", rowLabel: ["PATH", "Hoboken to NYC"], order: 4, tile: "air", scope: "home", kind: "status", w: 0.5, wWhy: "PATH is your backup route",
        state: /suspend/i.test(all) ? "major" : open.length ? "minor" : "ok",
        short: open.length ? `${open.length} incident${open.length === 1 ? "" : "s"}` : "no incidents",
        note: "From the Port Authority's incident feed. PATH is your backup route across the Hudson.",
        items: texts.slice(0, 3),
        track: { open: open.length },
        source: "https://www.panynj.gov/path/en/alerts.html",
      };
    },
  },
];
