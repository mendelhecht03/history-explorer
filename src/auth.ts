import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { isoBase64URL } from "@simplewebauthn/server/helpers";
import { Env, HttpError, getCookie, json, now, randomId, sha256 } from "./util";

const SESSION_DAYS = 90;
const COOKIE = "hx";

export interface Ctx {
  userId: string;
  via: "session" | "token";
  tokenId?: string;
}

function sessionCookie(env: Env, value: string, maxAge: number) {
  const secure = env.ORIGIN.startsWith("https:") ? "; Secure" : "";
  return `${COOKIE}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure}`;
}

async function startSession(env: Env, userId: string): Promise<string> {
  const raw = randomId(32);
  await env.DB.prepare("INSERT INTO sessions (id_hash, user_id, expires) VALUES (?, ?, ?)")
    .bind(await sha256(raw), userId, now() + SESSION_DAYS * 86400)
    .run();
  return sessionCookie(env, raw, SESSION_DAYS * 86400);
}

/** Who is calling: a signed-in browser (cookie) or a device with an upload key (Bearer). */
export async function identify(req: Request, env: Env): Promise<Ctx | null> {
  const auth = req.headers.get("Authorization");
  if (auth?.startsWith("Bearer ")) {
    const row = await env.DB.prepare("SELECT id, user_id FROM tokens WHERE token_hash = ?")
      .bind(await sha256(auth.slice(7).trim()))
      .first<{ id: string; user_id: string }>();
    if (!row) return null;
    await env.DB.prepare("UPDATE tokens SET last_used = ? WHERE id = ?").bind(now(), row.id).run();
    return { userId: row.user_id, via: "token", tokenId: row.id };
  }
  const raw = getCookie(req, COOKIE);
  if (!raw) return null;
  const row = await env.DB.prepare("SELECT user_id FROM sessions WHERE id_hash = ? AND expires > ?")
    .bind(await sha256(raw), now())
    .first<{ user_id: string }>();
  return row ? { userId: row.user_id, via: "session" } : null;
}

/** Cookie-authenticated writes must come from our own pages (CSRF guard). */
export function checkOrigin(req: Request, env: Env) {
  if (req.method === "GET" || req.method === "HEAD") return;
  if (req.headers.get("Origin") !== env.ORIGIN) throw new HttpError(403, "Bad origin");
}

async function saveChallenge(env: Env, challenge: string, extra: { user_id?: string; name?: string } = {}) {
  const id = randomId();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM challenges WHERE expires < ?").bind(now()),
    env.DB.prepare("INSERT INTO challenges (id, challenge, user_id, name, expires) VALUES (?, ?, ?, ?, ?)")
      .bind(id, challenge, extra.user_id ?? null, extra.name ?? null, now() + 300),
  ]);
  return id;
}

async function takeChallenge(env: Env, id: unknown) {
  if (typeof id !== "string") throw new HttpError(400, "Missing challenge");
  const row = await env.DB.prepare("DELETE FROM challenges WHERE id = ? AND expires > ? RETURNING challenge, user_id, name")
    .bind(id, now())
    .first<{ challenge: string; user_id: string | null; name: string | null }>();
  if (!row) throw new HttpError(400, "Challenge expired, try again");
  return row;
}

/** Sign up (no ctx) or add another passkey to the signed-in account (ctx). */
export async function registerOptions(req: Request, env: Env, ctx: Ctx | null): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as { name?: string };
  let userId: string, name: string;
  const exclude: { id: string }[] = [];
  if (ctx) {
    const u = await env.DB.prepare("SELECT name FROM users WHERE id = ?").bind(ctx.userId).first<{ name: string }>();
    userId = ctx.userId;
    name = u!.name;
    const creds = await env.DB.prepare("SELECT id FROM credentials WHERE user_id = ?").bind(userId).all<{ id: string }>();
    exclude.push(...creds.results.map((c) => ({ id: c.id })));
  } else {
    name = String(body.name || "").trim().slice(0, 40);
    if (!name) throw new HttpError(400, "Pick a name for your account");
    userId = randomId(16);
  }
  const opts = await generateRegistrationOptions({
    rpName: env.RP_NAME,
    rpID: env.RP_ID,
    userName: name,
    userID: isoBase64URL.toBuffer(userId),
    attestationType: "none",
    excludeCredentials: exclude,
    authenticatorSelection: { residentKey: "required", userVerification: "preferred" },
  });
  const challengeId = await saveChallenge(env, opts.challenge, { user_id: userId, name });
  return json({ challengeId, options: opts });
}

export async function registerVerify(req: Request, env: Env, ctx: Ctx | null): Promise<Response> {
  const body = (await req.json()) as { challengeId: string; response: any };
  const ch = await takeChallenge(env, body.challengeId);
  if (ctx && ch.user_id !== ctx.userId) throw new HttpError(400, "Challenge mismatch");
  const v = await verifyRegistrationResponse({
    response: body.response,
    expectedChallenge: ch.challenge,
    expectedOrigin: env.ORIGIN,
    expectedRPID: env.RP_ID,
    requireUserVerification: false,
  });
  if (!v.verified || !v.registrationInfo) throw new HttpError(400, "Passkey could not be verified");
  const c = v.registrationInfo.credential;
  const stmts = [];
  let recovery: string | null = null;
  if (!ctx) {
    recovery = randomId(15);
    stmts.push(
      env.DB.prepare("INSERT INTO users (id, name, recovery_hash, created) VALUES (?, ?, ?, ?)")
        .bind(ch.user_id, ch.name, await sha256(recovery), now()),
    );
  }
  stmts.push(
    env.DB.prepare("INSERT INTO credentials (id, user_id, public_key, counter, transports, created) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(c.id, ch.user_id, isoBase64URL.fromBuffer(c.publicKey), c.counter, JSON.stringify(c.transports || []), now()),
  );
  await env.DB.batch(stmts);
  const headers: Record<string, string> = {};
  if (!ctx) headers["Set-Cookie"] = await startSession(env, ch.user_id!);
  return json({ ok: true, recoveryCode: recovery }, 200, headers);
}

export async function loginOptions(_req: Request, env: Env): Promise<Response> {
  const opts = await generateAuthenticationOptions({ rpID: env.RP_ID, userVerification: "preferred" });
  return json({ challengeId: await saveChallenge(env, opts.challenge), options: opts });
}

export async function loginVerify(req: Request, env: Env): Promise<Response> {
  const body = (await req.json()) as { challengeId: string; response: any };
  const ch = await takeChallenge(env, body.challengeId);
  const cred = await env.DB.prepare("SELECT id, user_id, public_key, counter, transports FROM credentials WHERE id = ?")
    .bind(String(body.response?.id || ""))
    .first<{ id: string; user_id: string; public_key: string; counter: number; transports: string }>();
  if (!cred) throw new HttpError(400, "This passkey isn't registered here");
  const v = await verifyAuthenticationResponse({
    response: body.response,
    expectedChallenge: ch.challenge,
    expectedOrigin: env.ORIGIN,
    expectedRPID: env.RP_ID,
    requireUserVerification: false,
    credential: {
      id: cred.id,
      publicKey: isoBase64URL.toBuffer(cred.public_key),
      counter: cred.counter,
      transports: JSON.parse(cred.transports || "[]"),
    },
  });
  if (!v.verified) throw new HttpError(400, "Sign-in failed");
  await env.DB.prepare("UPDATE credentials SET counter = ? WHERE id = ?").bind(v.authenticationInfo.newCounter, cred.id).run();
  return json({ ok: true }, 200, { "Set-Cookie": await startSession(env, cred.user_id) });
}

/** Recovery code signs you in once and is replaced; add a new passkey right after. */
export async function recover(req: Request, env: Env): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as { code?: string };
  const code = String(body.code || "").trim();
  if (!code) throw new HttpError(400, "Enter your recovery code");
  const u = await env.DB.prepare("SELECT id FROM users WHERE recovery_hash = ?").bind(await sha256(code)).first<{ id: string }>();
  if (!u) throw new HttpError(400, "That code doesn't match an account");
  const fresh = randomId(15);
  await env.DB.prepare("UPDATE users SET recovery_hash = ? WHERE id = ?").bind(await sha256(fresh), u.id).run();
  return json({ ok: true, recoveryCode: fresh }, 200, { "Set-Cookie": await startSession(env, u.id) });
}

export async function logout(req: Request, env: Env): Promise<Response> {
  const raw = getCookie(req, COOKIE);
  if (raw) await env.DB.prepare("DELETE FROM sessions WHERE id_hash = ?").bind(await sha256(raw)).run();
  return json({ ok: true }, 200, { "Set-Cookie": sessionCookie(env, "", 0) });
}
