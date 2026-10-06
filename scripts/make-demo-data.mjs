#!/usr/bin/env node
// Writes data/demo.json: a synthetic season the page falls back to until the
// update workflow publishes data/season.json. Team names and conferences are
// real; ratings, schedule and scores are made up.
import {writeFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import path from "node:path";
import {makeRng, gauss} from "../js/sim.js";
import {computeWeek} from "../js/model.js";
import {HOSTED_TITLE, serialize} from "./sources.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const YEAR = 2026, CURRENT = 7, rng = makeRng(2026, 7);

const CONFS = [
  ["SEC", 9, 9, "Georgia 22, Texas 21, Alabama 19, Ole Miss 18, Texas A&M 18, Oklahoma 17, LSU 17, Tennessee 15, Missouri 12, Florida 12, Vanderbilt 12, South Carolina 11, Auburn 11, Arkansas 8, Mississippi State 7, Kentucky 6"],
  ["Big Ten", 9, 7, "Ohio State, Oregon, Penn State, Michigan, Indiana, USC, Washington, Illinois, Iowa, Nebraska, Wisconsin, Minnesota, UCLA, Maryland, Michigan State, Rutgers, Northwestern, Purdue"],
  ["ACC", 8, 3, "Clemson, Miami, Louisville, SMU, Georgia Tech, Florida State, Duke, North Carolina, NC State, Pittsburgh, Virginia, Virginia Tech, Boston College, Syracuse, California, Wake Forest, Stanford"],
  ["Big 12", 9, 4, "Texas Tech, BYU, Utah, Arizona State, Kansas State, Iowa State, Baylor, TCU, Colorado, Houston, Cincinnati, Kansas, West Virginia, UCF, Arizona, Oklahoma State"],
  ["American Athletic", 8, -5, "Tulane, Memphis, Army, Navy, UTSA, South Florida, East Carolina, North Texas, Florida Atlantic, Rice, Tulsa, Temple, UAB, Charlotte"],
  ["Mountain West", 8, -9, "UNLV, San José State, Air Force, Hawai'i, Wyoming, Nevada, New Mexico, UTEP, Northern Illinois"],
  ["Pac-12", 7, -5, "Boise State, Washington State, Oregon State, Fresno State, San Diego State, Utah State, Colorado State, Texas State"],
  ["Sun Belt", 8, -7, "James Madison:East, Appalachian State:East, Coastal Carolina:East, Georgia Southern:East, Georgia State:East, Marshall:East, Old Dominion:East, Louisiana:West, Troy:West, South Alabama:West, Arkansas State:West, Southern Miss:West, Louisiana Tech:West, UL Monroe:West"],
  ["Mid-American", 8, -11, "Toledo, Ohio, Miami (OH), Buffalo, Bowling Green, Western Michigan, Central Michigan, Eastern Michigan, Ball State, Akron, Kent State, Massachusetts, Sacramento State"],
  ["Conference USA", 8, -12, "Liberty, Jacksonville State, Western Kentucky, Sam Houston, Kennesaw State, Middle Tennessee, FIU, New Mexico State, Delaware, Missouri State"],
  ["FBS Independents", 0, 0, "Notre Dame 20, UConn -6"]
];
const FCS = ["Montana State", "South Dakota State", "UC Davis", "Villanova", "Furman", "Idaho", "Mercer", "Chattanooga", "Incarnate Word",
  "Abilene Christian", "Southern Illinois", "Youngstown State", "Austin Peay", "Western Carolina", "ETSU", "Samford", "Lamar", "Nicholls",
  "Tarleton State", "Eastern Washington", "Weber State", "Richmond", "Elon", "Holy Cross"];

const teams = [], truth = [];
for (const [conf, , mean, list] of CONFS) {
  for (const entry of list.split(", ")) {
    const m = entry.match(/^(.*?)(?: (-?\d+))?(?::(\w+))?$/), name = m[1];
    const r = m[2] != null ? +m[2] : mean + 6 * gauss(rng) + (list.indexOf(entry) < list.length / 3 ? 4 : 0);
    teams.push({id: String(1000 + teams.length), name, abbr: name.replace(/[^A-Z]/g, "").slice(0, 4) || name.slice(0, 4).toUpperCase(), conf, div: m[3] || null});
    truth.push(r);
  }
}
const n = teams.length, idx = new Map(teams.map((t, i) => [t.id, i]));
const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

// Conference games: circle-method rounds in the last k weeks of a 13-week
// season; non-conference games and one bye fill the earlier weeks.
const games = [], busy = teams.map(() => new Set());
let gid = 401000;
const add = (week, h, a, extra = {}) => {
  const g = {id: String(gid++), week, date: new Date(Date.UTC(YEAR, 8, 5 + 7 * (week - 1), 19, 30)).toISOString(),
    home: h >= 0 ? teams[h].id : null, away: a >= 0 ? teams[a].id : null, neutral: false, conf: false, champ: false, hp: null, ap: null, ...extra};
  if (h < 0) g.homeName = FCS[Math.floor(rng() * FCS.length)];
  if (a < 0) g.awayName = FCS[Math.floor(rng() * FCS.length)];
  games.push(g);
  if (h >= 0) busy[h].add(week);
  if (a >= 0) busy[a].add(week);
};
const confGames = new Map(CONFS.map(c => [c[0], c[1]]));
for (const [conf, k] of CONFS) {
  if (!k) continue;
  const mem = shuffle(teams.map((t, i) => t.conf === conf ? i : -1).filter(i => i >= 0));
  if (mem.length % 2) mem.push(-1);
  const m = mem.length;
  for (let rd = 0; rd < Math.min(k, m - 1); rd++) {
    const week = 13 - k + 1 + rd, rot = [mem[0], ...mem.slice(1).map((_, j) => mem[1 + ((j + rd) % (m - 1))])];
    for (let q = 0; q < m / 2; q++) {
      let h = rot[q], a = rot[m - 1 - q];
      if (h < 0 || a < 0) continue;
      if ((rd + q) % 2) [h, a] = [a, h];
      add(week, h, a, {conf: true});
    }
  }
}
const byeWeek = teams.map((t, i) => 1 + Math.floor(rng() * (13 - (confGames.get(t.conf) || 4))));
for (let week = 1; week <= 13; week++) {
  const free = shuffle(teams.map((_, i) => i).filter(i => !busy[i].has(week) && byeWeek[i] !== week && week <= 13 - (confGames.get(teams[i].conf) || 0)));
  while (free.length) {
    const h = free.pop();
    if (week <= 2 && rng() < 0.35) { add(week, h, -1); continue; }
    const k = free.findIndex(o => teams[o].conf !== teams[h].conf || teams[h].conf === "FBS Independents");
    if (k < 0) { add(week, h, -1); continue; }
    const [a] = free.splice(k, 1);
    add(week, h, a, {neutral: week === 1 && rng() < 0.1});
  }
}

for (const g of games) {
  if (g.week >= CURRENT) continue;
  const h = g.home ? idx.get(g.home) : -1, a = g.away ? idx.get(g.away) : -1;
  const margin = (h >= 0 ? truth[h] : -20) - (a >= 0 ? truth[a] : -20) + (g.neutral ? 0 : 2.5) + 13.5 * gauss(rng);
  let total = Math.max(14, Math.round(48 + 12 * gauss(rng))), m = Math.round(margin) || (margin > 0 ? 1 : -1);
  if (Math.abs(m) > total) total = Math.abs(m) + 3;
  g.hp = Math.round((total + m) / 2); g.ap = g.hp - m;
  if (g.ap < 0) { g.hp -= g.ap; g.ap = 0; }
  if (g.hp === g.ap) g.hp += 3;
}

// Ratings: SP+ and FPI as noisy views of the true strength, plus weekly Elo
// snapshots that drift from a preseason guess toward the truth.
const noisy = sd => Object.fromEntries(teams.map((t, i) => [t.id, Math.round((truth[i] + sd * gauss(rng)) * 10) / 10]));
const history = [];
const pre = truth.map(r => r + 5 * gauss(rng));
for (let w = 1; w <= CURRENT; w++) {
  const f = (w - 1) / (CURRENT + 4);
  history.push({week: w, date: new Date(Date.UTC(YEAR, 8, 1 + 7 * (w - 1))).toISOString(),
    ratings: {elo: Object.fromEntries(teams.map((t, i) => [t.id, Math.round((pre[i] * (1 - f) + truth[i] * f + 1.2 * gauss(rng)) * 10) / 10]))}});
}
const current = {sp: noisy(2), fpi: noisy(2.5), elo: history[history.length - 1].ratings.elo};
Object.assign(history[history.length - 1].ratings, current);
const season = {format: "fbs-sim-season", version: 1, season: YEAR, demo: true, source: "Demo data (synthetic ratings and scores)",
  updated: new Date(Date.UTC(YEAR, 9, 6, 12)).toISOString(), currentWeek: computeWeek(games),
  conferences: CONFS.map(([name]) => {
    const divs = new Set(teams.filter(t => t.conf === name && t.div).map(t => t.div));
    return {name, format: /independent/i.test(name) ? "none" : divs.size >= 2 ? "divisions" : "top2", hosted: HOSTED_TITLE.has(name)};
  }),
  teams, games, ratings: current, ratingNames: {sp: "SP+", fpi: "FPI", elo: "Elo"}, history};

await writeFile(path.join(root, "data", "demo.json"), serialize(season));
console.log(`Wrote data/demo.json: ${n} teams, ${games.length} games, current week ${season.currentWeek}`);
