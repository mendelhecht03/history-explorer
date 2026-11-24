/** The live-sync script that runs inside the free "Userscripts" Safari extension. */
export function userscript(origin: string, token: string): string {
  const host = new URL(origin).hostname;
  return `// ==UserScript==
// @name         History Explorer live sync
// @namespace    ${origin}
// @version      1.0
// @description  Sends each page you open (link, title, time) to your History Explorer account.
// @match        *://*/*
// @exclude      ${origin}/*
// @run-at       document-end
// @noframes
// @grant        GM.xmlHttpRequest
// @grant        GM.getValue
// @grant        GM.setValue
// @connect      ${host}
// ==/UserScript==

(async () => {
  const API = ${JSON.stringify(origin + "/api/visits")};
  const KEY = ${JSON.stringify(token)};
  const MAX_QUEUE = 5000;
  let sending = false;

  async function load() { try { return JSON.parse(await GM.getValue("queue", "[]")); } catch { return []; } }
  async function save(q) { await GM.setValue("queue", JSON.stringify(q.slice(-MAX_QUEUE))); }

  async function record() {
    const url = location.href;
    if (!/^https?:/.test(url)) return;
    const q = await load();
    const t = Math.floor(Date.now() / 1000);
    const prev = q[q.length - 1];
    if (prev && prev.url === url && t - prev.t < 30) return;
    q.push({ url, title: document.title || "", t });
    await save(q);
    flush();
  }

  function post(batch) {
    return new Promise((resolve) => {
      GM.xmlHttpRequest({
        method: "POST",
        url: API,
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + KEY },
        data: JSON.stringify({ visits: batch }),
        timeout: 15000,
        onload: (r) => resolve(r.status >= 200 && r.status < 300 ? "ok" : r.status === 401 ? "revoked" : "retry"),
        onerror: () => resolve("retry"),
        ontimeout: () => resolve("retry"),
      });
    });
  }

  async function flush() {
    if (sending) return;
    sending = true;
    try {
      for (let i = 0; i < 20; i++) {
        const q = await load();
        if (!q.length) break;
        const batch = q.slice(0, 100);
        const res = await post(batch);
        if (res === "retry") break; // offline or server down: keep the queue and try on the next page
        const sent = new Set(batch.map((v) => v.t + " " + v.url));
        await save((await load()).filter((v) => !sent.has(v.t + " " + v.url)));
        if (res === "revoked") break;
      }
    } finally {
      sending = false;
    }
  }

  // First load, then in-page navigations (single-page sites change the URL without reloading).
  setTimeout(record, 1000);
  let last = location.href;
  setInterval(() => {
    if (document.visibilityState !== "visible" || location.href === last) return;
    last = location.href;
    setTimeout(record, 1000);
  }, 1000);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flush(); });
})();
`;
}
