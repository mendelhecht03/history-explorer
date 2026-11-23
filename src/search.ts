// Ported from build.py: recognise searches from search-engine URLs.
const ENGINES: [RegExp, string | null, string | null, string][] = [
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

export function findSearch(url: string): [string, string] | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  for (const [hre, path, param, name] of ENGINES) {
    if (!hre.test(host)) continue;
    if (path && !u.pathname.startsWith(path)) continue;
    let term: string;
    if (param === null) {
      const rest = u.pathname.slice((path || "").length).replace(/^\/+/, "").split("/")[0];
      try {
        term = decodeURIComponent(rest.replace(/\+/g, " "));
      } catch {
        term = rest;
      }
    } else {
      term = u.searchParams.get(param) || "";
    }
    term = term.trim();
    return term && term.length < 300 ? [name, term] : null;
  }
  return null;
}

export function cleanHost(url: string): string {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return h.startsWith("www.") ? h.slice(4) : h;
  } catch {
    return "";
  }
}
