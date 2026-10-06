import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {makeRanker, simulate, bracketSlots} from "../js/sim.js";
import {validateSeason, defaultState, prepare, bracketError} from "../js/model.js";

// A small conference: `games` lists [winner, loser] results among teams 0..n-1.
function standings(n, games, ratings = Array(n).fill(0), extraPlayed = []) {
  const G2 = new Uint8Array(n * n), wins = new Int16Array(n * n), CW = new Int16Array(n), CL = new Int16Array(n);
  for (const [w, l] of games) { G2[w * n + l]++; G2[l * n + w]++; wins[w * n + l]++; CW[w]++; CL[l]++; }
  for (const [a, b] of extraPlayed) { G2[a * n + b]++; G2[b * n + a]++; }
  const confOpps = Array.from({length: n}, (_, i) => Int16Array.from([...Array(n).keys()].filter(j => G2[i * n + j])));
  const rank = makeRanker({n, G2, wins, CW, CL, confOpps, r: Float64Array.from(ratings)});
  return rank([...Array(n).keys()]);
}

test("two-way tie goes to the head-to-head winner, including games already played", () => {
  // 0 and 1 both 2-1; 1 beat 0; the weaker-rated team still wins the tiebreak.
  const ord = standings(4, [[1, 0], [0, 2], [0, 3], [1, 2], [3, 1], [2, 3]], [10, 0, 0, 0]);
  assert.deepEqual(ord.slice(0, 2), [1, 0]);
});

test("three-way tie: the team that beat both others wins it", () => {
  // Records: 0 3-1, 1 2-2, 2 2-2, 3 2-2, 4 1-3. Among the tied 1, 2 and 3,
  // team 1 beat both 2 and 3.
  const ord = standings(5, [[0, 1], [0, 2], [1, 2], [3, 0], [1, 3], [2, 3], [2, 4], [4, 1], [0, 4], [3, 4]]);
  assert.equal(ord[0], 0);
  assert.equal(ord[1], 1);
  assert.equal(ord[4], 4);
});

test("multi-team tie restarts at head-to-head once one team is separated", () => {
  // Teams 0,1,2 tie at 2-1 in a round-robin cycle (0>1, 1>2, 2>0). Common
  // opponent 3 lost to all of them, so the cycle stays tied until the ratings
  // metric picks 2 first; then 0 vs 1 restarts at head-to-head and 0 (who beat 1)
  // finishes ahead even though 1 has the higher rating.
  const ord = standings(4, [[0, 1], [1, 2], [2, 0], [0, 3], [1, 3], [2, 3]], [0, 5, 9, 0]);
  assert.deepEqual(ord, [2, 0, 1, 3]);
});

test("ties between teams that never met use common opponents", () => {
  // 0 and 1 both 2-1 and never played; vs common opponents {2, 3}, 0 is 2-0 and 1 is 1-1.
  const ord = standings(5, [[0, 2], [0, 3], [4, 0], [1, 4], [1, 2], [3, 1], [2, 4], [3, 2]], [0, 10, 0, 0, 0]);
  assert.equal(ord.indexOf(0) < ord.indexOf(1), true);
});

test("bracket slots follow standard seeding", () => {
  assert.deepEqual(bracketSlots(8), [1, 8, 4, 5, 2, 7, 3, 6]);
  assert.deepEqual(bracketSlots(4), [1, 4, 2, 3]);
  assert.equal(bracketError({field: 12, byes: 4, autoBids: 5}), null);
  assert.equal(bracketError({field: 16, byes: 0, autoBids: 5}), null);
  assert.match(bracketError({field: 12, byes: 2, autoBids: 5}), /clean bracket/);
});

const demo = validateSeason(JSON.parse(readFileSync(new URL("../data/demo.json", import.meta.url), "utf8"))).season;
const small = (st = defaultState()) => { st.settings.N = 1500; return prepare(demo, st); };

test("simulation totals are consistent", () => {
  const P = small(), A = simulate(P, true), N = A.N;
  const sum = a => a.reduce((s, v) => s + v, 0) / N;
  assert.equal(sum(A.cfp), 12);
  assert.equal(sum(A.bye), 4);
  assert.equal(sum(A.natl), 1);
  assert.equal(sum(A.ch), P.confs.filter(c => c.format !== "none").length);
  // A team never has more than its scheduled conference wins.
  for (let i = 0; i < P.n; i++) assert.ok(A.scw[i] / N <= P.confG[i] + 1e-9);
});

test("same seed gives identical results; without what-ifs both runs match exactly", () => {
  const P = small();
  assert.deepEqual(simulate(P, true).cfp, simulate(P, false).cfp);
  const Q = small();
  assert.deepEqual(simulate(Q, true).ch, simulate(P, true).ch);
});

test("what-ifs only move conferences they touch (common random numbers)", () => {
  const st = defaultState(), sec = new Set(demo.teams.filter(t => t.conf === "SEC").map(t => t.id));
  const g = demo.games.find(x => x.hp == null && x.conf && sec.has(x.home));
  st.forced[g.id] = 1;
  const P = small(st), A = simulate(P, true), B = simulate(P, false);
  const big10 = P.confs.find(c => c.name === "Big Ten").members;
  for (const i of big10) assert.equal(A.ch[i], B.ch[i]);
  const away = demo.teams.findIndex(t => t.id === g.away);
  assert.ok(A.sw[away] > B.sw[away]);
});

test("rematches are separate what-ifs", () => {
  const raw = JSON.parse(readFileSync(new URL("../data/demo.json", import.meta.url), "utf8"));
  const g = raw.games.find(x => x.hp == null && x.conf);
  raw.games.push({...g, id: "rematch-1", week: 14, champ: true, neutral: true});
  const season = validateSeason(raw).season, st = defaultState();
  st.forced["rematch-1"] = 2;
  const P = prepare(season, st);
  assert.equal(P.forced[P.remIds.indexOf(g.id)], 0);
  assert.equal(P.forced[P.remIds.indexOf("rematch-1")], 2);
});

test("a scheduled title game decides the champion", () => {
  const raw = JSON.parse(readFileSync(new URL("../data/demo.json", import.meta.url), "utf8"));
  const sec = raw.teams.filter(t => t.conf === "SEC");
  raw.games.push({id: "sec-title", week: 15, home: sec[14].id, away: sec[15].id, neutral: true, conf: true, champ: true, hp: null, ap: null});
  const st = defaultState();
  st.settings.N = 400;
  st.forced["sec-title"] = 1;
  const P = prepare(validateSeason(raw).season, st), A = simulate(P, true);
  const away = raw.teams.findIndex(t => t.id === sec[15].id);
  assert.equal(A.ch[away], A.N);
});

test("seed, host, auto-bid and round counts add up every season", () => {
  for (const [field, byes] of [[12, 4], [16, 0]]) {
    const st = defaultState();
    st.cfp.field = field; st.cfp.byes = byes;
    const P = small(st), A = simulate(P, true), N = A.N;
    const sum = (arr, from = 0, stride = 1, count = arr.length) => { let t = 0; for (let k = 0; k < count; k++) t += arr[from + k * stride]; return t; };
    for (let q = 0; q < field; q++) assert.equal(sum(A.seed, q, field, P.n), N, `seed ${q + 1} filled once per season`);
    assert.equal(sum(A.host) / N, (field - byes) / 2);
    assert.equal(sum(A.auto) / N, 5);
    for (let k = 0; k < A.stages; k++) assert.equal(sum(A.reach, k, A.stages, P.n) / N, A.M >> k);
    for (let i = 0; i < P.n; i++) {
      assert.equal(A.reach[i * A.stages + A.stages - 1], A.natl[i]);
      assert.ok(A.bye[i] + A.host[i] <= A.cfp[i]);
    }
  }
});

test("Big 12-style total-wins and committee-rank tiebreak steps", () => {
  // Teams 0 and 1 split 1-1 against each other with no common opponents.
  const n = 2, G2 = Uint8Array.from([0, 2, 2, 0]), wins = Int16Array.from([0, 1, 1, 0]);
  const CW = Int16Array.from([1, 1]), CL = Int16Array.from([1, 1]), confOpps = [Int16Array.from([1]), Int16Array.from([0])];
  const W = Int16Array.from([9, 10]), rankScore = Float64Array.from([5, 1]), r = Float64Array.from([3, 2]);
  const rank = makeRanker({n, G2, wins, CW, CL, confOpps, r, W, rankScore});
  assert.deepEqual(rank([0, 1], [0, 1], ["h2h", "totalWins"]), [1, 0]);
  assert.deepEqual(rank([0, 1], [0, 1], ["h2h", "rank"]), [0, 1]);
  assert.deepEqual(rank([0, 1], [0, 1], ["h2h"]), [0, 1], "falls back to the ratings metric");
});

const tiny = (h2hWin) => {
  // B beat A; A is rated 3 points higher. With a 2-team field the top seed
  // shows who the committee ranked first.
  const {season} = validateSeason({teams: [{id: "a", name: "A"}, {id: "b", name: "B"}, {id: "c", name: "C"}],
    games: [{id: "1", week: 1, home: "a", away: "b", neutral: true, hp: 10, ap: 20}], ratings: {sp: {a: 20, b: 17, c: 0}}});
  const st = defaultState();
  Object.assign(st.settings, {N: 200, rsd: 0});
  Object.assign(st.cfp, {field: 2, byes: 0, autoBids: 0, sorW: 0, indSD: 0, champBonus: 0, h2hWin});
  const P = prepare(season, st), A = simulate(P, true);
  return {A, b: season.teams.findIndex(t => t.id === "b"), F: A.F};
};

test("committee moves a head-to-head winner ahead only within the window", () => {
  const off = tiny(0), on = tiny(5);
  assert.equal(off.A.seed[off.b * off.F], 0, "without the rule the higher-rated loser is seeded first");
  assert.equal(on.A.seed[on.b * on.F], on.A.N, "within 5 points the winner moves ahead");
});

test("2024 bye rule gives byes only to conference champions", () => {
  const st = defaultState(); st.cfp.seeding = "champs";
  const P = small(st), A = simulate(P, true);
  for (let i = 0; i < P.n; i++) if (!A.ch[i]) assert.equal(A.bye[i], 0, `team ${i} never won its conference`);
  assert.equal(A.bye.reduce((s, v) => s + v, 0) / A.N, 4);
});

test("per-game swing counts add up to each side's overall totals", () => {
  const P = small(), A = simulate(P, true);
  P.rem.forEach((g, j) => {
    assert.ok(A.levH[j] >= 0 && A.levH[j] <= A.N);
    if (g.h >= 0) {
      assert.equal(A.lev[j * 8] + A.lev[j * 8 + 2], A.cfp[g.h]);
      assert.equal(A.lev[j * 8 + 1] + A.lev[j * 8 + 3], A.ch[g.h]);
    }
    if (g.a >= 0) assert.equal(A.lev[j * 8 + 4] + A.lev[j * 8 + 6], A.cfp[g.a]);
  });
});
