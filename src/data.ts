import { Env, HttpError } from "./util";

// The browser keeps its own copy of the history (IndexedDB) and asks only for what's new,
// in pages small enough for the Workers free plan. Search detection and stats run in the browser.
const VISIT_PAGE = 5000;
const URL_PAGE = 2000;

const int = (v: string | null, d = 0) => {
  const n = Math.floor(Number(v ?? d));
  if (!Number.isFinite(n) || n < 0) throw new HttpError(400, "Bad cursor");
  return n;
};

/** GET /api/sync/urls?after=<id> -> {rows: [[id, url, title]], more} */
export async function syncUrls(url: URL, env: Env, userId: string) {
  const res = await env.DB.prepare("SELECT id, url, title FROM urls WHERE user_id = ? AND id > ? ORDER BY id LIMIT ?")
    .bind(userId, int(url.searchParams.get("after")), URL_PAGE).raw();
  return { rows: res, more: res.length === URL_PAGE };
}

/** GET /api/sync/visits?a=<added>&t=<t>&u=<url_id> -> {rows: [[added, t, url_id, source, device, private]], more} */
export async function syncVisits(url: URL, env: Env, userId: string) {
  const q = url.searchParams;
  const a = int(q.get("a")), t = int(q.get("t")), u = int(q.get("u"));
  const res = await env.DB.prepare(
    `SELECT added, t, url_id, source, device, private FROM visits
     WHERE user_id = ?1 AND (added > ?2 OR (added = ?2 AND (t > ?3 OR (t = ?3 AND url_id > ?4))))
     ORDER BY added, t, url_id LIMIT ?5`,
  ).bind(userId, a, t, u, VISIT_PAGE).raw();
  return { rows: res, more: res.length === VISIT_PAGE };
}
