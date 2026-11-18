// One place for every outbound request, so each source sees the same honest client.
export const UA =
  "Mozilla/5.0 (compatible; SituationMonitor/0.1; +https://github.com/MJGIV93/situation-monitor)";

export async function get(url, opts = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.timeout ?? 20000);
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      method: opts.method ?? "GET",
      headers: { "User-Agent": UA, Accept: opts.accept ?? "*/*", ...(opts.headers ?? {}) },
      body: opts.body,
      signal: ctl.signal,
      redirect: "follow",
    });
    const text = await res.text();
    return {
      ok: res.ok,
      status: res.status,
      type: res.headers.get("content-type") ?? "",
      text,
      ms: Date.now() - t0,
      finalUrl: res.url,
    };
  } catch (e) {
    const cause = e.cause ?? e;
    return {
      ok: false,
      status: 0,
      type: "",
      text: "",
      ms: Date.now() - t0,
      error: `${cause.code ?? cause.name ?? "Error"}: ${String(cause.message ?? e.message).slice(0, 160)}`,
    };
  } finally {
    clearTimeout(timer);
  }
}
