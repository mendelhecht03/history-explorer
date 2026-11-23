import { Ctx } from "./auth";
import { Env, HttpError, cleanTitle, cleanUrl, json, now } from "./util";

// Sized for the Workers free plan: every request does a small, bounded amount of work
// (at most ~40 D1 statements and a few hundred rows). Big exports are parsed in the
// browser and sent in batches.

export const SOURCE_LIVE = 1;
export const SOURCE_EXPORT = 2;
/** A live visit and an exported visit of the same page this close together are the same visit. */
const SAME_VISIT_SECS = 120;
/** Reloads of the same page within this window count once. */
const RELOAD_SECS = 30;
export const LIVE_BATCH = 100;
export const IMPORT_BATCH = 300;

interface Row {
  url: string;
  title: string | null;
  t: number;
  priv: number;
}

function cleanRows(input: unknown, max: number, t0: number, t1: number): Row[] {
  if (!Array.isArray(input)) throw new HttpError(400, "Expected {visits: [...]}");
  if (input.length > max) throw new HttpError(413, `At most ${max} visits per request`);
  const rows: Row[] = [];
  for (const v of input) {
    const url = cleanUrl(v?.url);
    const t = Math.floor(Number(v?.t));
    if (!url || !(t > t0 && t < t1)) continue;
    rows.push({ url, title: cleanTitle(v?.title), t, priv: v?.private ? 1 : 0 });
  }
  return rows;
}

/** Make sure every URL exists for this user (filling in missing titles) and return url -> id. */
async function urlIds(env: Env, userId: string, rows: Row[]): Promise<Map<string, number>> {
  const titles = new Map<string, string | null>();
  for (const r of rows) if (r.title || !titles.has(r.url)) titles.set(r.url, r.title ?? titles.get(r.url) ?? null);
  const entries = [...titles];
  const stmts: D1PreparedStatement[] = [];
  for (let i = 0; i < entries.length; i += 33) {
    const chunk = entries.slice(i, i + 33);
    stmts.push(
      env.DB.prepare(
        `INSERT INTO urls (user_id, url, title) VALUES ${chunk.map(() => "(?, ?, ?)").join(",")}
         ON CONFLICT (user_id, url) DO UPDATE SET title = excluded.title
         WHERE urls.title IS NULL AND excluded.title IS NOT NULL`,
      ).bind(...chunk.flatMap(([u, t]) => [userId, u, t])),
    );
  }
  const reads: D1PreparedStatement[] = [];
  for (let i = 0; i < entries.length; i += 98) {
    const chunk = entries.slice(i, i + 98);
    reads.push(
      env.DB.prepare(`SELECT id, url FROM urls WHERE user_id = ? AND url IN (${chunk.map(() => "?").join(",")})`)
        .bind(userId, ...chunk.map(([u]) => u)),
    );
  }
  const res = await env.DB.batch<{ id: number; url: string }>([...stmts, ...reads]);
  const ids = new Map<string, number>();
  for (const r of res.slice(stmts.length)) for (const row of r.results) ids.set(row.url, row.id);
  return ids;
}

/** POST /api/visits from the live-sync userscript: {visits: [{url, title, t, private}]} */
export async function liveVisits(req: Request, env: Env, ctx: Ctx): Promise<Response> {
  const body = (await req.json().catch(() => null)) as { visits?: unknown } | null;
  const rows: Row[] = [];
  const lastKept = new Map<string, number>();
  // Reloads inside one batch can't see each other in SQL, so collapse them here first.
  for (const r of cleanRows(body?.visits, LIVE_BATCH, now() - 30 * 86400, now() + 60).sort((a, b) => a.t - b.t)) {
    const prev = lastKept.get(r.url);
    if (prev !== undefined && r.t - prev <= RELOAD_SECS) {
      if (r.title) for (const k of rows) if (k.url === r.url && !k.title) k.title = r.title;
      continue;
    }
    lastKept.set(r.url, r.t);
    rows.push(r);
  }
  if (!rows.length) return json({ ok: true, added: 0 });
  const ids = await urlIds(env, ctx.userId, rows);
  // ?1 user, ?2 live, ?3 device, ?4 reload window, ?5 same-visit window, ?6 added; then (t, url_id, private) per row.
  const stmts: D1PreparedStatement[] = [];
  for (let i = 0; i < rows.length; i += 30) {
    const chunk = rows.slice(i, i + 30);
    let n = 6;
    const values = chunk.map(() => `(?${++n}, ?${++n}, ?${++n})`).join(",");
    stmts.push(
      env.DB.prepare(
        `INSERT OR IGNORE INTO visits (user_id, t, url_id, source, device, private, added)
         SELECT ?1, v.column1, v.column2, ?2, ?3, v.column3, ?6 FROM (VALUES ${values}) AS v
         WHERE NOT EXISTS (SELECT 1 FROM visits e WHERE e.user_id = ?1 AND e.url_id = v.column2 AND (
           (e.source = ?2 AND e.t BETWEEN v.column1 - ?4 AND v.column1 + ?4) OR
           (e.source <> ?2 AND e.t BETWEEN v.column1 - ?5 AND v.column1 + ?5)))`,
      ).bind(ctx.userId, SOURCE_LIVE, ctx.tokenId ?? null, RELOAD_SECS, SAME_VISIT_SECS, now(),
        ...chunk.flatMap((r) => [r.t, ids.get(r.url)!, r.priv])),
    );
  }
  let added = 0;
  for (const r of await env.DB.batch(stmts)) added += r.meta.changes || 0;
  return json({ ok: true, added });
}

/** GET /api/import/state: visits older than this (minus overlap) were already imported. */
export async function importState(env: Env, ctx: Ctx): Promise<Response> {
  const u = await env.DB.prepare("SELECT export_through FROM users WHERE id = ?").bind(ctx.userId).first<{ export_through: number | null }>();
  return json({ through: u?.export_through ?? null, overlap: 2 * 86400, batch: IMPORT_BATCH });
}

/** POST /api/import/batch: {visits: [{url, title, t}]} parsed from a Safari export by the browser. */
export async function importBatch(req: Request, env: Env, ctx: Ctx): Promise<Response> {
  const body = (await req.json().catch(() => null)) as { visits?: unknown } | null;
  const rows = cleanRows(body?.visits, IMPORT_BATCH, 0, now() + 86400);
  if (!rows.length) return json({ ok: true, added: 0 });
  const ids = await urlIds(env, ctx.userId, rows);
  const stmts: D1PreparedStatement[] = [];
  for (let i = 0; i < rows.length; i += 20) {
    const chunk = rows.slice(i, i + 20);
    stmts.push(
      env.DB.prepare(
        `INSERT OR IGNORE INTO visits (user_id, t, url_id, source, device, private, added)
         VALUES ${chunk.map(() => "(?, ?, ?, ?, NULL, 0, ?)").join(",")}`,
      ).bind(...chunk.flatMap((r) => [ctx.userId, r.t, ids.get(r.url)!, SOURCE_EXPORT, now()])),
    );
  }
  let added = 0;
  for (const r of await env.DB.batch(stmts)) added += r.meta.changes || 0;
  return json({ ok: true, added });
}

/** POST /api/import/finish: {t0, t1}. Drop live copies of visits the export now covers, and remember progress. */
export async function importFinish(req: Request, env: Env, ctx: Ctx): Promise<Response> {
  const b = (await req.json().catch(() => null)) as { t0?: number; t1?: number } | null;
  const t0 = Math.floor(Number(b?.t0)), t1 = Math.floor(Number(b?.t1));
  if (!(t0 > 0 && t1 >= t0)) throw new HttpError(400, "Bad range");
  const del = await env.DB.prepare(
    `DELETE FROM visits WHERE user_id = ?1 AND source = ?2 AND private = 0 AND t BETWEEN ?3 AND ?4
     AND EXISTS (SELECT 1 FROM visits e WHERE e.user_id = ?1 AND e.url_id = visits.url_id AND e.source = ?5
       AND e.t BETWEEN visits.t - ?6 AND visits.t + ?6)`,
  ).bind(ctx.userId, SOURCE_LIVE, t0 - SAME_VISIT_SECS, t1 + SAME_VISIT_SECS, SOURCE_EXPORT, SAME_VISIT_SECS).run();
  const merged = del.meta.changes || 0;
  await env.DB.prepare(
    `UPDATE users SET export_through = MAX(COALESCE(export_through, 0), ?), data_version = data_version + ? WHERE id = ?`,
  ).bind(t1, merged ? 1 : 0, ctx.userId).run();
  return json({ ok: true, merged });
}
