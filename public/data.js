// Loads this account's history into the browser and builds the data shape the dashboard
// (app.html) was written against. A copy is kept in IndexedDB so later visits only fetch
// what's new; it is cleared on sign-out or when the server says history was deleted.
"use strict";

const ENGINES = [
  [/(^|\.)google\.[a-z.]+$/, "/search", "q", "Google"],
  [/(^|\.)bing\.com$/, "/search", "q", "Bing"],
  [/(^|\.)duckduckgo\.com$/, null, "q", "DuckDuckGo"],
  [/(^|\.)search\.brave\.com$/, "/search", "q", "Brave"],
  [/(^|\.)search\.yahoo\.com$/, "/search", "p", "Yahoo"],
  [/(^|\.)youtube\.com$/, "/results", "search_query", "YouTube"],
  [/(^|\.)amazon\.[a-z.]+$/, "/s", "k", "Amazon"],
  [/(^|\.)ebay\.[a-z.]+$/, "/sch/", "_nkw", "eBay"],
  [/(^|\.)reddit\.com$/, "/search", "q", "Reddit"],
  [/(^|\.)wikipedia\.org$/, null, "search", "Wikipedia"],
  [/(^|\.)github\.com$/, "/search", "q", "GitHub"],
  [/(^|\.)(x|twitter)\.com$/, "/search", "q", "X"],
  [/(^|\.)perplexity\.ai$/, "/search", "q", "Perplexity"],
  [/(^|\.)chatgpt\.com$/, null, "q", "ChatGPT"],
  [/(^|\.)tiktok\.com$/, "/search", "q", "TikTok"],
  [/(^|\.)instagram\.com$/, "/explore/search", "q", "Instagram"],
  [/(^|\.)pinterest\.[a-z.]+$/, "/search", "q", "Pinterest"],
  [/(^|\.)etsy\.com$/, "/search", "q", "Etsy"],
  [/(^|\.)walmart\.com$/, "/search", "q", "Walmart"],
  [/(^|\.)maps\.google\.[a-z.]+$/, "/maps/search", null, "Google Maps"],
];

function findSearch(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  const host = u.hostname.toLowerCase();
  for (const [hre, path, param, name] of ENGINES) {
    if (!hre.test(host) || (path && !u.pathname.startsWith(path))) continue;
    let term;
    if (param === null) {
      const rest = u.pathname.slice((path || "").length).replace(/^\/+/, "").split("/")[0];
      try { term = decodeURIComponent(rest.replace(/\+/g, " ")); } catch { term = rest; }
    } else term = u.searchParams.get(param) || "";
    term = term.trim();
    return term && term.length < 300 ? [name, term] : null;
  }
  return null;
}

function cleanHost(url) {
  try { const h = new URL(url).hostname.toLowerCase(); return h.startsWith("www.") ? h.slice(4) : h; } catch { return ""; }
}

// ---- tiny IndexedDB key-value store ----
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open("history-explorer", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("kv");
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function kv(mode, fn) {
  const db = await idb();
  return new Promise((res, rej) => {
    const tx = db.transaction("kv", mode), st = tx.objectStore("kv"), req = fn(st);
    tx.oncomplete = () => res(req && req.result);
    tx.onerror = () => rej(tx.error);
  });
}
const cacheGet = (k) => kv("readonly", (s) => s.get(k)).catch(() => null);
const cacheSet = (k, v) => kv("readwrite", (s) => s.put(v, k)).catch(() => {});
const cacheClear = () => kv("readwrite", (s) => s.clear()).catch(() => {});

async function getJSON(path) {
  const r = await fetch(path, { credentials: "same-origin" });
  if (r.status === 401) { await cacheClear(); location.href = "/login.html"; throw new Error("signed out"); }
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `Request failed (${r.status})`);
  return r.json();
}

async function syncHistory(progress = () => {}) {
  const me = await getJSON("/api/me");
  const key = "user:" + me.user.id;
  let c = await cacheGet(key);
  if (!c || c.version !== me.user.data_version) {
    c = { version: me.user.data_version, urlAfter: 0, cur: [0, 0, 0], urls: {}, v: [] };
  }
  let more = true;
  while (more) {
    const r = await getJSON(`/api/sync/urls?after=${c.urlAfter}`);
    for (const [id, url, title] of r.rows) c.urls[id] = [url, title];
    if (r.rows.length) c.urlAfter = r.rows[r.rows.length - 1][0];
    more = r.more;
  }
  const seen = new Set(c.v.map((x) => x[0] + ":" + x[1]));
  more = true;
  while (more) {
    const [a, t, u] = c.cur;
    const r = await getJSON(`/api/sync/visits?a=${a}&t=${t}&u=${u}`);
    for (const [added, vt, uid, src, dev, priv] of r.rows) {
      const k = vt + ":" + uid;
      if (!seen.has(k)) { seen.add(k); c.v.push([vt, uid, src, dev, priv]); }
    }
    if (r.rows.length) { const l = r.rows[r.rows.length - 1]; c.cur = [l[0], l[1], l[2]]; }
    more = r.more;
    progress(c.v.length);
  }
  await cacheSet(key, c);
  return { me, c };
}

/** Returns D in the shape template.html expects. */
async function loadData(progress) {
  const { me, c } = await syncHistory(progress);
  const hosts = [], hostIdx = new Map(), urls = [], urlIdx = new Map();
  const devices = [], devIdx = new Map();
  const names = new Map(me.devices.map((d) => [d.id, d.name]));
  const dev = (k, name) => { if (!devIdx.has(k)) devIdx.set(k, devices.push({ name, kind: "phone" }) - 1); return devIdx.get(k); };
  const v = { t: [], u: [], d: [], dev: [], p: [] };
  const profiles = [], profIdx = new Map();
  const prof = (n) => { if (!profIdx.has(n)) profIdx.set(n, profiles.push(n) - 1); return profIdx.get(n); };
  const rows = c.v.slice().sort((x, y) => x[0] - y[0]);
  for (const [t, uid, src, device, priv] of rows) {
    const rec = c.urls[uid];
    if (!rec) continue;
    if (!urlIdx.has(uid)) {
      const h = cleanHost(rec[0]);
      if (!hostIdx.has(h)) hostIdx.set(h, hosts.push(h) - 1);
      urlIdx.set(uid, urls.push([rec[0], rec[1], hostIdx.get(h)]) - 1);
    }
    let di;
    if (src === 2) di = dev("export", "Safari (export)");
    else if (src === 3) {
      const [tok, synced] = String(device || "").split("/");
      di = synced ? dev("chrome-synced", "Chrome on other devices") : dev(device, `${names.get(tok) || "Removed computer"} (Chrome)`);
    } else di = dev(device || "live", `${names.get(device) || "Removed device"} (live)`);
    v.t.push(t); v.u.push(urlIdx.get(uid)); v.d.push(0); v.dev.push(di);
    v.p.push(prof(src === 3 ? "Chrome" : priv ? "Safari Private Browsing" : "Safari"));
  }
  const engines = [], engIdx = new Map(), last = new Map(), parsed = new Map();
  const s = { t: [], term: [], e: [], dev: [], p: [], u: [] };
  for (let i = 0; i < v.t.length; i++) {
    const ui = v.u[i];
    if (!parsed.has(ui)) parsed.set(ui, findSearch(urls[ui][0]));
    const fs = parsed.get(ui);
    if (!fs) continue;
    const [eng, term] = fs, k = term.toLowerCase() + "\u0000" + v.dev[i], t = v.t[i], prev = last.get(k);
    last.set(k, t);
    if (prev !== undefined && t - prev < 180) continue; // same search reloaded or paged
    if (!engIdx.has(eng)) engIdx.set(eng, engines.push(eng) - 1);
    s.t.push(t); s.term.push(term); s.e.push(engIdx.get(eng)); s.dev.push(v.dev[i]); s.p.push(v.p[i]); s.u.push(ui);
  }
  return {
    generated: Math.floor(Date.now() / 1000),
    profiles,
    devices, hosts, icons: {}, urls, engines, v, s,
  };
}
