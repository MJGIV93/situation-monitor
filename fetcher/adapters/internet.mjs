import { json, need, fetchOk, clip, median } from "../lib/util.mjs";

const INDICATOR = { none: "ok", minor: "minor", major: "major", critical: "critical", maintenance: "ok" };

// Atlassian Statuspage, used by Claude, Cloudflare and Plaid.
export async function statuspage(ctx, host) {
  const j = json(await fetchOk(ctx, `https://${host}/api/v2/summary.json`));
  need(j.status?.indicator, "no status indicator");
  const incidents = (j.incidents ?? []).filter((i) => !/resolved|postmortem/i.test(i.status));
  const flagged = (j.components ?? []).filter((c) => c.status && c.status !== "operational" && c.status !== "under_maintenance" && !c.group);
  return { state: INDICATOR[j.status.indicator] ?? "minor", incidents, flagged, total: (j.components ?? []).length };
}
function statusDoc({ id, host, name, label, source, note = "" }) {
  return {
    id,
    every: 10,
    async run(ctx) {
      const s = await statuspage(ctx, host);
      const n = s.incidents.length;
      return {
        name, label, tile: "net", scope: "national", kind: "status", source,
        state: s.state,
        short: n ? `${n} incident${n > 1 ? "s" : ""}` : "no incidents",
        note: note || (s.flagged.length ? `${s.flagged.length} of ${s.total} components flagged.` : ""),
        items: s.incidents.slice(0, 4).map((i) => clip(i.name, 120)),
      };
    },
  };
}

// Georgia Tech's IODA probes networks from outside. The reading compares the
// latest count of responding address blocks with the past day's median.
function ioda({ id, asn, name, label, note }) {
  return {
    id,
    every: 10,
    async run(ctx) {
      const until = Math.floor(ctx.now / 1000), from = until - 86400;
      const j = json(await fetchOk(ctx, `https://api.ioda.inetintel.cc.gatech.edu/v2/signals/raw/asn/${asn}?from=${from}&until=${until}`));
      const series = (j.data ?? []).flat();
      const ratio = (source) => {
        const v = (series.find((s) => s.datasource === source)?.values ?? []).filter((x) => typeof x === "number");
        if (v.length < 12) return null;
        const base = median(v);
        return base ? v.at(-1) / base : null;
      };
      const ping = ratio("ping-slash24"), bgp = ratio("bgp");
      const known = [ping, bgp].filter((x) => x != null);
      need(known.length, "no usable signal");
      const worst = Math.min(...known);
      return {
        name, label, tile: "net", scope: "home", kind: "level", note,
        source: `https://ioda.inetintel.cc.gatech.edu/asn/${asn}`,
        steps: ["Normal", "Dip", "Partial outage", "Major outage"], sevs: [0, 20, 50, 85],
        ladder: ["over 90% reachable", "75% to 90%", "40% to 75%", "under 40%"],
        step: worst >= 0.9 ? 0 : worst >= 0.75 ? 1 : worst >= 0.4 ? 2 : 3,
        short: `${Math.round(worst * 100)}% reach`,
        detail: [ping != null && `Responding address blocks are at ${Math.round(ping * 100)}% of the 24-hour median.`, bgp != null && `Routes announced are at ${Math.round(bgp * 100)}%.`].filter(Boolean).join(" "),
      };
    },
  };
}

export default [
  statusDoc({ id: "status-claude", host: "status.claude.com", name: "Claude status", label: "Claude", source: "https://status.claude.com/" }),
  statusDoc({ id: "status-cloudflare", host: "www.cloudflarestatus.com", name: "Cloudflare status", label: "Cloudflare", source: "https://www.cloudflarestatus.com/" }),
  {
    id: "status-apple",
    every: 10,
    async run(ctx) {
      const text = await fetchOk(ctx, "https://www.apple.com/support/systemstatus/data/system_status_en_US.js");
      const data = json(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
      need(Array.isArray(data.services), "no services list");
      const open = new Map();
      for (const s of data.services) {
        for (const e of s.events ?? []) {
          if (e.eventStatus === "resolved" || e.eventStatus === "completed" || (e.epochEndDate && e.epochEndDate < ctx.now)) continue;
          if (!open.has(e.messageId)) open.set(e.messageId, { type: e.statusType, services: new Set(), message: e.message });
          open.get(e.messageId).services.add(s.serviceName);
        }
      }
      const events = [...open.values()];
      const outages = events.filter((e) => /outage/i.test(e.type));
      const affected = new Set(events.flatMap((e) => [...e.services])).size;
      return {
        name: "Apple system status", label: "Apple", tile: "net", scope: "national", kind: "status",
        state: outages.length && affected >= 10 ? "critical" : outages.length ? "major" : events.length ? "minor" : "ok",
        short: `${events.length} open`,
        note: `${data.services.length} services tracked. Resolved events are left out.`,
        items: events.slice(0, 4).map((e) => clip(`${e.type}: ${[...e.services].slice(0, 3).join(", ")}${e.services.size > 3 ? " and " + (e.services.size - 3) + " more" : ""}`, 140)),
        source: "https://www.apple.com/support/systemstatus/",
      };
    },
  },
  {
    id: "status-m365",
    every: 10,
    async run(ctx) {
      const api = "https://status.cloud.microsoft/api/posts/";
      const [consumer, admin, azure] = await Promise.all(["m365Consumer", "mac", "azure"].map(async (k) => json(await fetchOk(ctx, api + k))));
      need(Array.isArray(consumer), "unexpected Microsoft response");
      const down = consumer.filter((p) => !/operational|available/i.test(p.Status ?? ""));
      const adminBad = !/available|operational/i.test(admin.Status ?? ""), azureBad = !/available|operational/i.test(azure.Status ?? "");
      const items = [...down.map((p) => `${p.ServiceDisplayName}: ${p.Status}`), adminBad && `Microsoft 365 admin: ${admin.Status}`, azureBad && `Azure: ${clip(azure.Message ?? azure.Status, 100)}`].filter(Boolean);
      return {
        name: "Microsoft service health", label: "Microsoft 365", tile: "net", scope: "national", kind: "status",
        state: adminBad || azureBad || down.length >= 3 ? "major" : down.length ? "minor" : "ok",
        short: items.length ? `${items.length} flagged` : "all products",
        note: "Microsoft's public status page, covering Microsoft 365, Azure and consumer products.",
        items: items.slice(0, 4),
        source: "https://status.cloud.microsoft/",
      };
    },
  },
  ioda({
    id: "isp-optimum", asn: 6128, name: "Optimum network (IODA)", label: "Optimum",
    note: "Georgia Tech's IODA project probes the network from outside. It covers Optimum as a whole, so one neighborhood losing service would not show.",
  }),
  ioda({
    id: "isp-verizon", asn: 6167, name: "Verizon Wireless network (IODA)", label: "Verizon",
    note: "Measures the wireless network's link to the internet, not cell tower coverage.",
  }),
];
