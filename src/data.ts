import { cleanHost, findSearch } from "./search";
import { Env, now } from "./util";
import { SOURCE_EXPORT } from "./ingest";

/** Build the same data shape the original dashboard (template.html) was written against. */
export async function dashboardData(env: Env, userId: string) {
  const [urlRows, visitRows, tokenRows] = await env.DB.batch([
    env.DB.prepare("SELECT id, url, title FROM urls WHERE user_id = ?").bind(userId),
    env.DB.prepare("SELECT t, url_id, source, device, private FROM visits WHERE user_id = ? ORDER BY t").bind(userId),
    env.DB.prepare("SELECT id, name FROM tokens WHERE user_id = ? ORDER BY created").bind(userId),
  ]);

  const hosts: string[] = [], hostIdx = new Map<string, number>();
  const urls: [string, string | null, number][] = [], urlIdx = new Map<number, number>();
  for (const r of urlRows.results as { id: number; url: string; title: string | null }[]) {
    const h = cleanHost(r.url);
    if (!hostIdx.has(h)) hostIdx.set(h, hosts.push(h) - 1);
    urlIdx.set(r.id, urls.push([r.url, r.title, hostIdx.get(h)!]) - 1);
  }

  const devices: { name: string; kind: string }[] = [], devIdx = new Map<string, number>();
  const dev = (key: string, name: string) => {
    if (!devIdx.has(key)) devIdx.set(key, devices.push({ name, kind: "phone" }) - 1);
    return devIdx.get(key)!;
  };
  const tokenNames = new Map((tokenRows.results as { id: string; name: string }[]).map((t) => [t.id, t.name]));

  const v = { t: [] as number[], u: [] as number[], d: [] as number[], dev: [] as number[], p: [] as number[] };
  for (const r of visitRows.results as { t: number; url_id: number; source: number; device: string | null; private: number }[]) {
    const ui = urlIdx.get(r.url_id);
    if (ui === undefined) continue;
    const di = r.source === SOURCE_EXPORT
      ? dev("export", "Safari (export)")
      : dev(r.device || "live", `${tokenNames.get(r.device || "") || "Removed device"} (live)`);
    v.t.push(r.t); v.u.push(ui); v.d.push(0); v.dev.push(di); v.p.push(r.private ? 1 : 0);
  }

  // Searches, collapsing reloads/paging of the same search within 3 minutes (as build.py did).
  const engines: string[] = [], engIdx = new Map<string, number>();
  const s = { t: [] as number[], term: [] as string[], e: [] as number[], dev: [] as number[], p: [] as number[], u: [] as number[] };
  const last = new Map<string, number>();
  const parsed = new Map<number, [string, string] | null>();
  for (let i = 0; i < v.t.length; i++) {
    const ui = v.u[i];
    if (!parsed.has(ui)) parsed.set(ui, findSearch(urls[ui][0]));
    const fs = parsed.get(ui);
    if (!fs) continue;
    const [eng, term] = fs, k = term.toLowerCase() + "\u0000" + v.dev[i], t = v.t[i];
    const prev = last.get(k);
    last.set(k, t);
    if (prev !== undefined && t - prev < 180) continue;
    if (!engIdx.has(eng)) engIdx.set(eng, engines.push(eng) - 1);
    s.t.push(t); s.term.push(term); s.e.push(engIdx.get(eng)!); s.dev.push(v.dev[i]); s.p.push(v.p[i]); s.u.push(ui);
  }

  return {
    generated: now(),
    profiles: v.p.includes(1) ? ["Safari", "Private Browsing"] : ["Safari"],
    devices,
    hosts,
    icons: {},
    urls,
    engines,
    v,
    s,
  };
}
