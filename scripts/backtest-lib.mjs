// Pieces of the backtest that don't touch the network: rebuilding a past
// season as it stood at a given week, reading what actually happened, and
// scoring forecasts against it.
import {validateSeason, prepare, defaultState, phi} from "../js/model.js";
import {simulate} from "../js/sim.js";
import {buildSeason} from "./sources.mjs";

const pick = (o, ...keys) => { for (const k of keys) if (o[k] !== undefined && o[k] !== null) return o[k]; return null; };
const clip = p => Math.min(0.995, Math.max(0.005, p));
export const logLoss = (p, y) => -Math.log(y ? clip(p) : 1 - clip(p));

// The season as of `week`: games from that week on lose their scores, and
// ratings are the Elo going into that week (so nothing from the future
// leaks in). week = "selection" keeps every regular-season result,
// including conference title games, and uses final Elo. Returns the season
// and the hidden results of the games it blanked out.
export function asOf({year, teams, games, eloWeeks}, week) {
  const weeks = Object.keys(eloWeeks).map(Number).sort((a, b) => a - b);
  const last = Math.max(...games.map(g => g.week));
  const cut = week === "selection" ? last + 1 : week;
  const ratingWeek = weeks.filter(w => w <= cut).pop();
  const shown = games.map(g => g.week >= cut ? {...g, hp: null, ap: null} : g);
  const history = weeks.filter(w => w < cut).map(w => ({week: w, date: "", ratings: {elo: eloWeeks[w]}}));
  const s = buildSeason({year, teams, games: shown, ratings: {}, prev: null, now: ""});
  s.ratings = {elo: eloWeeks[ratingWeek]};
  s.history = history;
  const future = games.filter(g => g.week >= cut && g.hp != null && g.hp !== g.ap)
    .map(g => ({home: g.home, away: g.away, neutral: g.neutral, homeWon: g.hp > g.ap}));
  return {season: validateSeason(s).season, future};
}

// What actually happened, from CFBD's regular-season (conference title
// games) and postseason (playoff) games. Returns null pieces it can't find.
export function actualOutcome(games, postRaw, teams) {
  const ids = new Set(teams.map(t => t.id)), conf = new Map(teams.map(t => [t.id, t.conf]));
  const champs = {};
  for (const g of games) if (g.champ && g.hp != null) champs[conf.get(g.home)] = g.hp > g.ap ? g.home : g.away;
  const cfp = postRaw
    .filter(g => /playoff|cfp|national championship/i.test(String(pick(g, "notes") || "")))
    .map(g => ({date: String(pick(g, "startDate", "start_date") || ""), home: String(pick(g, "homeId", "home_id")), away: String(pick(g, "awayId", "away_id")),
      hp: pick(g, "homePoints", "home_points"), ap: pick(g, "awayPoints", "away_points"), neutral: !!pick(g, "neutralSite", "neutral_site")}))
    .sort((a, b) => a.date.localeCompare(b.date));
  let field = null, byes = null, hosts = null, natl = null, note = "";
  if (cfp.length === 11 && cfp.every(g => ids.has(g.home) && ids.has(g.away))) {
    const first = cfp.slice(0, 4), qf = cfp.slice(4, 8), fin = cfp[10];
    const inFirst = new Set(first.flatMap(g => [g.home, g.away]));
    field = [...new Set([...first, ...qf].flatMap(g => [g.home, g.away]))];
    byes = qf.flatMap(g => [g.home, g.away]).filter(t => !inFirst.has(t));
    hosts = first.map(g => g.home);
    if (Number.isFinite(fin.hp) && Number.isFinite(fin.ap)) natl = fin.hp > fin.ap ? fin.home : fin.away;
    if (field.length !== 12 || byes.length !== 4) { note = `unexpected bracket shape (${field.length} teams, ${byes.length} byes)`; field = byes = hosts = null; }
  } else note = `found ${cfp.length} playoff games, expected 11`;
  return {champs, field, byes, hosts, natl, note};
}

// Game-level forecast quality: mean log loss and Brier score of the home
// team's pregame win chance for the hidden games, from the as-of ratings.
export function gameScores(future, R, hfa, sd, fcs) {
  let ll = 0, brier = 0, k = 0;
  for (const g of future) {
    const rh = g.home ? R[g.home] : fcs, ra = g.away ? R[g.away] : fcs;
    if (!Number.isFinite(rh) || !Number.isFinite(ra)) continue;
    const p = phi((rh - ra + (g.neutral ? 0 : hfa)) / sd), y = g.homeWon ? 1 : 0;
    ll += logLoss(p, y); brier += (p - y) ** 2; k++;
  }
  return {logLoss: ll / k, brier: brier / k, games: k};
}

// Season-level forecast quality from one simulation run. Lower is better
// for every number. Conference champions: mean multiclass log loss per
// conference. Playoff, byes, hosting: binary log loss summed over all FBS
// teams. Title: log loss of the actual champion.
export function seasonScores(season, actual, settings, cfp, N = 2000) {
  const st = defaultState();
  Object.assign(st.settings, settings, {N});
  Object.assign(st.cfp, cfp);
  const P = prepare(season, st), A = simulate(P, false), idx = new Map(season.teams.map((t, i) => [t.id, i]));
  const out = {};
  const champConfs = Object.entries(actual.champs).filter(([c]) => P.confs.some(x => x.name === c && x.format !== "none"));
  if (champConfs.length) out.champ = champConfs.reduce((s, [, id]) => s - Math.log(clip(A.ch[idx.get(id)] / N)), 0) / champConfs.length;
  const binary = (arr, set) => season.teams.reduce((s, t, i) => s + logLoss(arr[i] / N, set.has(t.id)), 0);
  if (actual.field) {
    out.cfp = binary(A.cfp, new Set(actual.field));
    out.bye = binary(A.bye, new Set(actual.byes));
    out.host = binary(A.host, new Set(actual.hosts));
  }
  if (actual.natl) out.natl = -Math.log(clip(A.natl[idx.get(actual.natl)] / N));
  out.pIn = actual.field ? Object.fromEntries(actual.field.map(id => [id, A.cfp[idx.get(id)] / N])) : null;
  out.projected = season.teams.map((t, i) => [t.id, A.cfp[i] / N]).sort((a, b) => b[1] - a[1]).slice(0, 12).map(x => x[0]);
  return out;
}
