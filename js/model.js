// Season data and user settings: validation, ratings, and turning both into
// the compact input the simulator runs on. Shared by the page, the worker,
// the data-update script, and the tests.

export const SEASON_FORMAT = "fbs-sim-season";
export const STATE_FORMAT = "fbs-sim-state";
export const SOURCE_LABELS = {sheet: "Ratings sheet", sp: "SP+", fpi: "FPI", elo: "Elo", srs: "SRS", score: "Results model"};
// Preference order when the source is "auto": SP+ first.
export const SOURCE_ORDER = ["sp", "sheet", "fpi", "elo", "srs"];
export const CONF_ORDER = ["SEC", "Big Ten", "ACC", "Big 12", "American Athletic", "Mountain West", "Pac-12",
  "Sun Belt", "Mid-American", "Conference USA", "FBS Independents"];
export const FORMATS = ["top2", "divisions", "first", "none"];

// Defaults tuned by the 2024–25 backtest (scripts/backtest.mjs). Bump
// DEFAULTS_VERSION when they change so saved settings pick up the new ones.
export const DEFAULTS_VERSION = 2;
export const DEF_SETTINGS = {N: 10000, seed: 1, hfa: 3, gsd: 14.4, rsd: 5, source: "auto", fcs: -30, priorW: 3, cap: 28};
// model "sor": committee score = rating + sorW × strength of record.
// model "losses": rating − lossPen × losses + sosW × average opponent rating.
// titleLossW: how much a conference title-game loss counts (0 = ignored,
// 1 = a full loss). h2hWin: committee-score gap within which a team that
// won the head-to-head game moves ahead. seeding "champs" gives the byes to
// the top-ranked conference champions (the 2024 rule).
export const DEF_CFP = {field: 12, byes: 4, autoBids: 5, model: "sor", sorW: 9, lossPen: 8, champBonus: 6, sosW: 1, indSD: 2.5,
  titleLossW: 0, h2hWin: 6, seeding: "straight"};
export const CFP_MODELS = ["sor", "losses"];
export const SEEDINGS = ["straight", "champs"];

// Conference tiebreaker steps, in order (see makeRanker in sim.js). These
// follow each conference's published procedure as best we know it; the
// computer-ranking steps conferences use are approximated by "metric", and
// CFP-ranking steps by "rank". A season file can override any conference
// with a "tiebreak" list.
export const TIEBREAK_STEPS = ["h2h", "common", "tiers", "oppStrength", "totalWins", "rank", "metric"];
export const DEFAULT_TIEBREAK = ["h2h", "common", "tiers", "oppStrength", "metric"];
export const CONF_TIEBREAKS = {
  "SEC": DEFAULT_TIEBREAK,
  "Big Ten": DEFAULT_TIEBREAK,
  "ACC": DEFAULT_TIEBREAK,
  "Big 12": ["h2h", "common", "tiers", "oppStrength", "totalWins", "metric"],
  "Sun Belt": ["h2h", "common", "tiers", "rank", "metric"],
  "American Athletic": ["h2h", "common", "rank", "metric"],
  "Mountain West": ["h2h", "common", "rank", "metric"],
  "Pac-12": ["h2h", "common", "rank", "metric"],
  "Mid-American": ["h2h", "common", "rank", "metric"],
  "Conference USA": ["h2h", "common", "rank", "metric"]
};
export const SORT_KEYS = ["name", "conf", "rating", "rec", "proj", "projc", "t2", "ch", "cfp", "bye", "natl"];

// [min, max, integer?]
const LIMITS = {
  N: [100, 200000, true], seed: [0, 2147483647, true], hfa: [-10, 15], gsd: [0, 40], rsd: [0, 20], fcs: [-60, 30],
  priorW: [0.5, 50], cap: [1, 100], field: [2, 32, true], byes: [0, 31, true], autoBids: [0, 32, true],
  lossPen: [0, 40], sorW: [0, 30], champBonus: [-20, 40], sosW: [-5, 5], indSD: [0, 30],
  titleLossW: [0, 1], h2hWin: [0, 30]
};
const RATING_MAX = 80;

const isNum = x => typeof x === "number" && Number.isFinite(x);
const str = x => typeof x === "string" ? x.trim() : "";
const SOURCE_RE = /^[a-z0-9_]{1,16}$/;

export function phi(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x)), d = 0.3989423 * Math.exp(-x * x / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - p : p;
}

// Chance a team rated `bench` beats an opponent rated `opp`, with `adj`
// points of home field (negative on the road).
export function benchWinProb(bench, opp, adj, sd) {
  const x = bench - opp + adj;
  return sd > 0 ? phi(x / sd) : x > 0 ? 1 : x < 0 ? 0 : 0.5;
}

export function computeWeek(games) {
  let lo = Infinity, hi = 0;
  for (const g of games) {
    hi = Math.max(hi, g.week);
    if (g.hp == null) lo = Math.min(lo, g.week);
  }
  return lo === Infinity ? hi + 1 : lo;
}

export function confRank(name) {
  const k = CONF_ORDER.indexOf(name);
  return k < 0 ? CONF_ORDER.length - 1 : k;
}

function cleanRatings(raw, ids) {
  const out = {};
  if (!raw || typeof raw !== "object") return out;
  for (const src of Object.keys(raw)) {
    if (!SOURCE_RE.test(src) || src === "score" || !raw[src] || typeof raw[src] !== "object") continue;
    const vals = {};
    for (const [id, v] of Object.entries(raw[src])) if (ids.has(id) && isNum(v) && Math.abs(v) <= RATING_MAX) vals[id] = v;
    if (Object.keys(vals).length) out[src] = vals;
  }
  return out;
}

// Checks a season file and returns a cleaned copy. Throws when the file is
// unusable; skips individual bad teams or games and reports them as warnings.
export function validateSeason(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("the file isn't a JSON object");
  if (!Array.isArray(raw.teams) || !Array.isArray(raw.games)) throw new Error("it has no teams or games list");
  const warnings = [], teams = [], ids = new Set(), names = new Set();
  let badTeams = 0, badGames = 0;

  for (const t of raw.teams) {
    const id = t && (isNum(t.id) || (typeof t.id === "string" && t.id.trim())) ? String(t.id).trim() : "";
    const name = str(t && t.name);
    if (!id || !name || name.length > 60 || ids.has(id) || names.has(name.toLowerCase())) { badTeams++; continue; }
    ids.add(id); names.add(name.toLowerCase());
    teams.push({id, name, abbr: str(t.abbr).slice(0, 8), conf: str(t.conf).slice(0, 40) || "FBS Independents", div: str(t.div).slice(0, 40) || null});
  }
  if (teams.length < 2) throw new Error("it needs at least two valid teams");

  const games = [], gids = new Set();
  for (const g of raw.games) {
    if (!g || typeof g !== "object") { badGames++; continue; }
    const id = isNum(g.id) || (typeof g.id === "string" && g.id.trim()) ? String(g.id).trim() : "";
    const home = g.home == null ? null : String(g.home), away = g.away == null ? null : String(g.away);
    const week = Number(g.week);
    if (!id || gids.has(id) || !Number.isInteger(week) || week < 0 || week > 30 ||
        (home !== null && !ids.has(home)) || (away !== null && !ids.has(away)) ||
        (home === null && away === null) || home === away) { badGames++; continue; }
    gids.add(id);
    const done = isNum(g.hp) && isNum(g.ap) && g.hp >= 0 && g.ap >= 0;
    const game = {id, week, date: str(g.date).slice(0, 40), home, away, neutral: !!g.neutral, conf: !!g.conf, champ: !!g.champ,
      hp: done ? g.hp : null, ap: done ? g.ap : null};
    if (home === null) game.homeName = str(g.homeName).slice(0, 60) || "Non-FBS opponent";
    if (away === null) game.awayName = str(g.awayName).slice(0, 60) || "Non-FBS opponent";
    games.push(game);
  }
  games.sort((a, b) => a.week - b.week || a.date.localeCompare(b.date) || a.id.localeCompare(b.id));

  const given = new Map(Array.isArray(raw.conferences) ? raw.conferences.filter(c => c && typeof c.name === "string").map(c => [c.name.trim(), c]) : []);
  const conferences = [...new Set(teams.map(t => t.conf))]
    .sort((a, b) => confRank(a) - confRank(b) || a.localeCompare(b))
    .map(name => {
      const c = given.get(name) || {}, divs = new Set(teams.filter(t => t.conf === name && t.div).map(t => t.div));
      let format = FORMATS.includes(c.format) ? c.format : /independent/i.test(name) ? "none" : divs.size >= 2 ? "divisions" : "top2";
      if (format === "divisions" && divs.size < 2) format = "top2";
      const conf = {name, format, hosted: !!c.hosted};
      if (Array.isArray(c.tiebreak) && c.tiebreak.length && c.tiebreak.every(x => TIEBREAK_STEPS.includes(x))) conf.tiebreak = c.tiebreak.slice(0, 10);
      return conf;
    });

  const ratings = cleanRatings(raw.ratings, ids);
  const history = (Array.isArray(raw.history) ? raw.history : [])
    .filter(h => h && Number.isInteger(h.week))
    .map(h => ({week: h.week, date: str(h.date).slice(0, 40), ratings: cleanRatings(h.ratings, ids)}))
    .sort((a, b) => a.week - b.week).slice(-60);
  const ratingNames = {...SOURCE_LABELS};
  if (raw.ratingNames && typeof raw.ratingNames === "object")
    for (const [k, v] of Object.entries(raw.ratingNames)) if (SOURCE_RE.test(k) && k !== "score" && str(v)) ratingNames[k] = str(v).slice(0, 24);

  if (badTeams) warnings.push(`${badTeams} team${badTeams > 1 ? "s" : ""} with a missing or duplicate id/name`);
  if (badGames) warnings.push(`${badGames} game${badGames > 1 ? "s" : ""} with missing or unknown teams`);
  const season = Number.isInteger(raw.season) ? raw.season : new Date().getFullYear();
  return {
    season: {format: SEASON_FORMAT, version: 1, season, demo: !!raw.demo, source: str(raw.source).slice(0, 80),
      updated: str(raw.updated).slice(0, 40), currentWeek: computeWeek(games), conferences, teams, games, ratings, ratingNames, history},
    warnings
  };
}

export function defaultState() {
  return {dv: DEFAULTS_VERSION, settings: {...DEF_SETTINGS}, cfp: {...DEF_CFP}, overrides: {}, forced: {},
    view: {conf: "SEC", heat: "place", week: null, sort: null, team: null}};
}

function cleanValue(k, v, def) {
  if (typeof def === "boolean") return typeof v === "boolean" ? v : def;
  if (k === "model") return CFP_MODELS.includes(v) ? v : def;
  if (k === "seeding") return SEEDINGS.includes(v) ? v : def;
  if (k === "source") return typeof v === "string" && (v === "auto" || SOURCE_RE.test(v)) ? v : def;
  const n = typeof v === "string" && !v.trim() ? NaN : Number(v);
  if (!Number.isFinite(n)) return def;
  const [lo, hi, int] = LIMITS[k], x = Math.min(hi, Math.max(lo, n));
  return int ? Math.round(x) : x;
}

export function cleanSetting(group, k, v) {
  return cleanValue(k, v, (group === "cfp" ? DEF_CFP : DEF_SETTINGS)[k]);
}

export function clampRating(v) {
  return Math.max(-RATING_MAX, Math.min(RATING_MAX, v));
}

// Rebuilds user state from untrusted input (localStorage or an imported
// file), keeping only known keys with values in range.
export function validateState(raw) {
  const s = defaultState();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return s;
  // Settings saved under older defaults keep only the run preferences
  // (simulation count, seed, rating source); the model settings reset to
  // the current defaults.
  const current = raw.dv === DEFAULTS_VERSION;
  for (const g of ["settings", "cfp"])
    if (raw[g] && typeof raw[g] === "object") for (const k in s[g])
      if (k in raw[g] && (current || ["N", "seed", "source"].includes(k))) s[g][k] = cleanValue(k, raw[g][k], s[g][k]);
  // Older saves had an on/off "don't count title game loss" switch.
  if (current && raw.cfp && typeof raw.cfp.forgive === "boolean" && !("titleLossW" in raw.cfp)) s.cfp.titleLossW = raw.cfp.forgive ? 0 : 1;
  if (raw.overrides && typeof raw.overrides === "object")
    for (const [id, v] of Object.entries(raw.overrides)) if (id.length <= 64 && isNum(v)) s.overrides[id] = clampRating(v);
  if (raw.forced && typeof raw.forced === "object")
    for (const [id, v] of Object.entries(raw.forced)) if (id.length <= 64 && (v === 1 || v === 2)) s.forced[id] = v;
  const v = raw.view;
  if (v && typeof v === "object") {
    if (typeof v.conf === "string" && v.conf.length <= 40) s.view.conf = v.conf;
    if (v.heat === "wins") s.view.heat = "wins";
    if (Number.isInteger(v.week)) s.view.week = v.week;
    if (typeof v.team === "string" && v.team.length <= 64) s.view.team = v.team;
    if (v.sort && SORT_KEYS.includes(v.sort.key) && (v.sort.dir === 1 || v.sort.dir === -1)) s.view.sort = {key: v.sort.key, dir: v.sort.dir};
  }
  return s;
}

// Settings from an export of the original SEC-only page (secSim.v1).
export function migrateV1(raw) {
  const s = defaultState();
  for (const k of ["N", "hfa", "gsd", "rsd"]) if (raw.settings && k in raw.settings) s.settings[k] = cleanValue(k, raw.settings[k], s.settings[k]);
  for (const k of ["lossPen", "champBonus", "indSD"]) if (raw.cfp && k in raw.cfp) s.cfp[k] = cleanValue(k, raw.cfp[k], s.cfp[k]);
  if (raw.cfp && typeof raw.cfp.forgive === "boolean") s.cfp.titleLossW = raw.cfp.forgive ? 0 : 1;
  return s;
}

export function bracketError({field, byes, autoBids}) {
  if (byes >= field) return "Byes must be fewer than the field size.";
  if ((field - byes) % 2) return "Field size minus byes must be even.";
  const m = byes + (field - byes) / 2;
  if (m & (m - 1)) return `${field} teams with ${byes} byes doesn't make a clean bracket: byes + first-round winners must be 2, 4, 8 or 16.`;
  if (autoBids > field) return "Auto bids can't exceed the field size.";
  return null;
}

export function teamIndex(season) {
  return new Map(season.teams.map((t, i) => [t.id, i]));
}

// Current overall and conference records from completed games. Conference
// title games count toward the overall record only.
export function teamRecords(season) {
  const idx = teamIndex(season), rec = season.teams.map(() => ({w: 0, l: 0, cw: 0, cl: 0}));
  for (const g of season.games) {
    if (g.hp == null) continue;
    const h = g.home == null ? -1 : idx.get(g.home), a = g.away == null ? -1 : idx.get(g.away);
    const w = g.hp > g.ap ? h : a, l = g.hp > g.ap ? a : h;
    const conf = g.conf && !g.champ && h >= 0 && a >= 0 && season.teams[h].conf === season.teams[a].conf;
    if (w >= 0) { rec[w].w++; if (conf) rec[w].cw++; }
    if (l >= 0) { rec[l].l++; if (conf) rec[l].cl++; }
  }
  return rec;
}

// Preseason prior for the results model: the earliest saved snapshot of the
// best available outside rating, else the current one.
export function priorRatings(season) {
  for (const h of season.history) for (const k of SOURCE_ORDER) if (h.ratings[k]) return h.ratings[k];
  for (const k of SOURCE_ORDER) if (season.ratings[k]) return season.ratings[k];
  const any = Object.keys(season.ratings)[0];
  return any ? season.ratings[any] : null;
}

// Points-based ratings from this season's scores: each team's rating is
// pulled toward its prior (worth `priorW` games) and toward the capped,
// home-field-adjusted margins it has posted against its opponents.
export function resultsRatings(season, {hfa, fcs, priorW, cap}, prior = priorRatings(season), beforeWeek = Infinity) {
  const n = season.teams.length, idx = teamIndex(season), p = new Float64Array(n), adj = season.teams.map(() => []);
  if (prior) season.teams.forEach((t, i) => { if (isNum(prior[t.id])) p[i] = prior[t.id]; });
  for (const g of season.games) {
    if (g.hp == null || g.week >= beforeWeek) continue;
    const h = g.home == null ? -1 : idx.get(g.home), a = g.away == null ? -1 : idx.get(g.away);
    const m = Math.max(-cap, Math.min(cap, g.hp - g.ap)) - (g.neutral ? 0 : hfa);
    if (h >= 0) adj[h].push(a, m);
    if (a >= 0) adj[a].push(h, -m);
  }
  const r = Float64Array.from(p);
  for (let it = 0; it < 300; it++) {
    let moved = 0;
    for (let i = 0; i < n; i++) {
      const e = adj[i];
      if (!e.length) continue;
      let num = priorW * p[i], den = priorW;
      for (let k = 0; k < e.length; k += 2) { num += e[k + 1] + (e[k] >= 0 ? r[e[k]] : fcs); den++; }
      const x = num / den;
      moved = Math.max(moved, Math.abs(x - r[i]));
      r[i] = x;
    }
    if (moved < 1e-5) break;
  }
  const out = {};
  season.teams.forEach((t, i) => { out[t.id] = r[i]; });
  return out;
}

export function resolveSource(season, src) {
  if (src === "score" || (src !== "auto" && season.ratings[src])) return src;
  return SOURCE_ORDER.find(k => season.ratings[k]) || Object.keys(season.ratings)[0] || "score";
}

// Ratings from the chosen source. Teams the source doesn't cover fall back to
// the results model.
export function baseRatings(season, settings) {
  const src = resolveSource(season, settings.source), score = resultsRatings(season, settings);
  if (src === "score") return {src, values: score};
  const ext = season.ratings[src], values = {};
  for (const t of season.teams) values[t.id] = isNum(ext[t.id]) ? ext[t.id] : score[t.id];
  return {src, values};
}

// The same source as of the previous week, for week-over-week change.
export function previousRatings(season, settings) {
  const src = resolveSource(season, settings.source);
  if (src === "score") return season.currentWeek > 1 ? resultsRatings(season, settings, priorRatings(season), season.currentWeek - 1) : null;
  for (let k = season.history.length - 1; k >= 0; k--) {
    const h = season.history[k];
    if (h.week < season.currentWeek && h.ratings[src]) return h.ratings[src];
  }
  return null;
}

export function effectiveRatings(season, state) {
  const {values} = baseRatings(season, state.settings), eff = {};
  for (const t of season.teams) eff[t.id] = isNum(state.overrides[t.id]) ? state.overrides[t.id] : values[t.id];
  return eff;
}

// Builds the simulator input: team-indexed typed arrays for records and
// head-to-head results so far, the remaining games, and every parameter.
export function prepare(season, state, eff = effectiveRatings(season, state)) {
  const {settings: S, cfp: C} = state, teams = season.teams, n = teams.length, idx = teamIndex(season);
  const R = Float64Array.from(teams, t => eff[t.id]);
  const confs = season.conferences.map(c => ({name: c.name, format: c.format, hosted: c.hosted, members: [], divs: null, champGame: -1, champDone: null,
    tiebreak: c.tiebreak || CONF_TIEBREAKS[c.name] || DEFAULT_TIEBREAK}));
  const ci = new Map(confs.map((c, k) => [c.name, k])), confOf = new Int16Array(n);
  teams.forEach((t, i) => { confOf[i] = ci.get(t.conf); confs[confOf[i]].members.push(i); });
  for (const c of confs) {
    if (c.format !== "divisions") continue;
    const by = new Map();
    for (const i of c.members) { const d = teams[i].div || ""; if (!by.has(d)) by.set(d, []); by.get(d).push(i); }
    c.divs = [...by.values()];
  }

  const W0 = new Int16Array(n), L0 = new Int16Array(n), CW0 = new Int16Array(n), CL0 = new Int16Array(n);
  const wins0 = new Int16Array(n * n), G2 = new Uint8Array(n * n), confG = new Int16Array(n);
  const oppSum = new Float64Array(n), oppCnt = new Int16Array(n), rem = [], remIds = [], playedW = [], playedL = [];
  for (const g of season.games) {
    const h = g.home == null ? -1 : idx.get(g.home), a = g.away == null ? -1 : idx.get(g.away);
    const same = h >= 0 && a >= 0 && confOf[h] === confOf[a] && confs[confOf[h]].format !== "none";
    const champ = g.champ && same, conf = g.conf && same && !champ;
    if (h >= 0) { oppSum[h] += a >= 0 ? R[a] : S.fcs; oppCnt[h]++; }
    if (a >= 0) { oppSum[a] += h >= 0 ? R[h] : S.fcs; oppCnt[a]++; }
    if (conf) { G2[h * n + a]++; G2[a * n + h]++; confG[h]++; confG[a]++; }
    if (g.hp != null) {
      const w = g.hp > g.ap ? h : a, l = g.hp > g.ap ? a : h;
      if (w >= 0) W0[w]++;
      if (l >= 0) L0[l]++;
      if (w >= 0 && l >= 0) { playedW.push(w); playedL.push(l); }
      if (champ) confs[confOf[h]].champDone = {w, l, home: g.neutral ? -1 : h};
      else if (conf) { CW0[w]++; CL0[l]++; wins0[w * n + l]++; }
    } else {
      if (champ) confs[confOf[h]].champGame = rem.length;
      rem.push({h, a, neu: g.neutral, conf, champ: champ ? confOf[h] : -1});
      remIds.push(g.id);
    }
  }
  const confOpps = teams.map((_, i) => {
    const o = [];
    for (let j = 0; j < n; j++) if (G2[i * n + j]) o.push(j);
    return Int16Array.from(o);
  });
  const sos = Float64Array.from(teams, (_, i) => oppCnt[i] ? oppSum[i] / oppCnt[i] : 0);

  // Strength of record: the wins a bubble team (the field-size-th best
  // rating) would expect against each team's regular-season schedule, at the
  // same sites. Title games are added during the simulation.
  const bench = [...R].sort((a, b) => b - a)[Math.min(C.field, n) - 1];
  const expW = new Float64Array(n);
  for (const g of season.games) {
    const h = g.home == null ? -1 : idx.get(g.home), a = g.away == null ? -1 : idx.get(g.away);
    if (g.champ && h >= 0 && a >= 0 && confOf[h] === confOf[a]) continue;
    const adj = g.neutral ? 0 : S.hfa;
    if (h >= 0) expW[h] += benchWinProb(bench, a >= 0 ? R[a] : S.fcs, adj, S.gsd);
    if (a >= 0) expW[a] += benchWinProb(bench, h >= 0 ? R[h] : S.fcs, -adj, S.gsd);
  }
  const forced = Int8Array.from(remIds, id => state.forced[id] || 0);
  let maxConfSize = 0, maxConfG = 0;
  for (const c of confs) if (c.format !== "none") {
    maxConfSize = Math.max(maxConfSize, c.members.length);
    for (const i of c.members) maxConfG = Math.max(maxConfG, confG[i]);
  }
  return {n, confs, confOf, R, W0, L0, CW0, CL0, wins0, G2, confG, confOpps, sos, expW, rem, remIds, forced, maxConfSize, maxConfG,
    playedW: Int16Array.from(playedW), playedL: Int16Array.from(playedL),
    params: {N: S.N, seed: S.seed, hfa: S.hfa, gsd: S.gsd, rsd: S.rsd, fcs: S.fcs, bench, ...C}};
}
