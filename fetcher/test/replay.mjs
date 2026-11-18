// Runs every adapter against saved responses instead of the network.
// Usage: SAMPLES=/path/to/samples node fetcher/test/replay.mjs [now-iso]

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { runOnce } from "../run.mjs";
import { calc, rowText } from "../../site/score.js";

const dir = process.env.SAMPLES;
if (!dir) throw new Error("set SAMPLES to the folder of saved responses");
const index = JSON.parse(await readFile(`${dir}/index.json`, "utf8"));
const now = Date.parse(process.argv[2] ?? "2026-11-18T01:38:30Z");
const key = (u) => { const x = new URL(u); return x.host + x.pathname + (x.searchParams.get("id") ?? ""); };

// NJ Transit's data endpoint answers POSTs, so its replies are small hand-made fixtures.
const NJT = {
  MR: [
    { departureDate: "8:43 PM", destination: "Hoboken", inlineMessage: "", lineAbbreviation: "M&E", status: "in 2 Min", trainID: "674" },
    { departureDate: "8:57 PM", destination: "New York -SEC", inlineMessage: "", lineAbbreviation: "M&E", status: "Late 12 Min", trainID: "6674" },
    { departureDate: "9:14 PM", destination: "Dover", inlineMessage: "", lineAbbreviation: "M&E", status: "", trainID: "6667" },
    { departureDate: "9:50 PM", destination: "New York -SEC", inlineMessage: "", lineAbbreviation: "M&E", status: "CANCELLED", trainID: "6676" },
  ],
  NY: [
    { departureDate: "8:51 PM", destination: "Dover -SEC", inlineMessage: "", lineAbbreviation: "M&E", status: "BOARDING", trainID: "6671" },
    { departureDate: "8:55 PM", destination: "Trenton", inlineMessage: "", lineAbbreviation: "NEC", status: "", trainID: "3875" },
  ],
  HB: [{ departureDate: "9:02 PM", destination: "Dover", inlineMessage: "", lineAbbreviation: "M&E", status: "", trainID: "665" }],
  SYS: [
    { abbreviation: "MNE", service: "Rail", advisoryAlert: "0", message: "Morris & Essex Line service is subject to up to 20-minute delays due to signal issues near Summit." },
    { abbreviation: "MNE", service: "Rail", advisoryAlert: "1", message: "Delays due to Track Maintenance, Saturday and Sunday" },
    { abbreviation: "NEC", service: "Rail", advisoryAlert: "0", message: "NEC train #3875 is cancelled due to crew availability." },
  ],
};

async function get(url, opts = {}) {
  const reply = (text) => ({ ok: true, status: 200, type: "", text, ms: 1 });
  if (url.includes("njtransit.com/api/graphql")) {
    const body = JSON.parse(opts.body);
    if (/getSystemStatus/.test(body.query)) return reply(JSON.stringify({ data: { getSystemStatus: NJT.SYS } }));
    return reply(JSON.stringify({ data: { getTrainDepartureScreens: { items: NJT[body.variables.station], bannerMsg: "" } } }));
  }
  if (/offset=[1-9]/.test(url)) return reply(JSON.stringify({ results: [] }));
  if (url.includes("nvd.nist.gov") && now - Date.parse(new URL(url).searchParams.get("pubStartDate") + "Z") > 30 * 86400e3) return reply(await readFile(`${dir}/nvd-critical-90.txt`, "utf8"));
  const hit = index.find((x) => x.url === url) ?? index.find((x) => key(x.url) === key(url));
  if (!hit) return { ok: false, status: 0, type: "", text: "", ms: 1, error: "no sample for " + url };
  return { ok: hit.status >= 200 && hit.status < 300, status: hit.status, type: hit.type, text: await readFile(`${dir}/${hit.name}.txt`, "utf8"), ms: 1 };
}

const shared = {};
let latest, summary;
for (let i = 5; i >= 0; i--) {
  if (i === 2) NJT.MR[1].status = "Late 25 Min";
  ({ latest, summary } = await runOnce({ get, now: now - i * 600e3, state: shared, event: "replay" }));
}
for (const f of latest.feeds.sort((a, b) => (a.tile + a.scope).localeCompare(b.tile + b.scope))) {
  const c = calc(f, now);
  console.log(`${f.tile.padEnd(7)}${f.scope.padEnd(9)}${String(c.sev).padStart(3)}  ${f.label.padEnd(20)} ${rowText(f, c, now).join(" | ")}`);
}
console.log(summary);
for (const e of latest.errors) console.log("FAILED", e.id, e.msg);
await mkdir("out", { recursive: true });
await writeFile("out/replay-latest.json", JSON.stringify(latest, null, 1));
