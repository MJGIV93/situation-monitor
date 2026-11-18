import { json, need, fetchOk, strip, clip, etClock } from "../lib/util.mjs";

/* ---- FAA ---- */
const FAA = "https://nasstatus.faa.gov/api";
const FAA_STEPS = ["Clear", "Delays", "Delay programs", "Ground stops", "Nationwide stop"];
const FAA_SEVS = [0, 5, 15, 35, 95];
const FAA_LADDER = ["nothing posted at the 30 major hubs", "delays at up to four hubs", "delay programs, or delays at five or more hubs", "ground stops at major hubs", "ground stops at twelve or more airports"];
const HUBS = "ATL BOS BWI CLT DCA DEN DFW DTW EWR FLL HNL IAD IAH JFK LAS LAX LGA MCO MDW MEM MIA MSP ORD PHL PHX SAN SEA SFO SLC TPA".split(" ");
const NYC = [["EWR", "Newark"], ["JFK", "JFK"], ["LGA", "LaGuardia"]];

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
      const [airports, plan] = await Promise.all([faaAirports(ctx), faaPlan(ctx)]);
      const all = [...airports];
      const hubs = all.filter(([id]) => HUBS.includes(id));
      const count = (list, state) => list.filter(([, r]) => r.s === state).length;
      const stops = count(all, "stop") + count(all, "closed");
      let step = 0;
      if (hubs.length) step = 1;
      if (count(hubs, "program") || hubs.length >= 5 || stops) step = 2;
      if (count(hubs, "stop") || count(hubs, "closed")) step = 3;
      if (stops >= 12) step = 4;
      const order = { closed: 0, stop: 1, program: 2, delays: 3 };
      const lines = all.sort((x, y) => order[x[1].s] - order[y[1].s] || y[1].min - x[1].min).map(([id, r]) => `${id}: ${stateText(r)}`);

      const nyc = NYC.map(([id, name]) => ({ id, name, ...(airports.get(id) ?? { s: "ok", min: 0 }) }));
      const nycPlan = plan.filter((e) => /\b(EWR|JFK|LGA|N90|NY METRO|NYC)\b/i.test(e));
      const planned = nycPlan.some((e) => /PROBABLE|EXPECTED|LIKELY/i.test(e)) ? 10 : nycPlan.length ? 5 : 0;
      const source = "https://nasstatus.faa.gov/";
      return [
        {
          id: "faa-nas", name: "FAA national airspace", label: "FAA, national", tile: "air", scope: "national", kind: "level",
          steps: FAA_STEPS, sevs: FAA_SEVS, ladder: FAA_LADDER, step,
          short: `${hubs.length} of ${HUBS.length} hubs`,
          detail: all.length ? `${hubs.length} of the ${HUBS.length} major hubs have something posted, and ${all.length - hubs.length} smaller airports.` : "No delays, delay programs or ground stops posted anywhere.",
          items: [...lines.slice(0, 8), ...plan.slice(0, 4).map((e) => "Planned. " + planLine(e))],
          note: "From the FAA's command center, updated about every minute. Planned lines are what it expects it may need later today.",
          source,
          track: { step, hubs: hubs.length, airports: all.length, stops, programs: count(all, "program"), worst: Math.max(0, ...all.map(([, r]) => r.min)) },
        },
        {
          id: "faa-nyc", name: "Newark, JFK and LaGuardia", label: "NYC airports", tile: "air", scope: "home", kind: "airports",
          w: 0.4, wWhy: "the airports only matter on days you fly",
          airports: nyc.map((a) => ({ id: a.id, name: a.name, s: a.s, min: a.min || undefined, why: a.why || undefined, until: a.until || undefined, deicing: a.deicing })),
          planned,
          items: nycPlan.map((e) => "Planned. " + planLine(e)),
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
      const outbound = (d) => items(d).filter((i) => i.lineAbbreviation === "M&E" && THROUGH_MORRISTOWN.test(i.destination ?? "")).slice(0, 4).map(toTrain);
      const from = (re) => items(mr).filter((i) => re.test(i.destination ?? "")).slice(0, 4).map(toTrain);
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
      const penn = [{ to: "To Penn from Morristown", trains: from(/New York/i) }, { to: "From Penn toward Morristown", trains: outbound(ny) }];
      const hoboken = [{ to: "To Hoboken from Morristown", trains: from(/Hoboken/i) }, { to: "From Hoboken toward Morristown", trains: outbound(hb) }];
      const necWorst = nec.suspended ? "critical" : nec.delay >= 30 ? "major" : nec.lineWide.length ? "minor" : "ok";
      return [
        {
          ...shared, id: "njt-me", name: "NJ Transit, Morristown and NY Penn", label: "Penn trains",
          dirs: penn, track: tally(penn),
          note: "From NJ Transit's live departure boards and line alerts." + (banner ? " Station notice: " + clip(banner, 160) : ""),
          source: "https://www.njtransit.com/dv-to/Morristown",
        },
        {
          ...shared, id: "njt-hob", name: "NJ Transit, Morristown and Hoboken", label: "Hoboken trains", w: 0.5, wWhy: "Hoboken is your backup route",
          dirs: hoboken, track: tally(hoboken),
          note: "From the live departure boards. PATH covers Hoboken to 33rd St and has its own reading.",
          source: "https://www.njtransit.com/dv-to/Hoboken",
        },
        {
          id: "njt-nec", name: "NJ Transit, Northeast Corridor", label: "NE Corridor", tile: "air", scope: "home", kind: "status",
          state: necWorst,
          short: nec.suspended ? "suspended" : nec.delay ? `${nec.delay} min delays` : nec.lineWide.length ? `${nec.lineWide.length} alert${nec.lineWide.length > 1 ? "s" : ""}` : "no alerts",
          note: "Shares the Penn Station tunnels with your line, so trouble here usually reaches the Morristown Line.",
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
        track: { citywide, ...Object.fromEntries(MY_LINES.map((l) => [l, state[l].s === "suspended" ? 2 : state[l].s === "delays" ? 1 : 0])) },
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
        name: "PATH", label: "PATH", tile: "air", scope: "home", kind: "status", w: 0.5, wWhy: "PATH is your backup route",
        state: /suspend/i.test(all) ? "major" : open.length ? "minor" : "ok",
        short: `${open.length} incident${open.length === 1 ? "" : "s"}`,
        note: "From the Port Authority's incident feed. Your backup route across the Hudson.",
        items: texts.slice(0, 3),
        track: { open: open.length },
        source: "https://www.panynj.gov/path/en/alerts.html",
      };
    },
  },
];
