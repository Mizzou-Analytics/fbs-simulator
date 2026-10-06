#!/usr/bin/env node
// Pulls the FBS schedule, scores and ratings (SP+, FPI, Elo, SRS) from
// CollegeFootballData.com and writes data/season.json. Week-by-week Elo
// history comes from the pregame Elo on each game, so it needs no extra calls.
//
//   CFBD_API_KEY=... node scripts/update-data.mjs [--scores-only] [--year 2026]
//
// --scores-only refreshes games and scores but keeps the stored ratings (used
// on game days to stay inside CFBD's free-tier call limit).
// Settings live in data/sources.json. Optionally, a ratings spreadsheet you
// control can be added there (or via RATINGS_SHEET_URL) as an extra source.
import {readFile, writeFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import path from "node:path";
import {validateSeason} from "../js/model.js";
import {normTeams, normGames, eloByWeek, normRatings, parseSheet, sheetCsvUrl, buildSeason, seasonYear, serialize, sameData} from "./sources.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(root, "data", "season.json");
const args = process.argv.slice(2);
const scoresOnly = args.includes("--scores-only");
const yi = args.indexOf("--year");
const year = yi >= 0 ? Number(args[yi + 1]) : seasonYear(new Date());
const KEY = process.env.CFBD_API_KEY;
const BASE = (process.env.CFBD_BASE_URL || "https://api.collegefootballdata.com").replace(/\/$/, "");

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchRetry(url, init, what) {
  for (let attempt = 1; ; attempt++) {
    let res;
    try { res = await fetch(url, init); } catch (e) { res = null; if (attempt >= 4) throw new Error(`${what}: ${e.message}`); }
    if (res && res.ok) return res;
    if (res && (res.status === 401 || res.status === 403)) throw new Error(`${what}: access denied (HTTP ${res.status})`);
    if (res && res.status < 500 && res.status !== 429) throw new Error(`${what}: HTTP ${res.status}`);
    if (attempt >= 4) throw new Error(`${what}: HTTP ${res ? res.status : "error"} after ${attempt} tries`);
    await sleep(2000 * 2 ** (attempt - 1));
  }
}

const cfbd = async p => (await fetchRetry(BASE + p, {headers: {Authorization: `Bearer ${KEY}`, Accept: "application/json"}}, `CFBD ${p}`)).json();

async function readJson(file) {
  try { return JSON.parse(await readFile(file, "utf8")); } catch { return null; }
}

async function main() {
  if (!KEY) throw new Error("Set CFBD_API_KEY (free key from https://collegefootballdata.com/key).");
  if (!Number.isInteger(year)) throw new Error("--year must be a number");
  const cfg = (await readJson(path.join(root, "data", "sources.json"))) || {};
  const prev = await readJson(OUT);
  const keepPrev = prev && prev.season === year;
  const now = new Date().toISOString();

  const teams = scoresOnly && keepPrev && Array.isArray(prev.teams) ? prev.teams : normTeams(await cfbd(`/teams/fbs?year=${year}`));
  if (teams.length < 100) throw new Error(`only ${teams.length} FBS teams came back for ${year}`);
  const rawGames = await cfbd(`/games?year=${year}&seasonType=regular`);
  const games = normGames(rawGames, teams), eloWeeks = eloByWeek(rawGames, teams);
  console.log(`${teams.length} teams, ${games.length} games (${games.filter(g => g.hp != null).length} final)`);

  const ratings = {}, problems = [];
  let sheetWeeks = null;
  if (!scoresOnly) {
    const sheet = cfg.sheet || {}, url = process.env.RATINGS_SHEET_URL || sheet.url;
    if (url) {
      try {
        const res = await fetchRetry(sheetCsvUrl(url), {redirect: "follow"}, "ratings sheet");
        const text = await res.text();
        if (/^\s*<!doctype html|<html/i.test(text)) throw new Error("ratings sheet: got a sign-in page; share the sheet as \"Anyone with the link can view\"");
        const s = parseSheet(text, teams, sheet);
        ratings.sheet = s.latest;
        if (Object.keys(s.byWeek).length) sheetWeeks = s.byWeek;
        console.log(`ratings sheet: ${Object.keys(s.latest).length} teams${s.latestWeek != null ? `, latest week ${s.latestWeek}` : ""}`);
        if (s.unmatched.length) console.warn(`ratings sheet: no FBS match for ${s.unmatched.join(", ")} (add them under "aliases" in data/sources.json if they're FBS teams)`);
      } catch (e) { problems.push(e.message); }
    }
    for (const kind of cfg.cfbdRatings || ["sp", "fpi", "elo", "srs"]) {
      try {
        const r = normRatings(kind, await cfbd(`/ratings/${kind}?year=${year}`), teams);
        if (r) ratings[kind] = r; else problems.push(`${kind}: not enough teams rated yet`);
      } catch (e) { problems.push(e.message); }
    }
  }

  const season = buildSeason({year, teams, games, ratings, eloWeeks, sheetWeeks, sheetLabel: cfg.sheet && cfg.sheet.label, prev, now});
  const {warnings} = validateSeason(season);
  const prefix = process.env.GITHUB_ACTIONS ? "::warning::" : "warning: ";
  for (const w of [...problems, ...warnings]) console.warn(prefix + w);
  if (sameData(season, prev)) { console.log("No changes."); return; }
  await writeFile(OUT, serialize(season));
  console.log(`Wrote ${path.relative(root, OUT)} (week ${season.currentWeek}).`);
}

main().catch(e => { console.error("error:", e.message); process.exit(1); });
