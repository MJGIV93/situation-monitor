import { json, need, fetchOk, clip, km, etWeekdayClock, touchesBox } from "../lib/util.mjs";

const HOME = { lat: 40.797, lon: -74.481 }; // Morristown
const US_PLACE = /(Alabama|Alaska|Arizona|Arkansas|California|Colorado|Connecticut|Delaware|Florida|Georgia|Hawaii|Idaho|Illinois|Indiana|Iowa|Kansas|Kentucky|Louisiana|Maine|Maryland|Massachusetts|Michigan|Minnesota|Mississippi|Missouri|Montana|Nebraska|Nevada|New Hampshire|New Jersey|New Mexico|New York|North Carolina|North Dakota|Ohio|Oklahoma|Oregon|Pennsylvania|Rhode Island|South Carolina|South Dakota|Tennessee|Texas|Utah|Vermont|Virginia|Washington|West Virginia|Wisconsin|Wyoming|Puerto Rico|, [A-Z]{2})$/;
const USGS = "https://earthquake.usgs.gov";
const since = (ctx, days) => new Date(ctx.now - days * 86400e3).toISOString().slice(0, 19);

// Morristown and Morris Township together, as [west, south, east, north].
const TOWN_BOX = [-74.5423, 40.7644, -74.4342, 40.8332];

// Long-running alerts like winter storms are issued for the forecast zone. Short-fuse
// warnings (tornado, severe thunderstorm, flash flood) are issued for the county and drawn
// as a shape, so both codes are asked for. A shape that misses the box is marked as away.
function nws({ id, zones, box, name, label, rowLabel, note }) {
  return {
    id,
    every: 10,
    async run(ctx) {
      const j = json(await fetchOk(ctx, `https://api.weather.gov/alerts/active?zone=${zones}`, { accept: "application/geo+json" }));
      need(Array.isArray(j.features), "no alert list");
      const seen = new Set();
      const events = j.features.filter((f) => f?.properties && f.properties.status === "Actual" && f.properties.messageType !== "Cancel" && !seen.has(f.properties.id) && seen.add(f.properties.id)).map((f) => {
        const p = f.properties, ends = p.ends ?? p.expires;
        return {
          event: p.event,
          onset: p.onset ?? p.effective,
          ends,
          text: ends ? "until " + etWeekdayClock(Date.parse(ends)) : "",
          emergency: /Tornado|Flash Flood/.test(p.event ?? "") && /EMERGENCY/.test(`${p.headline ?? ""} ${p.description ?? ""}`) ? true : undefined,
          more: clip(p.headline ?? "", 180),
          away: box && f.geometry && !touchesBox(f.geometry, box) ? true : undefined,
        };
      });
      const here = events.filter((e) => !e.away);
      return {
        name, label, rowLabel, card: "weather", tile: "hazard", scope: "home", kind: "events", rule: "weather", idle: "No alerts", unit: "alert",
        events,
        short: here.length ? clip(here[0].event, 26) : events.length ? "not in town" : "",
        note,
        source: `https://alerts.weather.gov/search?zone=${zones}`,
      };
    },
  };
}

export default [
  nws({
    id: "nws-morris", zones: "NJZ008,NJC027", box: TOWN_BOX, name: "Weather alerts, Morristown and Morris Township", label: "Weather alerts, local", rowLabel: ["Weather alerts", "Morristown"],
    note: "National Weather Service alerts for Morris County. A warning drawn as a shape, like a tornado or flash flood warning, counts in full only when the shape reaches Morristown or Morris Township.",
  }),
  nws({ id: "nws-manhattan", zones: "NYZ072,NYC061", name: "Weather alerts, Manhattan", label: "Weather alerts, NYC", rowLabel: ["Weather alerts", "Manhattan"], note: "National Weather Service alerts for Manhattan, both area-wide alerts and short-fuse warnings." }),
  {
    id: "swpc-scales",
    every: 30,
    async run(ctx) {
      const j = json(await fetchOk(ctx, "https://services.swpc.noaa.gov/products/noaa-scales.json"));
      need(j["0"]?.G, "no current scales");
      const g = Number(j["0"].G.Scale) || 0, s = Number(j["0"].S.Scale) || 0, r = Number(j["0"].R.Scale) || 0;
      const ahead = Math.max(...["1", "2", "3"].map((k) => Number(j[k]?.G?.Scale) || 0));
      return {
        name: "NOAA space weather", label: "Space weather", tile: "hazard", scope: "national", kind: "level",
        steps: ["Quiet", "G1", "G2", "G3", "G4", "G5"], sevs: [0, 5, 15, 35, 65, 95],
        ladder: ["no geomagnetic storm", "minor storm", "moderate storm", "strong: grid voltage alarms", "severe: grid problems", "extreme: blackouts possible"],
        step: g,
        short: g ? ["", "minor storm", "moderate storm", "strong storm", "severe storm", "extreme storm"][g] : ahead ? `G${ahead} forecast` : "none forecast",
        detail: `Geomagnetic storm level G${g} now.` + (ahead ? ` A G${ahead} storm is forecast within three days.` : " Nothing forecast for the next three days.") + ` Solar radiation S${s}, radio blackout R${r}.`,
        note: "Geomagnetic storms are the kind that can disturb power grids and GPS.",
        source: "https://www.swpc.noaa.gov/",
      };
    },
  },
  {
    id: "usgs-quakes",
    every: 10,
    async run(ctx) {
      const big = json(await fetchOk(ctx, `${USGS}/fdsnws/event/1/query?format=geojson&minmagnitude=5.5&starttime=${since(ctx, 4)}`));
      const day = json(await fetchOk(ctx, `${USGS}/earthquakes/feed/v1.0/summary/4.5_day.geojson`));
      need(Array.isArray(big.features) && Array.isArray(day.features), "no quake list");
      const us = big.features.map((f) => f.properties).filter((p) => US_PLACE.test(p.place ?? ""));
      const top = day.features.map((f) => f.properties).sort((a, b) => b.mag - a.mag)[0];
      // The largest US quake of the past day is shown even when it is far too small to count.
      const small = await ctx.get(`${USGS}/earthquakes/feed/v1.0/summary/2.5_day.geojson`);
      let biggest = null;
      try { biggest = small.ok ? json(small.text).features.map((f) => f.properties).filter((p) => US_PLACE.test(p.place ?? "") && typeof p.mag === "number").sort((a, b) => b.mag - a.mag)[0] ?? null : null; } catch { biggest = null; }
      const region = (place) => { const tail = String(place ?? "").split(",").pop().trim(); return { CA: "California", NV: "Nevada", OR: "Oregon", WA: "Washington", HI: "Hawaii", AK: "Alaska" }[tail] ?? tail; };
      return {
        name: "Earthquakes, United States", label: "Earthquakes, US", rowLabel: ["Earthquakes", "United States"], tile: "hazard", scope: "national", kind: "events", rule: "quakeUS",
        events: us.map((p) => ({ event: `M${p.mag.toFixed(1)}, ${p.place}`, mag: p.mag, at: new Date(p.time).toISOString(), alert: p.alert ?? undefined })),
        top: biggest ? { mag: biggest.mag, where: region(biggest.place), place: biggest.place, at: new Date(biggest.time).toISOString() } : null,
        idle: "None", short: "past day",
        detail: biggest ? `The largest US quake of the past day was M${biggest.mag.toFixed(1)}, ${biggest.place}. Quakes this size are routine and don't count.` : "No US quake of magnitude 2.5 or more in the past day.",
        note: `${day.features.length} quakes of magnitude 4.5 or more worldwide in the past day` + (top ? `, the largest M${top.mag.toFixed(1)} ${top.place}.` : "."),
        source: "https://earthquake.usgs.gov/earthquakes/map/",
      };
    },
  },
  {
    // A modeled estimate for the town's coordinates, not a reading from an official monitor.
    id: "air-quality",
    every: 30,
    async run(ctx) {
      const j = json(await fetchOk(ctx, `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${HOME.lat}&longitude=${HOME.lon}&current=us_aqi,pm2_5,ozone&timezone=America%2FNew_York`));
      const aqi = j.current?.us_aqi;
      need(typeof aqi === "number", "no air quality index");
      const pm = j.current?.pm2_5;
      return {
        name: "Air quality, Morristown", label: "Air quality", rowLabel: ["Air quality", "Morristown"], tile: "hazard", scope: "home", kind: "level", order: 2,
        steps: ["Good", "Moderate", "Sensitive", "Unhealthy", "Very unhealthy", "Hazardous"], sevs: [0, 0, 15, 40, 65, 90],
        ladder: ["index 0 to 50", "51 to 100", "101 to 150: unhealthy for sensitive groups", "151 to 200", "201 to 300", "over 300"],
        step: aqi > 300 ? 5 : aqi > 200 ? 4 : aqi > 150 ? 3 : aqi > 100 ? 2 : aqi > 50 ? 1 : 0,
        short: `index ${Math.round(aqi)}`,
        detail: `The US air quality index is ${Math.round(aqi)}.` + (typeof pm === "number" ? ` Fine particles, the kind wildfire smoke raises, are at ${pm.toFixed(1)} micrograms per cubic meter.` : ""),
        track: { aqi: Math.round(aqi), pm25: typeof pm === "number" ? Math.round(pm * 10) / 10 : null },
        note: "A modeled estimate for Morristown from Open-Meteo, updated hourly. It is not a reading from an official monitor. Moderate is an ordinary day and doesn't count.",
        source: "https://open-meteo.com/en/docs/air-quality-api",
      };
    },
  },
  {
    id: "usgs-local",
    every: 10,
    async run(ctx) {
      const j = json(await fetchOk(ctx, `${USGS}/fdsnws/event/1/query?format=geojson&latitude=${HOME.lat}&longitude=${HOME.lon}&maxradiuskm=300&minmagnitude=2&starttime=${since(ctx, 3)}`));
      need(Array.isArray(j.features), "no quake list");
      const events = j.features.map((f) => {
        const [lon, lat] = f.geometry.coordinates, d = km(HOME.lat, HOME.lon, lat, lon), p = f.properties;
        return { event: `M${p.mag.toFixed(1)}, ${p.place}`, mag: p.mag, km: Math.round(d), at: new Date(p.time).toISOString(), text: `${Math.round(d * 0.621)} miles away` };
      }).sort((a, b) => b.mag - a.mag);
      return {
        name: "Earthquakes near Morristown", label: "Earthquakes, nearby", rowLabel: ["Earthquakes", "within 185 miles"], tile: "hazard", scope: "home", kind: "events", rule: "quakeHome",
        events,
        top: events[0] ? { mag: events[0].mag, where: events[0].text, at: events[0].at } : null,
        idle: "None", short: "past 3 days",
        note: "Magnitude 2 and up within 185 miles of Morristown over the past three days.",
        source: "https://earthquake.usgs.gov/earthquakes/map/",
      };
    },
  },
];
