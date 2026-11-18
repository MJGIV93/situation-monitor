import { json, need, fetchOk, clip, km, etWeekdayClock } from "../lib/util.mjs";

const HOME = { lat: 40.797, lon: -74.481 }; // Morristown
const US_PLACE = /(Alabama|Alaska|Arizona|Arkansas|California|Colorado|Connecticut|Delaware|Florida|Georgia|Hawaii|Idaho|Illinois|Indiana|Iowa|Kansas|Kentucky|Louisiana|Maine|Maryland|Massachusetts|Michigan|Minnesota|Mississippi|Missouri|Montana|Nebraska|Nevada|New Hampshire|New Jersey|New Mexico|New York|North Carolina|North Dakota|Ohio|Oklahoma|Oregon|Pennsylvania|Rhode Island|South Carolina|South Dakota|Tennessee|Texas|Utah|Vermont|Virginia|Washington|West Virginia|Wisconsin|Wyoming|Puerto Rico|, [A-Z]{2})$/;
const USGS = "https://earthquake.usgs.gov";
const since = (ctx, days) => new Date(ctx.now - days * 86400e3).toISOString().slice(0, 19);

function nws({ id, zone, name, label }) {
  return {
    id,
    every: 10,
    async run(ctx) {
      const j = json(await fetchOk(ctx, `https://api.weather.gov/alerts/active?zone=${zone}`, { accept: "application/geo+json" }));
      need(Array.isArray(j.features), "no alert list");
      const events = j.features.map((f) => f.properties).filter((p) => p && p.status === "Actual" && p.messageType !== "Cancel").map((p) => {
        const ends = p.ends ?? p.expires;
        return {
          event: p.event,
          onset: p.onset ?? p.effective,
          ends,
          text: ends ? "until " + etWeekdayClock(Date.parse(ends)) : "",
          emergency: /Tornado|Flash Flood/.test(p.event ?? "") && /EMERGENCY/.test(`${p.headline ?? ""} ${p.description ?? ""}`) ? true : undefined,
          more: clip(p.headline ?? "", 180),
        };
      });
      return {
        name, label, tile: "hazard", scope: "home", kind: "events", rule: "weather",
        events,
        short: events.length ? clip(events[0].event, 26) : "none active",
        note: `National Weather Service alerts for zone ${zone}.`,
        source: `https://alerts.weather.gov/search?zone=${zone}`,
      };
    },
  };
}

export default [
  nws({ id: "nws-morris", zone: "NJZ008", name: "NWS alerts, Morris County", label: "Morris weather" }),
  nws({ id: "nws-manhattan", zone: "NYZ072", name: "NWS alerts, Manhattan", label: "NYC weather" }),
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
        steps: ["G0", "G1", "G2", "G3", "G4", "G5"], sevs: [0, 5, 15, 35, 65, 95],
        ladder: ["quiet", "minor", "moderate", "strong: grid voltage alarms", "severe: grid problems", "extreme: blackouts possible"],
        step: g,
        short: ahead > g ? `G${ahead} forecast` : s || r ? `S${s} R${r}` : "quiet",
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
      return {
        name: "USGS earthquakes, United States", label: "Quakes, US", tile: "hazard", scope: "national", kind: "events", rule: "quakeUS",
        events: us.map((p) => ({ event: `M${p.mag.toFixed(1)}, ${p.place}`, mag: p.mag, at: new Date(p.time).toISOString(), alert: p.alert ?? undefined })),
        short: "M6+ in US",
        note: `${day.features.length} quakes of magnitude 4.5 or more worldwide in the past day` + (top ? `, the largest M${top.mag.toFixed(1)} ${top.place}.` : "."),
        source: "https://earthquake.usgs.gov/earthquakes/map/",
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
        name: "USGS earthquakes near Morristown", label: "Quakes, local", tile: "hazard", scope: "home", kind: "events", rule: "quakeHome",
        events,
        short: "within 185 mi",
        note: "Magnitude 2 and up within 185 miles of Morristown over the past three days.",
        source: "https://earthquake.usgs.gov/earthquakes/map/",
      };
    },
  },
];
