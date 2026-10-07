// National stakes for this week's games: for each game, the season is
// simulated twice more (home team forced to win, then away team), with the
// same random draws, and every FBS team's playoff chance is compared. The
// update workflow publishes the result as data/stakes.json.
import {defaultState, prepare} from "../js/model.js";
import {simulate} from "../js/sim.js";

const round = x => Math.round(x * 1000) / 1000;

// stake: percentage of playoff chance (0–1 scale, summed over teams) that
// moves from one team to another between the two results. weight: stake
// times 4p(1-p), so a toss-up counts in full and a near-certain result
// hardly at all; games are ranked by it.
export function weekStakes(season, {N = 4000, top = 12, date = ""} = {}) {
  const week = season.currentWeek, idx = new Map(season.teams.map((t, i) => [t.id, i]));
  const run = forced => {
    const st = defaultState();
    st.settings.N = N;
    st.forced = forced;
    const P = prepare(season, st);
    return {P, A: simulate(P, true)};
  };
  const base = run({});
  const games = season.games.filter(g => g.week === week && g.hp == null && (g.home || g.away));
  const out = [];
  for (const g of games) {
    const j = base.P.remIds.indexOf(g.id);
    if (j < 0) continue;
    const H = run({[g.id]: 2}).A, Aw = run({[g.id]: 1}).A, pHome = base.A.levH[j] / N;
    const shift = season.teams.map((t, i) => (H.cfp[i] - Aw.cfp[i]) / N);
    const stake = shift.reduce((s, d) => s + Math.max(0, d), 0);
    const side = (id, home) => {
      if (!id) return null;
      const i = idx.get(id), win = home ? H : Aw, lose = home ? Aw : H;
      return {id, pWin: round(home ? pHome : 1 - pHome), now: round(base.A.cfp[i] / N), ifWin: round(win.cfp[i] / N), ifLose: round(lose.cfp[i] / N)};
    };
    // Other teams the result moves by at least 1.5 points, positive when a
    // home win helps them.
    const others = season.teams.map((t, i) => ({id: t.id, d: round(shift[i])}))
      .filter(x => x.id !== g.home && x.id !== g.away && Math.abs(x.d) >= 0.015)
      .sort((a, b) => Math.abs(b.d) - Math.abs(a.d)).slice(0, 3);
    out.push({id: g.id, home: side(g.home, true), away: side(g.away, false), stake: round(stake),
      weight: round(stake * 4 * pHome * (1 - pHome)), others});
  }
  out.sort((a, b) => b.weight - a.weight);
  return {season: season.season, week, date, N, games: out.slice(0, top)};
}
