// Turns CollegeFootballData.com API responses and a ratings spreadsheet (CSV)
// into the simulator's season file. Pure functions; the network calls live
// in update-data.mjs so these can be tested against fixtures.
import {SEASON_FORMAT, SOURCE_LABELS, computeWeek, confRank} from "../js/model.js";

// Title games hosted by the higher seed instead of at a neutral site.
export const HOSTED_TITLE = new Set(["American Athletic", "Mountain West", "Sun Belt", "Conference USA", "Pac-12"]);
const INDEPENDENT = /independent/i;

// First non-null field among v2 (camelCase) and legacy (snake_case) names.
const pick = (o, ...keys) => {
  for (const k of keys) if (o[k] !== undefined && o[k] !== null) return o[k];
  return null;
};

export function normTeams(raw) {
  return raw
    .filter(t => t && t.id != null && t.school && String(pick(t, "classification") || "fbs").toLowerCase() === "fbs")
    .map(t => ({id: String(t.id), name: String(t.school), abbr: String(pick(t, "abbreviation") || ""),
      conf: String(pick(t, "conference") || "FBS Independents"), div: pick(t, "division") ? String(t.division) : null}))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Army–Navy is listed as an American Athletic game but is played after the
// AAC title game and doesn't count in the conference standings.
const isArmyNavy = (a, b) => [a, b].sort().join("|") === "Army|Navy";

export function normGames(raw, teams) {
  const byId = new Map(teams.map(t => [t.id, t])), out = [];
  for (const g of raw) {
    if (!g || g.id == null || String(pick(g, "seasonType", "season_type") || "regular") !== "regular") continue;
    const hid = pick(g, "homeId", "home_id"), aid = pick(g, "awayId", "away_id");
    const h = hid != null && byId.has(String(hid)) ? String(hid) : null;
    const a = aid != null && byId.has(String(aid)) ? String(aid) : null;
    if (!h && !a) continue;
    const hp = pick(g, "homePoints", "home_points"), ap = pick(g, "awayPoints", "away_points");
    const done = pick(g, "completed") !== false && Number.isFinite(hp) && Number.isFinite(ap);
    const date = String(pick(g, "startDate", "start_date") || ""), notes = String(pick(g, "notes") || "");
    const confGame = !!pick(g, "conferenceGame", "conference_game");
    const H = h && byId.get(h), A = a && byId.get(a);
    const same = !!(H && A && H.conf === A.conf && !INDEPENDENT.test(H.conf));
    const armyNavy = same && isArmyNavy(H.name, A.name);
    const champ = same && !armyNavy &&
      (/championship/i.test(notes) || (confGame && /^\d{4}-12-/.test(date)));
    const game = {id: String(g.id), week: Number(pick(g, "week")) || 0, date, home: h, away: a,
      neutral: !!pick(g, "neutralSite", "neutral_site"), conf: confGame && same && !armyNavy, champ, hp: done ? hp : null, ap: done ? ap : null};
    if (!h) game.homeName = String(pick(g, "homeTeam", "home_team") || "Non-FBS opponent");
    if (!a) game.awayName = String(pick(g, "awayTeam", "away_team") || "Non-FBS opponent");
    out.push(game);
  }
  return out.sort((x, y) => x.week - y.week || x.date.localeCompare(y.date) || x.id.localeCompare(y.id));
}

// Week-by-week Elo from the pregame Elo CFBD attaches to each game. A team
// on a bye carries its postgame Elo from the week before. Returns
// {week: {teamId: points vs. FBS average}} for weeks with most teams rated.
export function eloByWeek(raw, teams) {
  const ids = new Set(teams.map(t => t.id)), byWeek = new Map();
  for (const g of raw) {
    if (!g || String(pick(g, "seasonType", "season_type") || "regular") !== "regular") continue;
    const week = Number(pick(g, "week")) || 0;
    for (const [idK, preK, postK, idL, preL, postL] of [["homeId", "homePregameElo", "homePostgameElo", "home_id", "home_pregame_elo", "home_postgame_elo"],
      ["awayId", "awayPregameElo", "awayPostgameElo", "away_id", "away_pregame_elo", "away_postgame_elo"]]) {
      const id = String(pick(g, idK, idL));
      if (!ids.has(id)) continue;
      if (!byWeek.has(week)) byWeek.set(week, new Map());
      const e = byWeek.get(week).get(id) || {};
      const pre = Number(pick(g, preK, preL)), post = Number(pick(g, postK, postL));
      if (Number.isFinite(pre) && pick(g, preK, preL) !== null && e.pre === undefined) e.pre = pre;
      if (Number.isFinite(post) && pick(g, postK, postL) !== null) e.post = post;
      byWeek.get(week).set(id, e);
    }
  }
  const out = {}, last = new Map();
  for (const week of [...byWeek.keys()].sort((a, b) => a - b)) {
    const vals = {};
    for (const [id, v] of last) vals[id] = v;
    for (const [id, e] of byWeek.get(week)) if (e.pre !== undefined) vals[id] = e.pre;
    if (Object.keys(vals).length >= teams.length / 2) out[week] = centerRatings(vals, 1 / 25);
    for (const [id, e] of byWeek.get(week)) {
      const v = e.post ?? e.pre;
      if (v !== undefined) last.set(id, v);
    }
  }
  return out;
}

// ---- Team-name matching ---------------------------------------------------

// Common spellings that differ from CollegeFootballData.com's school names.
const ALIASES = {
  "mississippi": "ole miss", "miami fl": "miami", "miami florida": "miami", "miami (fl)": "miami",
  "miami oh": "miami (oh)", "miami ohio": "miami (oh)", "miami of ohio": "miami (oh)",
  "southern california": "usc", "southern cal": "usc", "central florida": "ucf", "connecticut": "uconn",
  "massachusetts": "massachusetts", "umass": "massachusetts", "brigham young": "byu",
  "louisiana state": "lsu", "texas christian": "tcu", "southern methodist": "smu", "pittsburgh": "pittsburgh", "pitt": "pittsburgh",
  "app state": "appalachian state", "appalachian st": "appalachian state", "southern mississippi": "southern miss",
  "louisiana monroe": "ul monroe", "ulm": "ul monroe", "louisiana-monroe": "ul monroe", "ul lafayette": "louisiana",
  "louisiana lafayette": "louisiana", "louisiana-lafayette": "louisiana", "texas-san antonio": "utsa",
  "texas san antonio": "utsa", "texas-el paso": "utep", "texas el paso": "utep", "alabama-birmingham": "uab",
  "alabama birmingham": "uab", "nevada-las vegas": "unlv", "nevada las vegas": "unlv", "san jose state": "san josé state",
  "san jose st": "san josé state", "hawaii": "hawai'i", "florida international": "fiu", "florida intl": "fiu",
  "fla atlantic": "florida atlantic", "fau": "florida atlantic", "middle tennessee state": "middle tennessee", "mtsu": "middle tennessee",
  "western kentucky": "western kentucky", "wku": "western kentucky", "sam houston state": "sam houston", "shsu": "sam houston",
  "nc state": "nc state", "north carolina state": "nc state", "n.c. state": "nc state", "ecu": "east carolina",
  "usf": "south florida", "niu": "northern illinois", "cmu": "central michigan", "wmu": "western michigan", "emu": "eastern michigan",
  "bgsu": "bowling green", "jmu": "james madison", "odu": "old dominion", "gaso": "georgia southern", "uva": "virginia",
  "vt": "virginia tech", "fsu": "florida state", "osu": "ohio state", "psu": "penn state", "jax state": "jacksonville state",
  "jacksonville st": "jacksonville state", "kennesaw st": "kennesaw state", "sacramento st": "sacramento state", "sac state": "sacramento state",
  "cal": "california", "army west point": "army", "air force academy": "air force", "navy midshipmen": "navy"
};

export function nameKey(s) {
  let k = String(s).toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/[’`]/g, "'").replace(/&/g, "and").replace(/\./g, "").replace(/\s+/g, " ").trim();
  k = k.replace(/\bst$/, "state").replace(/\bst\b(?= \()/, "state");
  return k;
}

export function makeMatcher(teams, extra = {}) {
  const map = new Map();
  for (const t of teams) {
    map.set(nameKey(t.name), t.id);
    if (t.abbr) map.set(nameKey(t.abbr), t.id);
  }
  const alias = new Map();
  for (const [k, v] of Object.entries({...ALIASES, ...extra})) alias.set(nameKey(k), nameKey(v));
  return name => {
    const k = nameKey(name);
    return map.get(k) ?? map.get(alias.get(k)) ?? map.get(k.replace(/ state$/, " st")) ?? null;
  };
}

// ---- Ratings ----------------------------------------------------------------

// Centers a rating set on the FBS average. Elo-like scales (hundreds of
// points) are converted to points at 25 rating points per point of spread.
export function centerRatings(vals, scale) {
  const ids = Object.keys(vals);
  if (!ids.length) return vals;
  const mean = ids.reduce((s, id) => s + vals[id], 0) / ids.length;
  const k = scale ?? (Math.max(...ids.map(id => Math.abs(vals[id]))) > 150 ? 1 / 25 : 1), out = {};
  for (const id of ids) out[id] = Math.round((vals[id] - mean) * k * 100) / 100;
  return out;
}

export function normRatings(kind, raw, teams) {
  const match = makeMatcher(teams), field = {sp: "rating", fpi: "fpi", elo: "elo", srs: "rating"}[kind], vals = {};
  for (const row of raw || []) {
    const id = row && match(row.team || "");
    const x = Number(row && row[field]);
    if (id && Number.isFinite(x)) vals[id] = x;
  }
  return Object.keys(vals).length >= teams.length / 2 ? centerRatings(vals, kind === "elo" ? 1 / 25 : 1) : null;
}

export function parseCsv(text) {
  const rows = [];
  let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.map(r => r.map(x => x.trim())).filter(r => r.some(Boolean));
}

// "Week 7", "Wk 7", "W7", "7" → 7; "Preseason"/"Pre" → 0.
function weekOf(h) {
  const s = h.toLowerCase().trim();
  if (/^pre(season)?$/.test(s)) return 0;
  const m = s.match(/^(?:week|wk|w)\s*#?\s*(\d{1,2})$/) || s.match(/^(\d{1,2})$/);
  return m ? +m[1] : null;
}
const num = s => {
  const x = Number(String(s).replace(/[,+]/g, ""));
  return s !== "" && Number.isFinite(x) ? x : null;
};

// Reads team ratings from a spreadsheet exported as CSV. Handles three
// layouts and returns {byWeek: {week: {teamId: rating}}, latest, unmatched}:
//   long:   one row per team per week, with team, week and rating columns
//   wide:   one row per team, one rating column per week ("Week 1", "Wk 2", …)
//   single: one row per team with one rating column
// `opts` can name the columns (teamColumn, ratingColumn, weekColumn) and add
// team-name aliases when auto-detection guesses wrong.
export function parseSheet(text, teams, opts = {}) {
  const rows = parseCsv(text);
  const lc = s => String(s || "").toLowerCase();
  const want = (name, re) => (h => name ? lc(h) === lc(name) : re.test(h));
  const isTeam = want(opts.teamColumn, /^(team|school|name|team name)$/i);
  const hr = rows.slice(0, 15).findIndex(r => r.some(isTeam));
  if (hr < 0) throw new Error(`couldn't find a team column header${opts.teamColumn ? ` named "${opts.teamColumn}"` : ""} in the sheet`);
  const head = rows[hr], body = rows.slice(hr + 1), tc = head.findIndex(isTeam);
  const match = makeMatcher(teams, opts.aliases || {}), byWeek = {}, unmatched = new Set();
  const put = (w, name, v) => {
    if (v === null || !name) return;
    const id = match(name);
    if (!id) { unmatched.add(name); return; }
    (byWeek[w] = byWeek[w] || {})[id] = v;
  };
  const wc = head.findIndex(want(opts.weekColumn, /^(week|wk)$/i));
  const ratingRe = /^(rating|rtg|power|power rating|score|value|pr|ovr|overall)$/i;
  let rc = head.findIndex(want(opts.ratingColumn, ratingRe));
  const weekCols = head.map((h, k) => [k, weekOf(h)]).filter(([k, w]) => k !== tc && w !== null);

  if (wc >= 0) {
    if (rc < 0) rc = head.findIndex((_, k) => k !== tc && k !== wc && body.some(r => num(r[k] ?? "") !== null));
    if (rc < 0) throw new Error("couldn't find a rating column next to the week column");
    for (const r of body) { const w = weekOf(r[wc] ?? "") ?? num(r[wc] ?? ""); if (w !== null) put(w, r[tc], num(r[rc] ?? "")); }
  } else if (rc < 0 && weekCols.length) {
    for (const r of body) for (const [k, w] of weekCols) put(w, r[tc], num(r[k] ?? ""));
  } else {
    if (rc < 0) rc = head.findIndex((_, k) => k !== tc && body.filter(r => num(r[k] ?? "") !== null).length >= body.length / 2);
    if (rc < 0) throw new Error("couldn't find a numeric rating column");
    for (const r of body) put("latest", r[tc], num(r[rc] ?? ""));
  }

  const weeks = Object.keys(byWeek).filter(w => w !== "latest").map(Number).sort((a, b) => a - b);
  const enough = w => Object.keys(byWeek[w]).length >= teams.length / 2;
  const scale = opts.scale;
  const full = weeks.filter(enough);
  const latestKey = byWeek.latest ? "latest" : full[full.length - 1];
  if (latestKey === undefined || !enough(latestKey)) throw new Error(`matched fewer than half of the FBS teams (unmatched examples: ${[...unmatched].slice(0, 8).join(", ")})`);
  const out = {};
  for (const w of full) out[w] = centerRatings(byWeek[w], scale);
  return {byWeek: out, latest: centerRatings(byWeek[latestKey], scale), latestWeek: latestKey === "latest" ? null : latestKey, unmatched: [...unmatched]};
}

// Google Sheets "edit" or "view" links → the CSV export URL for that tab.
export function sheetCsvUrl(url) {
  const m = String(url).match(/docs\.google\.com\/spreadsheets\/d\/([\w-]+)/);
  if (!m) return url;
  const gid = (String(url).match(/[#&?]gid=(\d+)/) || [])[1];
  return `https://docs.google.com/spreadsheets/d/${m[1]}/export?format=csv${gid ? `&gid=${gid}` : ""}`;
}

// ---- Season file -----------------------------------------------------------

// Combines fresh pulls with the previous season file. `ratings` holds the
// sources fetched this run (a missing source keeps its previous values).
// `eloWeeks` (from eloByWeek) and `sheetWeeks` are week-by-week ratings to
// store as history; Elo only fills weeks already played.
export function buildSeason({year, teams, games, ratings = {}, eloWeeks = null, sheetWeeks = null, sheetLabel, prev, now}) {
  const keepPrev = prev && prev.season === year;
  const confNames = [...new Set(teams.map(t => t.conf))].sort((a, b) => confRank(a) - confRank(b) || a.localeCompare(b));
  const conferences = confNames.map(name => {
    const divs = new Set(teams.filter(t => t.conf === name && t.div).map(t => t.div));
    return {name, format: INDEPENDENT.test(name) ? "none" : divs.size >= 2 ? "divisions" : "top2", hosted: HOSTED_TITLE.has(name)};
  });
  const currentWeek = computeWeek(games);
  const cur = {...(keepPrev ? prev.ratings : {})};
  for (const [k, v] of Object.entries(ratings)) if (v) cur[k] = v;

  // History: one snapshot per week of "ratings going into that week".
  const hist = new Map((keepPrev && Array.isArray(prev.history) ? prev.history : []).map(h => [h.week, {...h, ratings: {...h.ratings}}]));
  const snap = (week, src, vals) => {
    if (!hist.has(week)) hist.set(week, {week, date: now, ratings: {}});
    hist.get(week).ratings[src] = vals;
  };
  for (const [k, v] of Object.entries(ratings)) if (v && k !== "sheet") snap(currentWeek, k, v);
  if (eloWeeks) for (const [w, v] of Object.entries(eloWeeks)) if (+w < currentWeek) snap(+w, "elo", v);
  if (sheetWeeks) for (const [w, v] of Object.entries(sheetWeeks)) snap(+w, "sheet", v);
  else if (ratings.sheet) snap(currentWeek, "sheet", ratings.sheet);

  const ratingNames = {};
  for (const k of Object.keys(cur)) ratingNames[k] = k === "sheet" && sheetLabel ? sheetLabel : SOURCE_LABELS[k] || k;
  return {format: SEASON_FORMAT, version: 1, season: year, source: "CollegeFootballData.com", updated: now, currentWeek,
    conferences, teams, games, ratings: cur, ratingNames, history: [...hist.values()].sort((a, b) => a.week - b.week)};
}

// Season year for a date: the fall season runs into January.
export function seasonYear(d) {
  return d.getUTCMonth() < 6 ? d.getUTCFullYear() - 1 : d.getUTCFullYear();
}

// One array element or rating source per line keeps git diffs readable.
export function serialize(season) {
  const keys = Object.keys(season);
  const body = keys.map((k, i) => {
    const v = season[k], comma = i < keys.length - 1 ? "," : "";
    if (Array.isArray(v) && v.length) return `  ${JSON.stringify(k)}: [\n${v.map(x => "    " + JSON.stringify(x)).join(",\n")}\n  ]${comma}`;
    if (v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length && Object.values(v).every(x => x && typeof x === "object"))
      return `  ${JSON.stringify(k)}: {\n${Object.entries(v).map(([kk, x]) => `    ${JSON.stringify(kk)}: ${JSON.stringify(x)}`).join(",\n")}\n  }${comma}`;
    return `  ${JSON.stringify(k)}: ${JSON.stringify(v)}${comma}`;
  });
  return `{\n${body.join("\n")}\n}\n`;
}

// Same content apart from the timestamp?
export function sameData(a, b) {
  if (!a || !b) return false;
  const strip = s => JSON.stringify({...s, updated: "", history: (s.history || []).map(h => ({...h, date: ""}))});
  return strip(a) === strip(b);
}
