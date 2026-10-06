import test from "node:test";
import assert from "node:assert/strict";
import {validateSeason, validateState, migrateV1, resultsRatings, prepare, defaultState, resolveSource} from "../js/model.js";
import {normTeams, normGames, eloByWeek, normRatings, parseSheet, sheetCsvUrl, buildSeason, serialize, sameData, makeMatcher, parseCsv} from "../scripts/sources.mjs";

const TEAMS = normTeams([
  {id: 333, school: "Alabama", abbreviation: "ALA", conference: "SEC", classification: "fbs"},
  {id: 145, school: "Ole Miss", abbreviation: "MISS", conference: "SEC", classification: "fbs"},
  {id: 2390, school: "Miami", abbreviation: "MIA", conference: "ACC", classification: "fbs"},
  {id: 193, school: "Miami (OH)", abbreviation: "M-OH", conference: "Mid-American", classification: "fbs"},
  {id: 6, school: "South Alabama", conference: "Sun Belt", division: "West", classification: "fbs"},
  {id: 2433, school: "UL Monroe", conference: "Sun Belt", division: "West", classification: "fbs"},
  {id: 2026, school: "Appalachian State", conference: "Sun Belt", division: "East", classification: "fbs"},
  {id: 23, school: "San José State", conference: "Mountain West", classification: "fbs"},
  {id: 87, school: "Notre Dame", conference: "FBS Independents", classification: "fbs"},
  {id: 9999, school: "Montana", conference: "Big Sky", classification: "fcs"}
]);

test("CFBD teams: FBS only, ids as strings", () => {
  assert.equal(TEAMS.length, 9);
  assert.ok(TEAMS.every(t => typeof t.id === "string"));
});

test("CFBD games: v2 camelCase and legacy snake_case both parse", () => {
  const games = normGames([
    {id: 1, week: 1, seasonType: "regular", startDate: "2026-09-05T23:00:00.000Z", completed: true, neutralSite: false, conferenceGame: true,
      homeId: 333, homeTeam: "Alabama", awayId: 145, awayTeam: "Ole Miss", homePoints: 24, awayPoints: 21},
    {id: 2, week: 2, season_type: "regular", start_date: "2026-09-12T23:00:00.000Z", completed: false, neutral_site: true, conference_game: false,
      home_id: 2390, home_team: "Miami", away_id: 9999, away_team: "Montana", home_points: null, away_points: null},
    {id: 3, week: 15, seasonType: "regular", startDate: "2026-12-05T21:00:00.000Z", completed: false, neutralSite: true, conferenceGame: true,
      homeId: 333, awayId: 145, notes: "SEC Championship"},
    {id: 4, week: 1, seasonType: "postseason", homeId: 333, awayId: 145}
  ], TEAMS);
  assert.equal(games.length, 3);
  assert.deepEqual(games[0], {id: "1", week: 1, date: "2026-09-05T23:00:00.000Z", home: "333", away: "145", neutral: false, conf: true, champ: false, hp: 24, ap: 21});
  assert.equal(games[1].away, null);
  assert.equal(games[1].awayName, "Montana");
  assert.equal(games[1].neutral, true);
  assert.equal(games[2].champ, true);
});

test("CFBD ratings: Elo converted to points and centered", () => {
  const elo = normRatings("elo", TEAMS.map((t, i) => ({team: t.name, elo: 1500 + i * 50})), TEAMS);
  const vals = Object.values(elo);
  assert.ok(Math.abs(vals.reduce((a, b) => a + b, 0)) < 0.05);
  const gap = TEAMS.findIndex(t => t.id === "145") - TEAMS.findIndex(t => t.id === "333");
  assert.equal(elo["145"] - elo["333"], gap * 50 / 25);
  assert.equal(normRatings("sp", [{team: "Alabama", rating: 20}], TEAMS), null);
});

test("CFBD SP+, FPI and SRS are stored exactly as published", () => {
  const rows = TEAMS.map((t, i) => ({team: t.name, rating: 30.1 - i * 3.3, fpi: 12.4 + i}));
  const sp = normRatings("sp", rows, TEAMS), fpi = normRatings("fpi", rows, TEAMS);
  TEAMS.forEach((t, i) => {
    assert.equal(sp[t.id], rows[i].rating);
    assert.equal(fpi[t.id], rows[i].fpi);
  });
});

test("team-name matching handles common variants", () => {
  const m = makeMatcher(TEAMS);
  assert.equal(m("Mississippi"), "145");
  assert.equal(m("Miami (FL)"), "2390");
  assert.equal(m("Miami Ohio"), "193");
  assert.equal(m("San Jose State"), "23");
  assert.equal(m("ULM"), "2433");
  assert.equal(m("App State"), "2026");
  assert.equal(m("Montana"), null);
});

test("CSV parser handles quotes, commas and blank rows", () => {
  assert.deepEqual(parseCsv('a,"b, c","d ""q"""\r\n\r\n1,2,3'), [["a", "b, c", 'd "q"'], ["1", "2", "3"]]);
});

const names = TEAMS.map(t => t.name);
test("sheet: single rating column, with a title row above the header", () => {
  const csv = `My ratings,,\nRank,Team,Rating\n${names.map((n, i) => `${i + 1},"${n}",${20 - i * 3}`).join("\n")}\n`;
  const s = parseSheet(csv, TEAMS);
  assert.equal(Object.keys(s.latest).length, 9);
  assert.ok(s.latest["333"] > s.latest["145"]);
  assert.equal(s.latestWeek, null);
});

test("sheet: wide layout with one column per week", () => {
  const csv = `Team,Preseason,Week 1,Week 2,Week 3\n${names.map((n, i) => `${n},${i},${i + 1},${i * 2},`).join("\n")}`;
  const s = parseSheet(csv, TEAMS);
  assert.deepEqual(Object.keys(s.byWeek).map(Number), [0, 1, 2]);
  assert.equal(s.latestWeek, 2);
  const gap = TEAMS.findIndex(t => t.id === "145") - TEAMS.findIndex(t => t.id === "333");
  assert.equal(s.latest["145"] - s.latest["333"], gap * 2);
});

test("sheet: long layout with team, week and rating columns", () => {
  const rows = [];
  for (const w of [1, 2]) names.forEach((n, i) => rows.push(`${w},${n},${w * 10 + i}`));
  const s = parseSheet(`Week,School,Power\n${rows.join("\n")}`, TEAMS);
  assert.equal(s.latestWeek, 2);
  assert.deepEqual(Object.keys(s.byWeek).map(Number), [1, 2]);
});

test("sheet: explains when too few teams match", () => {
  assert.throws(() => parseSheet("Team,Rating\nFoo,1\nBar,2", TEAMS), /fewer than half/);
  assert.throws(() => parseSheet("x,y\n1,2", TEAMS), /team column/);
});

test("Google Sheets edit links become CSV export links", () => {
  assert.equal(sheetCsvUrl("https://docs.google.com/spreadsheets/d/abc_123/edit?gid=42#gid=42"),
    "https://docs.google.com/spreadsheets/d/abc_123/export?format=csv&gid=42");
});

test("buildSeason keeps history, formats conferences, and round-trips through validation", () => {
  const games = [{id: "1", week: 1, date: "", home: "333", away: "145", neutral: false, conf: true, champ: false, hp: 24, ap: 21},
    {id: "2", week: 2, date: "", home: "2390", away: "193", neutral: false, conf: false, champ: false, hp: null, ap: null}];
  const r = Object.fromEntries(TEAMS.map((t, i) => [t.id, i]));
  const s1 = buildSeason({year: 2026, teams: TEAMS, games, ratings: {sp: r}, sheetWeeks: {0: r, 1: r}, prev: null, now: "t1"});
  assert.equal(s1.currentWeek, 2);
  assert.deepEqual(s1.history.map(h => h.week), [0, 1, 2]);
  assert.equal(s1.conferences.find(c => c.name === "Sun Belt").format, "divisions");
  assert.equal(s1.conferences.find(c => c.name === "Sun Belt").hosted, true);
  assert.equal(s1.conferences.find(c => c.name === "FBS Independents").format, "none");
  assert.equal(s1.conferences[0].name, "SEC");
  const s2 = buildSeason({year: 2026, teams: TEAMS, games, ratings: {}, prev: JSON.parse(serialize(s1)), now: "t2"});
  assert.deepEqual(s2.ratings.sp, r);
  assert.ok(sameData(s1, s2));
  const {season, warnings} = validateSeason(JSON.parse(serialize(s1)));
  assert.deepEqual(warnings, []);
  assert.equal(season.games.length, 2);
});

test("season validation rejects unusable files and skips bad rows", () => {
  assert.throws(() => validateSeason(null));
  assert.throws(() => validateSeason({teams: [], games: []}), /two valid teams/);
  const {season, warnings} = validateSeason({
    teams: [{id: 1, name: "A", conf: "X"}, {id: 2, name: "B", conf: "X"}, {id: 2, name: "Dup"}, {name: "No id"}],
    games: [{id: "g1", week: 1, home: 1, away: 2, hp: 7, ap: 3}, {id: "g2", week: 1, home: 1, away: 99},
      {id: "g1", week: 2, home: 2, away: 1}, {id: "g3", week: "x", home: 1, away: 2}, {id: "g4", week: 3, home: 1, away: null, awayName: "<b>FCS</b>"}],
    ratings: {sp: {1: 5, 2: "bad", 99: 3}, "bad key!": {1: 1}}
  });
  assert.equal(season.teams.length, 2);
  assert.equal(season.games.length, 2);
  assert.equal(warnings.length, 2);
  assert.deepEqual(season.ratings, {sp: {1: 5}});
});

test("state validation clamps values and drops junk", () => {
  const s = validateState({settings: {N: 1e9, gsd: -4, hfa: "3", source: "<script>"}, cfp: {field: 12.4, forgive: "yes"},
    overrides: {a: 500, b: "x"}, forced: {g1: 2, g2: 3}, view: {conf: 7, heat: "wins", sort: {key: "evil", dir: 1}}});
  assert.equal(s.settings.N, 200000);
  assert.equal(s.settings.gsd, 0);
  assert.equal(s.settings.hfa, 3);
  assert.equal(s.settings.source, "auto");
  assert.equal(s.cfp.field, 12);
  assert.equal(s.cfp.forgive, true);
  assert.deepEqual(s.overrides, {a: 80});
  assert.deepEqual(s.forced, {g1: 2});
  assert.equal(s.view.conf, "SEC");
  assert.equal(s.view.heat, "wins");
  assert.equal(s.view.sort, null);
  assert.deepEqual(validateState("nope"), defaultState());
  assert.equal(migrateV1({settings: {hfa: 3}, cfp: {lossPen: 8}}).cfp.lossPen, 8);
});

test("results model moves ratings toward margins", () => {
  const {season} = validateSeason({teams: [{id: "a", name: "A", conf: "X"}, {id: "b", name: "B", conf: "X"}],
    games: [{id: "1", week: 1, home: "a", away: "b", neutral: true, hp: 30, ap: 10}], ratings: {sp: {a: 0, b: 0}}});
  const r = resultsRatings(season, {hfa: 2.5, fcs: -20, priorW: 1, cap: 28});
  assert.ok(r.a > 5 && r.b < -5);
  const capped = resultsRatings(season, {hfa: 2.5, fcs: -20, priorW: 1, cap: 7});
  assert.ok(capped.a < r.a);
  const P = prepare(season, defaultState());
  assert.equal(P.W0[0], 1);
});

test("weekly Elo history comes from pregame Elo, carrying postgame Elo through byes", () => {
  const ids = TEAMS.map(t => +t.id), games = [];
  // Week 1: everyone plays (pairs), pregame 1500 + 10*i; week 2: only the first pair plays.
  for (let i = 0; i + 1 < ids.length; i += 2) {
    games.push({id: i, week: 1, seasonType: "regular", homeId: ids[i], awayId: ids[i + 1],
      homePregameElo: 1500 + 10 * i, awayPregameElo: 1500 + 10 * (i + 1), homePostgameElo: 1600, awayPostgameElo: 1400});
  }
  games.push({id: 99, week: 2, season_type: "regular", home_id: ids[0], away_id: ids[1], home_pregame_elo: 1650, away_pregame_elo: 1350});
  const h = eloByWeek(games, TEAMS);
  assert.deepEqual(Object.keys(h).map(Number), [1, 2]);
  assert.ok(Math.abs(h[1][String(ids[1])] - h[1][String(ids[0])] - 10 / 25) < 0.011);
  // Week 2: team 0 uses its new pregame Elo; team 2 (bye) carries its postgame 1600.
  assert.ok(Math.abs(h[2][String(ids[0])] - h[2][String(ids[2])] - 50 / 25) < 0.011);
  const s = buildSeason({year: 2026, teams: TEAMS, games: [{id: "x", week: 2, date: "", home: "333", away: "145", neutral: false, conf: true, champ: false, hp: null, ap: null}],
    ratings: {sp: {333: 1}}, eloWeeks: h, prev: null, now: "t"});
  assert.deepEqual(s.history.map(x => [x.week, Object.keys(x.ratings).sort().join()]), [[1, "elo"], [2, "sp"]]);
});

test("SP+ is the default source when present, even alongside a sheet", () => {
  const {season} = validateSeason({teams: [{id: "a", name: "A"}, {id: "b", name: "B"}], games: [],
    ratings: {sheet: {a: 1, b: 2}, elo: {a: 0, b: 0}, sp: {a: 5, b: -5}}});
  assert.equal(resolveSource(season, "auto"), "sp");
  assert.equal(resolveSource(season, "elo"), "elo");
  delete season.ratings.sp;
  assert.equal(resolveSource(season, "auto"), "sheet");
});

test("Army–Navy counts toward overall records but not AAC standings", () => {
  const teams = normTeams([{id: 349, school: "Army", conference: "American Athletic"}, {id: 2426, school: "Navy", conference: "American Athletic"}]);
  const [g] = normGames([{id: 5, week: 15, seasonType: "regular", startDate: "2026-12-12T20:00:00.000Z", conferenceGame: true, neutralSite: true,
    homeId: 349, awayId: 2426}], teams);
  assert.equal(g.conf, false);
  assert.equal(g.champ, false);
});
