#!/usr/bin/env node
// Backtests the simulator on past seasons: rebuilds each season as it stood
// at week 6, week 10 and selection day (Elo as of that week, later scores
// hidden), scores the forecasts against what happened, and searches for
// better settings.
//
//   CFBD_API_KEY=... node scripts/backtest.mjs [--years 2024,2025]
//
// Prints a report (also written to the GitHub Actions job summary).
import {appendFile} from "node:fs/promises";
import {DEF_SETTINGS, DEF_CFP} from "../js/model.js";
import {normTeams, normGames, eloByWeek} from "./sources.mjs";
import {cfbdClient} from "./net.mjs";
import {asOf, actualOutcome, gameScores, seasonScores} from "./backtest-lib.mjs";

const args = process.argv.slice(2), yi = args.indexOf("--years");
const YEARS = yi >= 0 ? args[yi + 1].split(",").map(Number) : [2024, 2025];
// 2024 gave byes to the top four conference champions; 2025 seeded straight.
const SEEDING = {2024: "champs"};
const CUTS = [6, 10, "selection"];
const lines = [];
const say = (s = "") => { console.log(s); lines.push(s); };
const f3 = x => x == null ? "—" : x.toFixed(3);
const pct = x => (x * 100).toFixed(0) + "%";

async function main() {
  const cfbd = cfbdClient();
  const data = {};
  say("# Backtest");
  for (const year of YEARS) {
    const teams = normTeams(await cfbd(`/teams/fbs?year=${year}`));
    const reg = await cfbd(`/games?year=${year}&seasonType=regular`), post = await cfbd(`/games?year=${year}&seasonType=postseason`);
    const games = normGames(reg, teams), eloWeeks = eloByWeek(reg, teams), actual = actualOutcome(games, post, teams);
    const name = new Map(teams.map(t => [t.id, t.name])), nm = ids => ids ? ids.map(id => name.get(id) || id).join(", ") : "—";
    say(`\n## ${year}: what happened`);
    say(`${teams.length} FBS teams, ${games.length} regular-season games, Elo weeks ${Object.keys(eloWeeks).join(",")}`);
    say(`Conference champions: ${Object.entries(actual.champs).map(([c, id]) => `${c} ${name.get(id)}`).join("; ") || "none found"}`);
    say(`Playoff field: ${nm(actual.field)}`);
    say(`Byes: ${nm(actual.byes)} · First-round hosts: ${nm(actual.hosts)} · Champion: ${actual.natl ? name.get(actual.natl) : "—"}`);
    if (actual.note) say(`Note: ${actual.note}`);
    data[year] = {actual, name, cut: Object.fromEntries(CUTS.map(c => [c, asOf({year, teams, games, eloWeeks}, c)]))};
  }

  // 1. Game model: home field, total spread of outcomes, FCS rating.
  say("\n## Game forecasts (weeks 6 and 10, all later games)");
  const base = {hfa: DEF_SETTINGS.hfa, sd: Math.hypot(DEF_SETTINGS.gsd, Math.SQRT2 * DEF_SETTINGS.rsd), fcs: DEF_SETTINGS.fcs};
  const gameLoss = ({hfa, sd, fcs}) => {
    let t = 0, k = 0;
    for (const y of YEARS) for (const c of [6, 10]) {
      const {season, future} = data[y].cut[c], g = gameScores(future, season.ratings.elo, hfa, sd, fcs);
      t += g.logLoss * g.games; k += g.games;
    }
    return t / k;
  };
  const grid = [];
  for (const hfa of [0, 1, 1.5, 2, 2.5, 3, 4]) for (let sd = 11; sd <= 22; sd += 1) for (const fcs of [-15, -20, -25, -30])
    grid.push({hfa, sd, fcs, loss: gameLoss({hfa, sd, fcs})});
  grid.sort((a, b) => a.loss - b.loss);
  const bestGame = grid[0];
  say(`Current settings (home field ${base.hfa}, outcome SD ${base.sd.toFixed(1)}, FCS ${base.fcs}): log loss ${f3(gameLoss(base))}`);
  say(`Best: home field ${bestGame.hfa}, outcome SD ${bestGame.sd}, FCS ${bestGame.fcs}: log loss ${f3(bestGame.loss)}`);
  say(`(A coin flip scores 0.693. Next best: ${grid.slice(1, 4).map(g => `${g.hfa}/${g.sd}/${g.fcs} ${f3(g.loss)}`).join(", ")})`);

  // 2. Split the outcome spread between season-long rating error (rsd) and
  // game-to-game noise (gsd) using season-level results.
  say("\n## Rating uncertainty (season forecasts at weeks 6 and 10)");
  const settingsFor = rsd => ({source: "elo", seed: 1, hfa: bestGame.hfa, fcs: bestGame.fcs, rsd,
    gsd: Math.sqrt(Math.max(1, bestGame.sd ** 2 - 2 * rsd * rsd))});
  const seasonLoss = (settings, cfp, cuts, N) => {
    let t = 0;
    for (const y of YEARS) for (const c of cuts) {
      const r = seasonScores(data[y].cut[c].season, data[y].actual, settings, {...cfp, seeding: SEEDING[y] || "straight"}, N);
      t += (r.champ || 0) + (r.cfp || 0) / 12;
    }
    return t;
  };
  let bestRsd = null;
  for (const rsd of [0, 2, 3, 4, 5, 6]) {
    if (2 * rsd * rsd >= bestGame.sd ** 2) continue;
    const loss = seasonLoss(settingsFor(rsd), DEF_CFP, [6, 10], 2000);
    say(`rating SD ${rsd}: score ${f3(loss)}`);
    if (!bestRsd || loss < bestRsd.loss) bestRsd = {rsd, loss};
  }
  const tunedSettings = settingsFor(bestRsd.rsd);
  say(`Best rating SD: ${bestRsd.rsd} (game noise SD ${tunedSettings.gsd.toFixed(1)})`);

  // 3. Committee: on selection day every game is decided, so only the
  // committee model is being tested.
  say("\n## Committee (selection day)");
  const committeeLoss = cfp => {
    let t = 0;
    for (const y of YEARS) {
      const r = seasonScores(data[y].cut.selection.season, data[y].actual, tunedSettings, {...cfp, seeding: SEEDING[y] || "straight"}, 1000);
      t += (r.cfp || 0) + (r.bye || 0) + (r.host || 0);
    }
    return t;
  };
  const cands = [];
  for (const sorW of [6, 9, 12]) for (const indSD of [1, 1.5, 2.5]) for (const champBonus of [3, 6, 9, 12])
    for (const h2hWin of [3, 6, 9]) for (const titleLossW of [0, 0.25, 0.5]) {
      const cfp = {...DEF_CFP, model: "sor", sorW, indSD, champBonus, h2hWin, titleLossW};
      cands.push({cfp, loss: committeeLoss(cfp)});
    }
  for (const lossPen of [4, 6, 8]) for (const sosW of [0.4, 1]) {
    const cfp = {...DEF_CFP, model: "losses", lossPen, sosW};
    cands.push({cfp, loss: committeeLoss(cfp)});
  }
  cands.sort((a, b) => a.loss - b.loss);
  const show = c => c.cfp.model === "sor"
    ? `SOR weight ${c.cfp.sorW}, noise ${c.cfp.indSD}, champ bonus ${c.cfp.champBonus}, h2h window ${c.cfp.h2hWin}, title-loss weight ${c.cfp.titleLossW}`
    : `flat losses: penalty ${c.cfp.lossPen}, SoS weight ${c.cfp.sosW}`;
  say(`Current defaults: score ${f3(committeeLoss(DEF_CFP))}`);
  cands.slice(0, 5).forEach((c, k) => say(`${k + 1}. ${show(c)}: score ${f3(c.loss)}`));
  const bestLosses = cands.find(c => c.cfp.model === "losses");
  say(`Best flat-loss model: ${show(bestLosses)}: score ${f3(bestLosses.loss)}`);
  const tunedCfp = cands[0].cfp;

  // 4. Before and after, by year and week.
  say("\n## Current vs tuned settings");
  say("Lower is better. champ = conference champion log loss (per conference); cfp/bye/host = log loss summed over all FBS teams; title = log loss of the actual champion.");
  const curSettings = {source: "elo", seed: 1, hfa: DEF_SETTINGS.hfa, gsd: DEF_SETTINGS.gsd, rsd: DEF_SETTINGS.rsd, fcs: DEF_SETTINGS.fcs};
  say("| Season | As of | Settings | champ | cfp | bye | host | title |");
  say("| --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const y of YEARS) for (const c of CUTS) for (const [label, st, cfp] of [["current", curSettings, DEF_CFP], ["tuned", tunedSettings, tunedCfp]]) {
    const r = seasonScores(data[y].cut[c].season, data[y].actual, st, {...cfp, seeding: SEEDING[y] || "straight"}, 5000);
    say(`| ${y} | ${c === "selection" ? "selection day" : `week ${c}`} | ${label} | ${f3(r.champ)} | ${f3(r.cfp)} | ${f3(r.bye)} | ${f3(r.host)} | ${f3(r.natl)} |`);
    if (label === "tuned" && r.pIn) say(`|  |  | P(in) for the actual field | ${Object.entries(r.pIn).map(([id, p]) => `${data[y].name.get(id)} ${pct(p)}`).join(", ")} |  |  |  |  |`);
  }

  const best = {settings: {hfa: bestGame.hfa, gsd: +tunedSettings.gsd.toFixed(1), rsd: bestRsd.rsd, fcs: bestGame.fcs}, cfp: tunedCfp};
  say("\n## Suggested defaults");
  say("```json\n" + JSON.stringify(best) + "\n```");
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, lines.join("\n") + "\n");
}

main().catch(e => { console.error("error:", e.message); process.exit(1); });
