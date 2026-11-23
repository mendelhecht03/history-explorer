import * as auth from "./auth";
import { dashboardData } from "./data";
import { importExport, liveVisits } from "./ingest";
import { userscript } from "./userscript";
import { Env, HttpError, json, now, randomId, sha256, text } from "./util";

const redirect = (to: string) => new Response(null, { status: 302, headers: { Location: to, "Cache-Control": "no-store" } });

async function handle(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const m = req.method;

  // ---- dashboard page: the original template with this user's data inlined ----
  if (m === "GET" && (path === "/" || path === "/index.html")) {
    const ctx = await auth.identify(req, env);
    if (!ctx || ctx.via !== "session") return redirect("/login.html");
    const data = await dashboardData(env, ctx.userId);
    if (!data.v.t.length) return redirect("/settings.html?welcome=1");
    const tpl = await (await env.ASSETS.fetch(new URL("/app.html", url))).text();
    const blob = JSON.stringify(data).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
    return text(tpl.replace("/*__DATA__*/null", () => blob), 200, "text/html; charset=utf-8");
  }

  // ---- userscript install link (10 minutes, opened in Safari so Userscripts offers to install it) ----
  const inst = path.match(/^\/install\/([\w-]+)\.user\.js$/);
  if (m === "GET" && inst) {
    const row = await env.DB.prepare("SELECT token FROM install_links WHERE id = ? AND expires > ?")
      .bind(inst[1], now()).first<{ token: string }>();
    if (!row) return text("This install link has expired. Make a new one in Settings.", 410);
    return text(userscript(env.ORIGIN, row.token), 200, "text/javascript; charset=utf-8");
  }

  if (!path.startsWith("/api/")) return env.ASSETS.fetch(req);

  // ---- sign-in (no account needed yet) ----
  if (m === "POST" && path.startsWith("/api/auth/")) {
    auth.checkOrigin(req, env);
    const ctx = await auth.identify(req, env);
    const sessionCtx = ctx?.via === "session" ? ctx : null;
    switch (path) {
      case "/api/auth/register/options": return auth.registerOptions(req, env, sessionCtx);
      case "/api/auth/register/verify": return auth.registerVerify(req, env, sessionCtx);
      case "/api/auth/login/options": return auth.loginOptions(req, env);
      case "/api/auth/login/verify": return auth.loginVerify(req, env);
      case "/api/auth/recover": return auth.recover(req, env);
      case "/api/auth/logout": return auth.logout(req, env);
    }
    throw new HttpError(404, "Not found");
  }

  const ctx = await auth.identify(req, env);
  if (!ctx) throw new HttpError(401, "Sign in first");

  // ---- device uploads (upload key or signed-in browser) ----
  if (m === "POST" && path === "/api/visits") {
    if (ctx.via !== "token") throw new HttpError(403, "Live visits need a device key");
    return liveVisits(req, env, ctx);
  }
  if (m === "POST" && path === "/api/import") {
    if (ctx.via === "session") auth.checkOrigin(req, env);
    return importExport(req, env, ctx);
  }

  // ---- everything else is for the signed-in browser only ----
  if (ctx.via !== "session") throw new HttpError(403, "Not allowed with a device key");
  auth.checkOrigin(req, env);
  const uid = ctx.userId;

  if (m === "GET" && path === "/api/me") {
    const [user, toks, stats, creds] = await env.DB.batch([
      env.DB.prepare("SELECT name, created FROM users WHERE id = ?").bind(uid),
      env.DB.prepare("SELECT id, name, created, last_used FROM tokens WHERE user_id = ? ORDER BY created").bind(uid),
      env.DB.prepare(`SELECT COUNT(*) AS visits, MIN(t) AS first, MAX(t) AS last,
                      SUM(source = 1) AS live, SUM(source = 2) AS exported,
                      MAX(CASE WHEN source = 1 THEN t END) AS last_live,
                      MAX(CASE WHEN source = 2 THEN t END) AS last_export
                      FROM visits WHERE user_id = ?`).bind(uid),
      env.DB.prepare("SELECT COUNT(*) AS n FROM credentials WHERE user_id = ?").bind(uid),
    ]);
    return json({ user: user.results[0], devices: toks.results, stats: stats.results[0], passkeys: (creds.results[0] as any).n });
  }

  if (m === "POST" && path === "/api/tokens") {
    const body = (await req.json().catch(() => ({}))) as { name?: string };
    const name = String(body.name || "iPhone").trim().slice(0, 40) || "iPhone";
    const id = randomId(9), token = "hx_" + randomId(30), link = randomId(18);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM install_links WHERE expires < ?").bind(now()),
      env.DB.prepare("INSERT INTO tokens (id, user_id, token_hash, name, created) VALUES (?, ?, ?, ?, ?)")
        .bind(id, uid, await sha256(token), name, now()),
      env.DB.prepare("INSERT INTO install_links (id, user_id, token, expires) VALUES (?, ?, ?, ?)")
        .bind(link, uid, token, now() + 600),
    ]);
    return json({ id, name, installUrl: `${env.ORIGIN}/install/${link}.user.js` });
  }
  const tok = path.match(/^\/api\/tokens\/([\w-]+)$/);
  if (m === "DELETE" && tok) {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM tokens WHERE id = ? AND user_id = ?").bind(tok[1], uid),
      env.DB.prepare("DELETE FROM install_links WHERE user_id = ?").bind(uid),
    ]);
    return json({ ok: true });
  }

  if (path === "/api/lists") {
    if (m === "GET") {
      const row = await env.DB.prepare("SELECT data FROM lists WHERE user_id = ?").bind(uid).first<{ data: string }>();
      return text(row?.data ?? "null", 200, "application/json");
    }
    if (m === "PUT") {
      const b = (await req.json().catch(() => null)) as any;
      const clean = (a: unknown) => (Array.isArray(a) ? a : []).filter((x) => typeof x === "string" && x.length < 256).slice(0, 20000);
      const data = JSON.stringify({ block: clean(b?.block), allow: clean(b?.allow), dismissed: clean(b?.dismissed) });
      await env.DB.prepare("INSERT INTO lists (user_id, data) VALUES (?, ?) ON CONFLICT (user_id) DO UPDATE SET data = excluded.data")
        .bind(uid, data).run();
      return json({ ok: true });
    }
  }

  if (m === "POST" && path === "/api/history/delete") {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM visits WHERE user_id = ?").bind(uid),
      env.DB.prepare("DELETE FROM urls WHERE user_id = ?").bind(uid),
    ]);
    return json({ ok: true });
  }
  if (m === "POST" && path === "/api/account/delete") {
    // Delete children explicitly too, in case foreign keys are not enforced.
    await env.DB.batch(
      ["visits", "urls", "lists", "tokens", "install_links", "sessions", "credentials"].map((t) =>
        env.DB.prepare(`DELETE FROM ${t} WHERE user_id = ?`).bind(uid),
      ).concat(env.DB.prepare("DELETE FROM users WHERE id = ?").bind(uid)),
    );
    return json({ ok: true }, 200, { "Set-Cookie": "hx=; Path=/; Max-Age=0" });
  }

  throw new HttpError(404, "Not found");
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    try {
      return await handle(req, env);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      console.error(e);
      return json({ error: "Something went wrong" }, 500);
    }
  },
} satisfies ExportedHandler<Env>;
