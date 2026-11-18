import { json, need, fetchOk } from "../lib/util.mjs";

// Current conditions and the next 12 hours for Morristown. This is context, like the
// headlines: it is shown, never scored. Weather alerts are separate readings and do score.
const POINT = "40.797,-74.481", STATION = "KMMU", NWS = "https://api.weather.gov";
const geo = { accept: "application/geo+json" };

// One of nine pictures, from the forecaster's short description.
export function sky(text, day) {
  const t = String(text ?? "").toLowerCase();
  if (/thunder|t-storm/.test(t)) return "storm";
  if (/snow|sleet|flurr|wintry|ice|freezing/.test(t)) return "snow";
  if (/rain|shower|drizzle/.test(t)) return "rain";
  if (/fog|haze|mist|smoke/.test(t)) return "fog";
  if (/mostly cloudy|overcast|^cloudy|\bcloudy$/.test(t)) return "cloud";
  if (/partly|mostly sunny|mostly clear|few clouds/.test(t)) return day ? "partsun" : "partmoon";
  return day ? "sun" : "moon";
}
const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
const mph = (kmh) => (kmh == null ? null : Math.round(kmh * 0.621));
const hourLabel = (iso) => new Date(iso).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric" }).replace(" ", "").toLowerCase().replace("m", "");

// "Rain likely 2 PM to 5 PM" from the hourly chances, or that nothing is expected.
export function rainText(hours) {
  const wet = hours.filter((h) => h.pop >= 30);
  if (!wet.length) return hours.some((h) => h.pop >= 15) ? "A slight chance of rain in the next 12 hours" : "No rain expected in the next 12 hours";
  const kind = wet.some((h) => h.sky === "snow") ? "Snow" : wet.some((h) => h.sky === "storm") ? "Storms" : "Rain";
  const top = Math.max(...wet.map((h) => h.pop)), clock = (iso) => new Date(iso).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric" });
  const from = clock(wet[0].t), to = clock(new Date(Date.parse(wet.at(-1).t) + 3600e3).toISOString());
  return `${kind} ${top >= 60 ? "likely" : "possible"} ${wet[0] === hours[0] ? "until " + to : from + " to " + to}, ${top}% chance`;
}

export default [
  {
    id: "weather",
    every: 10,
    async run(ctx) {
      // The point lookup names the forecast grid for this spot. It doesn't change.
      const grid = await ctx.memo("grid", 1440, async () => {
        const p = json(await fetchOk(ctx, `${NWS}/points/${POINT}`, geo)).properties;
        need(p?.forecastHourly && p?.forecast, "no forecast grid for the point");
        return { hourly: p.forecastHourly, daily: p.forecast };
      });
      const hourly = await ctx.memo("hourly", 30, async () => {
        const list = json(await fetchOk(ctx, grid.hourly, geo)).properties?.periods;
        need(Array.isArray(list) && list.length >= 12, "short hourly forecast");
        return list.slice(0, 30).map((p) => ({ t: p.startTime, end: p.endTime, temp: p.temperature, pop: p.probabilityOfPrecipitation?.value ?? 0, text: p.shortForecast, day: p.isDaytime, wind: parseInt(p.windSpeed, 10) || 0, dir: p.windDirection || "" }));
      });
      const daily = await ctx.memo("daily", 60, async () => {
        const list = json(await fetchOk(ctx, grid.daily, geo)).properties?.periods;
        need(Array.isArray(list) && list.length >= 2, "short daily forecast");
        return list.slice(0, 4).map((p) => ({ end: p.endTime, day: p.isDaytime, temp: p.temperature }));
      });
      // Two hours more than the page shows, so it can drop hours that pass between checks and still fill 12.
      const ahead = hourly.filter((h) => Date.parse(h.end) > ctx.now).slice(0, 14);
      need(ahead.length >= 6, "hourly forecast is out of date");
      const hours = ahead.map((h) => ({ t: h.t, h: hourLabel(h.t), temp: h.temp, pop: h.pop, sky: sky(h.text, h.day) }));

      // The airport's own readings when it reports them, and the forecast for this hour when it doesn't.
      const first = ahead[0];
      let now = { temp: first.temp, text: first.text, wind: first.wind, dir: first.dir, gust: null, day: first.day, from: "forecast" };
      const obs = await ctx.get(`${NWS}/stations/${STATION}/observations/latest`, geo);
      if (obs.ok) {
        try {
          const o = json(obs.text).properties, fresh = ctx.now - Date.parse(o.timestamp) < 90 * 60e3;
          if (fresh && o.temperature?.value != null) {
            now = {
              temp: Math.round(o.temperature.value * 1.8 + 32), text: o.textDescription || first.text, day: first.day, from: "Morristown Airport",
              wind: mph(o.windSpeed?.value) ?? first.wind, dir: o.windDirection?.value != null && o.windSpeed?.value ? COMPASS[Math.round(o.windDirection.value / 45) % 8] : first.dir, gust: mph(o.windGust?.value),
            };
          }
        } catch { /* keep the forecast values */ }
      }
      const future = daily.filter((p) => Date.parse(p.end) > ctx.now);
      return {
        kind: "weather", place: "Morristown",
        now: { ...now, sky: sky(now.text, now.day) },
        hi: future.find((p) => p.day)?.temp ?? null, lo: future.find((p) => !p.day)?.temp ?? null,
        // Whether the next figure is today's high or tonight's low comes first depends on the hour.
        nightFirst: future[0] ? !future[0].day : false,
        hours, rain: rainText(hours.slice(0, 12)),
        source: "https://forecast.weather.gov/MapClick.php?lat=40.797&lon=-74.481",
      };
    },
  },
];
