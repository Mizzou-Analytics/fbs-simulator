// Daily odds snapshots: the update workflow simulates the season with the
// default settings and keeps one snapshot per day in data/odds-history.json,
// so the page can show how each team's odds have moved.
import {defaultState, prepare} from "../js/model.js";
import {simulate} from "../js/sim.js";

const round = x => Math.round(x * 1000) / 1000;

// Each team's chance of making the playoff, winning its conference and
// winning the title, rounded to 0.1%; teams at zero are left out.
export function oddsSnapshot(season, date, N = 10000) {
  const st = defaultState();
  st.settings.N = N;
  const P = prepare(season, st), A = simulate(P, false), snap = {date, week: season.currentWeek, cfp: {}, ch: {}, natl: {}};
  season.teams.forEach((t, i) => {
    for (const k of ["cfp", "ch", "natl"]) { const v = round(A[k][i] / N); if (v > 0) snap[k][t.id] = v; }
  });
  return snap;
}

// Adds or replaces the snapshot for `snap.date`; history is limited to one
// season (the snapshots must all be for `season`) and 400 days.
export function addSnapshot(history, snap, season) {
  const list = history && history.season === season && Array.isArray(history.snapshots) ? history.snapshots.filter(s => s.date !== snap.date) : [];
  list.push(snap);
  list.sort((a, b) => a.date.localeCompare(b.date));
  return {season, snapshots: list.slice(-400)};
}

export function serializeHistory(h) {
  return `{"season": ${h.season}, "snapshots": [\n${h.snapshots.map(s => "  " + JSON.stringify(s)).join(",\n")}\n]}\n`;
}
