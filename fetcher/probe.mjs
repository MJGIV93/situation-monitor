// Requests every source once and records which ones answer with real data.
// Output: out/probe.json (latest run) and out/probe-log.jsonl (one line per run).

import { mkdir, writeFile, appendFile } from "node:fs/promises";
import { get } from "./lib/http.mjs";
import { SOURCES } from "./sources.mjs";

const OUT = "out";
const CONCURRENCY = 8;

async function probeOne(src) {
  const base = { id: src.id, group: src.group, name: src.name };
  try {
    const { res, url, detail, why } = await src.probe(get);
    const pass = res.ok && detail != null;
    return {
      ...base,
      url: url ?? src.url,
      ok: pass,
      status: res.status,
      ms: res.ms,
      bytes: res.text.length,
      type: res.type.split(";")[0],
      detail: pass ? detail : why ? "check failed: " + why : res.error ?? `HTTP ${res.status}`,
      sample: pass ? undefined : res.text.replace(/\s+/g, " ").slice(0, 240) || undefined,
    };
  } catch (e) {
    // The request answered but the content was not what the source should return.
    return { ...base, url: src.url, ok: false, status: -1, ms: 0, bytes: 0, type: "", detail: "check failed: " + String(e.message).slice(0, 200) };
  }
}

async function pool(items, n, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i]);
      }
    }),
  );
  return results;
}

const ranAt = new Date().toISOString();
const results = await pool(SOURCES, CONCURRENCY, probeOne);
const failed = results.filter((r) => !r.ok);

const report = {
  ranAt,
  event: process.env.GITHUB_EVENT_NAME ?? "local",
  runId: process.env.GITHUB_RUN_ID ?? null,
  total: results.length,
  ok: results.length - failed.length,
  results,
};

await mkdir(OUT, { recursive: true });
await writeFile(`${OUT}/probe.json`, JSON.stringify(report, null, 1));
await appendFile(
  `${OUT}/probe-log.jsonl`,
  JSON.stringify({ t: ranAt, event: report.event, ok: report.ok, total: report.total, failed: failed.map((r) => r.id) }) + "\n",
);

for (const r of results) {
  console.log(`${r.ok ? "ok  " : "FAIL"} ${r.id.padEnd(18)} ${String(r.status).padStart(4)} ${String(r.ms).padStart(6)}ms  ${r.detail}`);
}
console.log(`\n${report.ok} of ${report.total} sources answered with usable data`);
