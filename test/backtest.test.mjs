import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {validateSeason} from "../js/model.js";
import {asOf, actualOutcome, gameScores, logLoss} from "../scripts/backtest-lib.mjs";
import {oddsSnapshot, addSnapshot, serializeHistory} from "../scripts/odds.mjs";

const demo = validateSeason(JSON.parse(readFileSync(new URL("../data/demo.json", import.meta.url), "utf8"))).season;
const ids = demo.teams.map(t => t.id);

test("as-of seasons hide later scores and use that week's ratings", () => {
  const eloWeeks = {1: {}, 4: {}};
  for (const id of ids) { eloWeeks[1][id] = 1; eloWeeks[4][id] = 4; }
  const {season, future} = asOf({year: 2026, teams: demo.teams, games: demo.games, eloWeeks}, 4);
  assert.ok(season.games.filter(g => g.week >= 4).every(g => g.hp == null));
  assert.ok(season.games.filter(g => g.week < 4 && demo.games.find(d => d.id === g.id).hp != null).every(g => g.hp != null));
  assert.equal(season.ratings.elo[ids[0]], 4);
  assert.deepEqual(season.history.map(h => h.week), [1]);
  assert.equal(future.length, demo.games.filter(g => g.week >= 4 && g.hp != null).length);
});

test("actual outcome reads the 12-team bracket from postseason games", () => {
  const t = ids.slice(0, 12), g = (k, h, a, notes, hp = 30, ap = 20) =>
    ({id: k, seasonType: "postseason", startDate: `2027-01-${String(k).padStart(2, "0")}`, homeId: +h, awayId: +a, homePoints: hp, awayPoints: ap, notes});
  const post = [g(1, t[4], t[11], "CFP First Round"), g(2, t[5], t[10], "CFP First Round"), g(3, t[6], t[9], "CFP First Round"), g(4, t[7], t[8], "CFP First Round"),
    g(5, t[0], t[7], "CFP Quarterfinal"), g(6, t[1], t[6], "CFP Quarterfinal"), g(7, t[2], t[5], "CFP Quarterfinal"), g(8, t[3], t[4], "CFP Quarterfinal"),
    g(9, t[0], t[3], "CFP Semifinal"), g(10, t[1], t[2], "CFP Semifinal"), g(11, t[0], t[1], "CFP National Championship", 10, 20),
    {id: 99, seasonType: "postseason", startDate: "2026-12-20", homeId: +t[0], awayId: +t[1], notes: "Some Bowl"}];
  const out = actualOutcome([], post, demo.teams);
  assert.equal(out.note, "");
  assert.equal(out.field.length, 12);
  assert.deepEqual(out.byes.sort(), t.slice(0, 4).sort());
  assert.deepEqual(out.hosts, t.slice(4, 8));
  assert.equal(out.natl, t[1], "the away team won the final");
  assert.match(actualOutcome([], post.slice(0, 5), demo.teams).note, /found 5 playoff games/);
});

test("game scores and log loss behave", () => {
  assert.ok(Math.abs(logLoss(0.5, 1) - Math.log(2)) < 1e-12);
  assert.ok(logLoss(1, 0) < 10, "clipped, never infinite");
  const R = {a: 10, b: 0};
  const good = gameScores([{home: "a", away: "b", neutral: true, homeWon: true}], R, 0, 10, -20);
  const bad = gameScores([{home: "a", away: "b", neutral: true, homeWon: false}], R, 0, 10, -20);
  assert.ok(good.logLoss < bad.logLoss);
  assert.equal(good.games, 1);
});

test("odds snapshots are compact and one per day", () => {
  const snap = oddsSnapshot(demo, "2026-10-06", 300);
  assert.equal(snap.week, demo.currentWeek);
  const total = Object.values(snap.cfp).reduce((s, v) => s + v, 0);
  assert.ok(Math.abs(total - 12) < 0.05, `field adds to 12 (got ${total})`);
  assert.ok(Object.values(snap.cfp).every(v => v > 0 && v <= 1));
  let h = addSnapshot(null, snap, 2026);
  h = addSnapshot(h, {...snap, date: "2026-10-07"}, 2026);
  h = addSnapshot(h, {...snap, date: "2026-10-06", week: 99}, 2026);
  assert.deepEqual(h.snapshots.map(s => s.date), ["2026-10-06", "2026-10-07"]);
  assert.equal(h.snapshots[0].week, 99, "same day replaces");
  assert.equal(addSnapshot(h, snap, 2027).snapshots.length, 1, "a new season starts over");
  assert.deepEqual(JSON.parse(serializeHistory(h)), h);
});

test("national stakes: ranked by weight, values in range, forced runs match", async () => {
  const {weekStakes} = await import("../scripts/stakes.mjs");
  const {defaultState, prepare} = await import("../js/model.js");
  const {simulate} = await import("../js/sim.js");
  const out = weekStakes(demo, {N: 300, top: 5, date: "2026-10-07"});
  assert.equal(out.week, demo.currentWeek);
  assert.equal(out.games.length, 5);
  for (let k = 1; k < out.games.length; k++) assert.ok(out.games[k - 1].weight >= out.games[k].weight);
  for (const g of out.games) {
    assert.ok(g.weight <= g.stake + 1e-9, "weight never exceeds stake");
    for (const s of [g.home, g.away].filter(Boolean)) assert.ok(s.pWin >= 0 && s.pWin <= 1 && s.ifWin >= 0 && s.ifLose <= 1);
  }
  // The home side's "if it wins" chance equals a direct run with that game forced.
  const g = out.games[0], st = defaultState();
  st.settings.N = 300; st.forced = {[g.id]: 2};
  const P = prepare(demo, st), A = simulate(P, true), i = demo.teams.findIndex(t => t.id === g.home.id);
  assert.ok(Math.abs(A.cfp[i] / 300 - g.home.ifWin) < 0.001);
});
