const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const fs = require("fs");

const FILMWEB_USER = process.env.FILMWEB_USER || "TheSeQuino";
const PORT = process.env.PORT || 7000;
const CACHE_FILE = process.env.CACHE_FILE || "./cache.json";
const REFRESH_MS = 24 * 60 * 60 * 1000; // raz dziennie
const HEADERS = {
  "User-Agent": "Mozilla/5.0 (compatible; filmweb-stremio/1.0)",
  Accept: "application/json",
};

// cache: { resolved: { "<filmwebId>": {id,type,name,poster,year} | null }, lists: { movie: [meta], series: [meta] } }
let cache = { resolved: {}, lists: { movie: [], series: [] }, lastRefresh: 0 };
try { cache = { ...cache, ...JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")) }; } catch {}
const save = () => { try { fs.writeFileSync(CACHE_FILE, JSON.stringify(cache)); } catch (e) { console.error("save:", e.message); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url) {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

// --- Filmweb (NIEOFICJALNE API - nazwy pól mogą wymagać korekty, patrz logi) ---
async function fetchWantList(kind /* film | serial */) {
  const data = await getJson(`https://www.filmweb.pl/api/v1/user/${FILMWEB_USER}/want2see/${kind}`);
  const arr = Array.isArray(data) ? data : data.items || data.results || [];
  return arr.map((x) => (typeof x === "object" ? x.entity ?? x.id ?? x.filmId : x)).filter(Boolean);
}

async function fetchFilmwebInfo(id) {
  for (const path of ["title", "film"]) {
    try {
      const d = await getJson(`https://www.filmweb.pl/api/v1/${path}/${id}/info`);
      return { title: d.title, original: d.originalTitle, year: d.year };
    } catch {}
  }
  return null;
}

// --- Dopasowanie do IMDb przez Cinemeta ---
const norm = (s) => (s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim();

async function resolveImdb(info, type) {
  const queries = [...new Set([info.original, info.title].filter(Boolean))];
  for (const q of queries) {
    try {
      const d = await getJson(`https://v3-cinemeta.strem.io/catalog/${type}/top/search=${encodeURIComponent(q)}.json`);
      const metas = d.metas || [];
      const year = Number(info.year);
      const hit =
        metas.find((m) => norm(m.name) === norm(q) && Math.abs(parseInt(m.releaseInfo || m.year) - year) <= 1) ||
        metas.find((m) => Math.abs(parseInt(m.releaseInfo || m.year) - year) <= 1 && norm(m.name).includes(norm(q)));
      if (hit) return { id: hit.imdb_id || hit.id, type, name: hit.name, poster: hit.poster, year: hit.releaseInfo || hit.year };
    } catch (e) { console.error("cinemeta:", e.message); }
    await sleep(200);
  }
  return null;
}

async function refresh() {
  console.log(new Date().toISOString(), "odświeżanie list Filmweb dla", FILMWEB_USER);
  for (const [kind, type] of [["film", "movie"], ["serial", "series"]]) {
    let ids;
    try { ids = await fetchWantList(kind); } catch (e) { console.error("lista", kind, e.message); continue; }
    console.log(kind, "– pozycji na liście:", ids.length);
    const metas = [];
    for (const id of ids) {
      if (!(id in cache.resolved)) {
        const info = await fetchFilmwebInfo(id);
        await sleep(400);
        cache.resolved[id] = info ? await resolveImdb(info, type) : null;
        if (!cache.resolved[id]) console.warn("niedopasowane:", id, info ? `${info.title} (${info.year})` : "(brak info)");
      }
      if (cache.resolved[id]) metas.push(cache.resolved[id]);
    }
    cache.lists[type] = metas;
    save();
  }
  cache.lastRefresh = Date.now();
  save();
}

// Leniwe odświeżanie: działa też na hostingu, który usypia aplikację.
let refreshing = null;
function ensureRefresh() {
  if (!refreshing) {
    refreshing = refresh().catch(console.error).finally(() => { refreshing = null; });
  }
  return refreshing;
}

// --- Stremio ---
const builder = new addonBuilder({
  id: "pl.filmweb.watchlist.personal",
  version: "1.0.0",
  name: "Filmweb – chcę zobaczyć",
  description: `Lista „chcę zobaczyć” z Filmweb (${FILMWEB_USER}), odświeżana raz dziennie`,
  resources: ["catalog"],
  types: ["movie", "series"],
  catalogs: [
    { type: "movie", id: "filmweb-want2see-film", name: "Filmweb – filmy" },
    { type: "series", id: "filmweb-want2see-serial", name: "Filmweb – seriale" },
  ],
});

builder.defineCatalogHandler(async ({ type }) => {
  const stale = Date.now() - cache.lastRefresh > REFRESH_MS;
  const empty = !(cache.lists[type] || []).length;
  if (stale || empty) {
    const job = ensureRefresh();
    // Jeśli nie mamy nic do pokazania, poczekaj (max 25 s); inaczej zwróć stary cache od razu.
    if (empty) await Promise.race([job, sleep(25000)]);
  }
  return { metas: cache.lists[type] || [] };
});

serveHTTP(builder.getInterface(), { port: PORT });
ensureRefresh();
