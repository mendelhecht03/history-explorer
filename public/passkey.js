// Minimal WebAuthn helpers: JSON options from the server <-> browser credential objects.
const b64u = {
  dec: (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=")), (c) => c.charCodeAt(0)).buffer,
  enc: (b) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
};

async function api(path, body, method = "POST") {
  const r = await fetch(path, {
    method,
    headers: body instanceof Blob ? {} : { "Content-Type": "application/json" },
    body: body instanceof Blob ? body : body === undefined ? undefined : JSON.stringify(body),
    credentials: "same-origin",
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `Request failed (${r.status})`);
  return d;
}

function credToJSON(c) {
  const r = c.response, out = { id: c.id, rawId: b64u.enc(c.rawId), type: c.type, clientExtensionResults: c.getClientExtensionResults(), authenticatorAttachment: c.authenticatorAttachment, response: { clientDataJSON: b64u.enc(r.clientDataJSON) } };
  if (r.attestationObject) {
    out.response.attestationObject = b64u.enc(r.attestationObject);
    out.response.transports = r.getTransports ? r.getTransports() : [];
  } else {
    out.response.authenticatorData = b64u.enc(r.authenticatorData);
    out.response.signature = b64u.enc(r.signature);
    if (r.userHandle) out.response.userHandle = b64u.enc(r.userHandle);
  }
  return out;
}

async function createPasskey(name) {
  const { challengeId, options: o } = await api("/api/auth/register/options", { name });
  const cred = await navigator.credentials.create({
    publicKey: {
      ...o,
      challenge: b64u.dec(o.challenge),
      user: { ...o.user, id: b64u.dec(o.user.id) },
      excludeCredentials: (o.excludeCredentials || []).map((c) => ({ ...c, id: b64u.dec(c.id) })),
    },
  });
  return api("/api/auth/register/verify", { challengeId, response: credToJSON(cred) });
}

async function usePasskey() {
  const { challengeId, options: o } = await api("/api/auth/login/options", {});
  const cred = await navigator.credentials.get({
    publicKey: { ...o, challenge: b64u.dec(o.challenge), allowCredentials: (o.allowCredentials || []).map((c) => ({ ...c, id: b64u.dec(c.id) })) },
  });
  return api("/api/auth/login/verify", { challengeId, response: credToJSON(cred) });
}
