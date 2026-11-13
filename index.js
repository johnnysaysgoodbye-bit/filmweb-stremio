const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const fs = require("fs");

const FILMWEB_USER = process.env.FILMWEB_USER || "TheSeQuino";
const TMDB_KEY = (process.env.TMDB_API_KEY || "").trim(); // klucz v3 (krótki) albo token v4 (zaczyna się od "eyJ")
const PORT = process.env.PORT || 7000;
const CACHE_FILE = process.env.CACHE_FILE || "./cache.json";
const REFRESH_MS = Number(process.env.REFRESH_HOURS || 24) * 60 * 60 * 1000; // domyślnie raz dziennie
const ENRICH_VERSION = 2; // podbij, żeby wymusić ponowne pobranie danych z TMDB
const HEADERS = {
  "User-Agent": "Mozilla/5.0 (compatible; filmweb-stremio/1.2)",
  Accept: "application/json",
};

// cache: { resolved: { "<filmwebId>": meta }, lists: { movie: [meta], series: [meta] }, lastRefresh }
// Do cache trafiają tylko UDANE dopasowania - nieudane są ponawiane przy każdym odświeżeniu.
let cache = { resolved: {}, lists: { movie: [], series: [] }, lastRefresh: 0 };
try { cache = { ...cache, ...JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")) }; } catch {}
const save = () => { try { fs.writeFileSync(CACHE_FILE, JSON.stringify(cache)); } catch (e) { console.error("save:", e.message); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, retries = 2, headers = HEADERS) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, { headers });
      if (res.ok) return await res.json();
      lastErr = new Error(`${res.status} ${url.replace(/api_key=[^&]+/, "api_key=***")}`);
      if (res.status === 404) break; // nie ma sensu ponawiać
    } catch (e) { lastErr = e; }
    await sleep(800 * (i + 1));
  }
  throw lastErr;
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
      const d = await getJson(`https://www.filmweb.pl/api/v1/${path}/${id}/info`, 1);
      return { title: d.title, original: d.originalTitle, year: d.year };
    } catch {}
  }
  return null;
}

// --- Dopasowanie do IMDb przez Cinemeta ---
const norm = (s) => (s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/ł/g, "l").replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim();
const yearOf = (m) => parseInt(m.releaseInfo || m.year);

function pick(metas, q, year) {
  const nq = norm(q);
  const near = (m, d) => !year || isNaN(yearOf(m)) || Math.abs(yearOf(m) - year) <= d;
  return (
    metas.find((m) => norm(m.name) === nq && near(m, 1)) ||
    metas.find((m) => norm(m.name).includes(nq) && near(m, 1)) ||
    metas.find((m) => nq.includes(norm(m.name)) && norm(m.name).length > 3 && near(m, 1)) ||
    metas.find((m) => norm(m.name) === nq && near(m, 3)) ||
    // ostatnia deska ratunku: dokładny rok i jedyny wynik
    (metas.length === 1 && year && yearOf(metas[0]) === year ? metas[0] : null)
  );
}

// Zapasowe źródło: wyszukiwarka podpowiedzi IMDb (zna też tytuły w oryginale i alternatywne).
const FOLD = (s) => (s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/ł/g, "l").replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
async function imdbSuggest(q, type, year) {
  const f = FOLD(q);
  if (!f) return null;
  const letter = /^[a-z0-9]/.test(f) ? f[0] : "x";
  const okKinds = type === "movie" ? ["movie", "tvMovie", "video", "short"] : ["tvSeries", "tvMiniSeries"];
  try {
    const d = await getJson(`https://v2.sg.media-imdb.com/suggestion/${letter}/${encodeURIComponent(f)}.json`, 1);
    const hit = (d.d || []).find(
      (x) => /^tt/.test(x.id || "") && okKinds.includes(x.qid) && (!year || !x.y || Math.abs(x.y - year) <= 1)
    );
    if (hit) return { id: hit.id, type, name: hit.l, poster: hit.i?.imageUrl || `https://images.metahub.space/poster/small/${hit.id}/img`, year: hit.y };
  } catch (e) { console.error("imdb-suggest:", e.message); }
  return null;
}

async function resolveImdb(info, type) {
  const year = Number(info.year) || null;
  const variants = [];
  for (const t of [info.original, info.title]) {
    if (!t) continue;
    variants.push(t);
    const short = t.split(/\s*[:–—-]\s+/)[0];
    if (short && short !== t && short.length > 3) variants.push(short);
  }
  for (const q of [...new Set(variants)]) {
    try {
      const d = await getJson(`https://v3-cinemeta.strem.io/catalog/${type}/top/search=${encodeURIComponent(q)}.json`, 1);
      const hit = pick(d.metas || [], q, year);
      if (hit) return { id: hit.imdb_id || hit.id, type, name: hit.name, poster: hit.poster, year: hit.releaseInfo || hit.year, imdbRating: hit.imdbRating };
    } catch (e) { console.error("cinemeta:", e.message); }
    await sleep(200);
  }
  // Cinemeta nie znalazła (częste dla filmów zagranicznych/klasyków) - spróbuj przez IMDb
  for (const q of [...new Set(variants)]) {
    const hit = await imdbSuggest(q, type, year);
    if (hit) return hit;
    await sleep(200);
  }
  return null;
}

// --- TMDB: polskie metadane (tytuł, opis, plakat, tło, gatunki, obsada...) ---
const IMG = "https://image.tmdb.org/t/p";
function tmdbGet(path, params = "") {
  const isToken = TMDB_KEY.startsWith("eyJ");
  const url = `https://api.themoviedb.org/3${path}?language=pl-PL${params}${isToken ? "" : `&api_key=${TMDB_KEY}`}`;
  const headers = isToken ? { ...HEADERS, Authorization: `Bearer ${TMDB_KEY}` } : HEADERS;
  return getJson(url, 1, headers);
}
const fmtRuntime = (m) => (m ? (m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}min` : `${m}min`) : undefined);

async function enrich(meta) {
  if (!TMDB_KEY || !/^tt/.test(meta.id || "")) return meta;
  try {
    const f = await tmdbGet(`/find/${meta.id}`, "&external_source=imdb_id");
    let kind = meta.type === "movie" ? "movie" : "tv";
    let found = (kind === "movie" ? f.movie_results : f.tv_results) || [];
    if (!found.length) {
      kind = kind === "movie" ? "tv" : "movie";
      found = (kind === "movie" ? f.movie_results : f.tv_results) || [];
    }
    if (!found.length) { console.warn("TMDB: brak dla", meta.id, meta.name); return meta; }

    const d = await tmdbGet(`/${kind}/${found[0].id}`, "&append_to_response=credits,images&include_image_language=pl,en,null");
    const posters = d.images?.posters || [];
    const logos = d.images?.logos || [];
    const plPoster = posters.find((p) => p.iso_639_1 === "pl")?.file_path;
    const poster = plPoster || d.poster_path;
    const logo = (logos.find((l) => l.iso_639_1 === "pl") || logos.find((l) => l.iso_639_1 === "en") || logos[0])?.file_path;
    const date = d.release_date || d.first_air_date || "";
    const runtime = kind === "movie" ? d.runtime : (d.episode_run_time || [])[0];
    const directors = (d.credits?.crew || []).filter((c) => c.job === "Director").map((c) => c.name);

    let imdbRating = meta.imdbRating;
    if (!imdbRating) {
      try {
        const cm = await getJson(`https://v3-cinemeta.strem.io/meta/${meta.type}/${meta.id}.json`, 0);
        imdbRating = cm.meta?.imdbRating;
      } catch {}
    }

    return {
      ...meta,
      name: d.title || d.name || meta.name,
      poster: poster ? `${IMG}/w500${poster}` : meta.poster,
      posterShape: "poster",
      background: d.backdrop_path ? `${IMG}/w1280${d.backdrop_path}` : undefined,
      logo: logo ? `${IMG}/w500${logo}` : undefined,
      description: d.overview || undefined,
      genres: (d.genres || []).map((g) => g.name),
      runtime: fmtRuntime(runtime),
      releaseInfo: date ? date.slice(0, 4) : meta.releaseInfo || meta.year,
      released: date ? new Date(date).toISOString() : undefined,
      imdbRating: imdbRating ? String(imdbRating) : undefined,
      cast: (d.credits?.cast || []).slice(0, 6).map((c) => c.name),
      director: directors.length ? directors : undefined,
      v: ENRICH_VERSION,
    };
  } catch (e) {
    console.warn("TMDB błąd:", meta.id, meta.name, e.message);
    return meta;
  }
}

async function refresh() {
  console.log(new Date().toISOString(), "odświeżanie list Filmweb dla", FILMWEB_USER, TMDB_KEY ? "(z TMDB)" : "(BEZ TMDB - ustaw TMDB_API_KEY)");
  for (const [kind, type] of [["film", "movie"], ["serial", "series"]]) {
    let ids;
    try { ids = await fetchWantList(kind); } catch (e) { console.error("lista", kind, e.message); continue; }
    console.log(kind, "– pozycji na liście:", ids.length);
    const metas = [];
    const missed = [];
    for (const id of ids) {
      let meta = cache.resolved[id];
      if (!meta) {
        const info = await fetchFilmwebInfo(id);
        await sleep(300);
        meta = info ? await resolveImdb(info, type) : null;
        if (!meta) missed.push(`${id}: ${info ? `${info.title} / ${info.original} (${info.year})` : "(brak danych z Filmwebu)"}`);
      }
      if (meta && TMDB_KEY && meta.v !== ENRICH_VERSION) {
        meta = await enrich(meta);
        await sleep(150);
      }
      if (meta) {
        cache.resolved[id] = meta;
        metas.push(meta);
        cache.lists[type] = [...metas]; // lista rośnie na bieżąco
      }
    }
    cache.lists[type] = metas;
    const enriched = metas.filter((m) => m.v === ENRICH_VERSION).length;
    console.log(kind, `– dopasowano ${metas.length}/${ids.length}` + (TMDB_KEY ? `, z danymi TMDB: ${enriched}` : ""));
    if (missed.length) console.warn("NIEDOPASOWANE", kind + ":\n  " + missed.join("\n  "));
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
  version: "1.2.0",
  name: "Filmweb",
  description: `Lista „chcę zobaczyć” z Filmweb (${FILMWEB_USER}), odświeżana raz dziennie`,
  resources: ["catalog"],
  types: ["movie", "series"],
  catalogs: [
    { type: "movie", id: "filmweb-want2see-film", name: "Filmweb" },
    { type: "series", id: "filmweb-want2see-serial", name: "Filmweb" },
  ],
});

builder.defineCatalogHandler(async ({ type }) => {
  const stale = Date.now() - cache.lastRefresh > REFRESH_MS;
  const empty = !(cache.lists[type] || []).length;
  if (stale || empty) {
    const job = ensureRefresh();
    if (empty) await Promise.race([job, sleep(25000)]);
  }
  return { metas: cache.lists[type] || [] };
});

serveHTTP(builder.getInterface(), { port: PORT });
ensureRefresh();
// Co godzinę sprawdź, czy dane są starsze niż REFRESH_MS - niezależnie od tego, czy ktoś otwiera katalog.
setInterval(() => { if (Date.now() - cache.lastRefresh > REFRESH_MS) ensureRefresh(); }, 60 * 60 * 1000);
