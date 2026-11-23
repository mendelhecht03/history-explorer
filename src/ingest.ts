import { unzipSync, strFromU8 } from "fflate";
import { Ctx } from "./auth";
import { Env, HttpError, cleanTitle, cleanUrl, json, now } from "./util";

export const SOURCE_LIVE = 1;
export const SOURCE_EXPORT = 2;
/** A live visit and an exported visit of the same page this close together are the same visit. */
const SAME_VISIT_SECS = 120;
/** Reloads of the same page within this window count once. */
const RELOAD_SECS = 30;

interface Row {
  url: string;
  title: string | null;
  t: number;
  priv: number;
}

/** Insert URLs (keeping the newest non-empty title) and return url -> id. D1 allows 100 bound params per statement. */
async function upsertUrls(env: Env, userId: string, rows: Row[]): Promise<Map<string, number>> {
  const titles = new Map<string, string | null>();
  for (const r of rows) if (!titles.has(r.url) || r.title) titles.set(r.url, r.title ?? titles.get(r.url) ?? null);
  const entries = [...titles];
  const stmts: D1PreparedStatement[] = [];
  for (let i = 0; i < entries.length; i += 33) {
    const chunk = entries.slice(i, i + 33);
    stmts.push(
      env.DB.prepare(
        `INSERT INTO urls (user_id, url, title) VALUES ${chunk.map(() => "(?, ?, ?)").join(",")}
         ON CONFLICT (user_id, url) DO UPDATE SET title = COALESCE(excluded.title, urls.title)
         RETURNING id, url`,
      ).bind(...chunk.flatMap(([u, t]) => [userId, u, t])),
    );
  }
  const ids = new Map<string, number>();
  for (let i = 0; i < stmts.length; i += 50) {
    const res = await env.DB.batch<{ id: number; url: string }>(stmts.slice(i, i + 50));
    for (const r of res) for (const row of r.results) ids.set(row.url, row.id);
  }
  return ids;
}

/** POST /api/visits from the live-sync userscript: {visits: [{url, title, t, private}]} */
export async function liveVisits(req: Request, env: Env, ctx: Ctx): Promise<Response> {
  const body = (await req.json().catch(() => null)) as { visits?: any[] } | null;
  if (!body || !Array.isArray(body.visits)) throw new HttpError(400, "Expected {visits: [...]}");
  const t1 = now() + 60, t0 = now() - 30 * 86400;
  const rows: Row[] = [];
  for (const v of body.visits.slice(0, 500)) {
    const url = cleanUrl(v?.url);
    const t = Math.floor(Number(v?.t));
    if (!url || !(t > t0 && t < t1)) continue;
    rows.push({ url, title: cleanTitle(v?.title), t, priv: v?.private ? 1 : 0 });
  }
  if (!rows.length) return json({ ok: true, added: 0 });
  const ids = await upsertUrls(env, ctx.userId, rows);
  const res = await env.DB.batch(
    rows.map((r) =>
      env.DB.prepare(
        `INSERT OR IGNORE INTO visits (user_id, t, url_id, source, device, private)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6
         WHERE NOT EXISTS (SELECT 1 FROM visits WHERE user_id = ?1 AND url_id = ?3 AND (
           (source = ?4 AND t BETWEEN ?2 - ?7 AND ?2 + ?7) OR (source <> ?4 AND t BETWEEN ?2 - ?8 AND ?2 + ?8)))`,
      ).bind(ctx.userId, r.t, ids.get(r.url)!, SOURCE_LIVE, ctx.tokenId ?? null, r.priv, RELOAD_SECS, SAME_VISIT_SECS),
    ),
  );
  return json({ ok: true, added: res.reduce((n, r) => n + (r.meta.changes || 0), 0) });
}

/** Parse Safari's "Export Browsing Data" output: a zip containing History.json, or the JSON itself. */
export function parseSafariExport(buf: Uint8Array): Row[] {
  const docs: string[] = [];
  if (buf[0] === 0x50 && buf[1] === 0x4b) {
    const files = unzipSync(buf, { filter: (f) => /history[^/]*\.json$/i.test(f.name) && !f.name.startsWith("__MACOSX") });
    for (const name in files) docs.push(strFromU8(files[name]));
    if (!docs.length) throw new HttpError(400, "No History.json in that zip. Make sure History was ticked when exporting.");
  } else {
    docs.push(new TextDecoder().decode(buf));
  }
  const rows: Row[] = [];
  for (const doc of docs) {
    let data: any;
    try {
      data = JSON.parse(doc.replace(/^﻿/, ""));
    } catch {
      throw new HttpError(400, "That file isn't a Safari history export");
    }
    const items = Array.isArray(data?.history) ? data.history : null;
    if (!items) throw new HttpError(400, "That file isn't a Safari history export");
    for (const it of items) {
      if (it?.latest_visit_was_load_failure) continue;
      const us = it?.time_usec ?? it?.visit_time_usec ?? it?.last_visit_time_usec;
      const url = cleanUrl(it?.url);
      if (!url || !us) continue;
      rows.push({ url, title: cleanTitle(it?.title), t: Math.floor(Number(us) / 1e6), priv: 0 });
    }
  }
  return rows;
}

/** POST /api/import with the export zip (or History.json) as the raw body. */
export async function importExport(req: Request, env: Env, ctx: Ctx): Promise<Response> {
  const buf = new Uint8Array(await req.arrayBuffer());
  if (!buf.length) throw new HttpError(400, "Empty upload");
  if (buf.length > 95 * 1024 * 1024) throw new HttpError(413, "File too large");
  let rows = parseSafariExport(buf);
  const total = rows.length;
  // Each export contains everything Safari still has, so after the first one only the
  // recent part is new. Re-check two days of overlap in case the last export was mid-day.
  const last = await env.DB.prepare("SELECT MAX(t) AS t FROM visits WHERE user_id = ? AND source = ?")
    .bind(ctx.userId, SOURCE_EXPORT).first<{ t: number | null }>();
  if (last?.t) rows = rows.filter((r) => r.t >= last.t! - 2 * 86400);
  if (!rows.length) return json({ ok: true, total, added: 0 });

  const ids = await upsertUrls(env, ctx.userId, rows);
  const stmts: D1PreparedStatement[] = [];
  for (let i = 0; i < rows.length; i += 20) {
    const chunk = rows.slice(i, i + 20);
    stmts.push(
      env.DB.prepare(
        `INSERT OR IGNORE INTO visits (user_id, t, url_id, source, device, private) VALUES ${chunk.map(() => "(?, ?, ?, ?, NULL, 0)").join(",")}`,
      ).bind(...chunk.flatMap((r) => [ctx.userId, r.t, ids.get(r.url)!, SOURCE_EXPORT])),
    );
  }
  let added = 0;
  for (let i = 0; i < stmts.length; i += 50) {
    for (const r of await env.DB.batch(stmts.slice(i, i + 50))) added += r.meta.changes || 0;
  }
  // The export is Safari's own record, so drop live copies of visits it now covers.
  let t0 = Infinity, t1 = -Infinity;
  for (const r of rows) (t0 = Math.min(t0, r.t)), (t1 = Math.max(t1, r.t));
  const del = await env.DB.prepare(
    `DELETE FROM visits WHERE user_id = ?1 AND source = ?2 AND private = 0 AND t BETWEEN ?3 AND ?4
     AND EXISTS (SELECT 1 FROM visits e WHERE e.user_id = ?1 AND e.url_id = visits.url_id AND e.source = ?5
       AND e.t BETWEEN visits.t - ?6 AND visits.t + ?6)`,
  ).bind(ctx.userId, SOURCE_LIVE, t0 - SAME_VISIT_SECS, t1 + SAME_VISIT_SECS, SOURCE_EXPORT, SAME_VISIT_SECS).run();
  return json({ ok: true, total, added, merged: del.meta.changes || 0 });
}
