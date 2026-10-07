import {bracketSlots} from "./sim.js";
import {validateSeason, validateState, defaultState, migrateV1, cleanSetting, clampRating, prepare, baseRatings, previousRatings,
  teamRecords, bracketError, phi, resultsRatings, priorRatings, SOURCE_LABELS, STATE_FORMAT, SEASON_FORMAT} from "./model.js";

const KEY = "fbsSim.v2", CUSTOM_KEY = "fbsSim.season", POLL_MS = 10 * 60 * 1000;
const SHORT = {"Mississippi State": "Miss. State", "South Carolina": "S. Carolina", "Appalachian State": "App State",
  "Georgia Southern": "Ga. Southern", "Middle Tennessee": "Middle Tenn.", "Jacksonville State": "Jax State",
  "Western Kentucky": "W. Kentucky", "Western Michigan": "W. Michigan", "Central Michigan": "C. Michigan",
  "Eastern Michigan": "E. Michigan", "Northern Illinois": "N. Illinois", "Florida Atlantic": "FAU", "Coastal Carolina": "Coastal",
  "San José State": "San José St.", "San Diego State": "San Diego St.", "Washington State": "Wash. State",
  "Colorado State": "Colorado St.", "Sacramento State": "Sac State", "New Mexico State": "NM State",
  "North Dakota State": "N. Dakota St.", "North Carolina": "N. Carolina"};

const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]));
const sh = n => SHORT[n] || n;
// A team name that opens its team page.
const tl = (id, name = null) => { const t = D.teams[IDX.get(id)]; return `<a href="#teamSec" class="tl" data-team="${esc(id)}">${esc(name || sh(t.name))}</a>`; };
// Whole percentages, never claiming certainty the model doesn't have.
const pc = v => !(v > 0) ? "0%" : v < 0.005 ? "<1%" : v >= 1 ? "100%" : v > 0.995 ? ">99%" : Math.round(v * 100) + "%";
// The same in prose: "24 percent", "less than 1 percent".
const pw = v => !(v > 0) ? "no" : v < 0.005 ? "less than 1 percent" : v >= 1 ? "100 percent" : v > 0.995 ? "more than 99 percent" : Math.round(v * 100) + " percent";
const NUMW = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "11", "12"];
const AP_MONTH = ["Jan.", "Feb.", "March", "April", "May", "June", "July", "Aug.", "Sept.", "Oct.", "Nov.", "Dec."];
// "Oct. 6 at 6:21 p.m. ET" (Eastern time, AP style).
function apTime(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return "";
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", {timeZone: "America/New_York", month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true})
    .formatToParts(d).map(x => [x.type, x.value]));
  return `${AP_MONTH[+p.month - 1]} ${p.day} at ${p.hour}:${p.minute} ${p.dayPeriod === "PM" ? "p.m." : "a.m."} ET`;
}
// "A", "A and B", "A, B and C"
const andList = xs => xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;
const apDay = ymd => { const [, m, d] = ymd.split("-").map(Number); return `${AP_MONTH[m - 1]} ${d}`; };
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); return true; } catch { return false; } },
  del(k) { try { localStorage.removeItem(k); } catch { /* storage unavailable */ } }
};

// Heatmap cell shaded in ink: blank at 0%, solid at about 60% and up.
function heatCell(p, title, cls = "") {
  const shade = Math.min(100, p * 1.6), txt = p >= 0.5 ? Math.round(p) : p > 0 ? "·" : "";
  return `<td${cls ? ` class="${cls}"` : ""} title="${esc(title)}" style="background:color-mix(in srgb, var(--ink) ${shade.toFixed(0)}%, transparent);${shade > 55 ? "color:var(--bg);" : ""}">${txt}</td>`;
}

// Word-sized line chart of one team's rating by week, ending in a dot.
// Each line gets its own vertical scale, but never less than 4 points tall,
// so small wobbles stay small.
function sparkline(vals, w = 64, h = 16, range = null) {
  const v = vals.filter(Number.isFinite);
  if (v.length < 2) return "";
  let lo = Math.min(...v), hi = Math.max(...v);
  if (range) [lo, hi] = range;
  else if (hi - lo < 4) { const m = (hi + lo) / 2; lo = m - 2; hi = m + 2; }
  const x = k => 1 + k * (w - 2) / (v.length - 1), y = val => h - 1 - (val - lo) / (hi - lo) * (h - 2);
  const d = v.map((val, k) => `${k ? "L" : "M"}${x(k).toFixed(1)},${y(val).toFixed(1)}`).join("");
  return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true"><path d="${d}"/><circle cx="${x(v.length - 1).toFixed(1)}" cy="${y(v[v.length - 1]).toFixed(1)}" r="1.8"/></svg>`;
}

let S = loadState();
let D = null, origin = "", warnings = [], customMem = null, HIST = null, STAKES = null;
let REC = [], IDX = new Map(), RT = null;
let LAST = null, BASE = null, BASEKEY = "", worker = null, runId = 0, pollTimer = 0;

function loadState() {
  try { return validateState(JSON.parse(store.get(KEY))); } catch { return defaultState(); }
}
function save() { store.set(KEY, JSON.stringify(S)); }

function fmtDate(iso) {
  const d = new Date(iso);
  return isNaN(d) ? "" : d.toLocaleString(undefined, {month: "short", day: "numeric", hour: "numeric", minute: "2-digit"});
}

// ---- Loading season data -----------------------------------------------------

async function fetchSeason(url) {
  const res = await fetch(url, {cache: "no-cache"});
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return validateSeason(await res.json());
}

async function loadSeason() {
  const raw = customMem || store.get(CUSTOM_KEY);
  if (raw) {
    try { const v = validateSeason(typeof raw === "string" ? JSON.parse(raw) : raw); return setSeason(v, "imported"); }
    catch { store.del(CUSTOM_KEY); customMem = null; }
  }
  let err;
  for (const [url, o] of [["data/season.json", "published"], ["data/demo.json", "demo"]]) {
    try { setSeason(await fetchSeason(url), o); } catch (e) { err = e; continue; }
    if (o === "published") await Promise.all([loadHistory(), loadStakes()]);
    return;
  }
  throw err;
}

// Published daily odds (default settings), if the update workflow has
// saved any. Keeps only well-formed snapshots for this season's teams.
async function loadHistory() {
  HIST = null;
  try {
    const res = await fetch("data/odds-history.json", {cache: "no-cache"});
    const raw = res.ok ? await res.json() : null;
    if (!raw || raw.season !== D.season || !Array.isArray(raw.snapshots)) return;
    const ids = new Set(D.teams.map(t => t.id)), num = o => Object.fromEntries(Object.entries(o && typeof o === "object" ? o : {})
      .filter(([id, v]) => ids.has(id) && typeof v === "number" && v >= 0 && v <= 1));
    const snaps = raw.snapshots.filter(x => x && /^\d{4}-\d{2}-\d{2}$/.test(x.date))
      .map(x => ({date: x.date, week: Number(x.week) || 0, cfp: num(x.cfp), ch: num(x.ch), natl: num(x.natl)}))
      .sort((a, b) => a.date.localeCompare(b.date));
    if (snaps.length) HIST = snaps;
  } catch { /* no history yet */ }
}

// Published national stakes for this week's games (data/stakes.json),
// keeping only well-formed games between teams in this season's data.
async function loadStakes() {
  STAKES = null;
  try {
    const res = await fetch("data/stakes.json", {cache: "no-cache"});
    const raw = res.ok ? await res.json() : null;
    if (!raw || raw.season !== D.season || !Array.isArray(raw.games)) return;
    const p = v => typeof v === "number" && v >= 0 && v <= 1;
    const side = x => x === null ? null : x && IDX.has(String(x.id)) && ["pWin", "now", "ifWin", "ifLose"].every(k => p(x[k]))
      ? {id: String(x.id), pWin: x.pWin, now: x.now, ifWin: x.ifWin, ifLose: x.ifLose} : undefined;
    const games = new Map(D.games.map(g => [g.id, g]));
    const list = raw.games.map(g => ({g: games.get(String(g && g.id)), home: side(g && g.home), away: side(g && g.away),
      stake: Number(g && g.stake), weight: Number(g && g.weight),
      others: (Array.isArray(g && g.others) ? g.others : []).filter(o => o && IDX.has(String(o.id)) && Math.abs(o.d) <= 1).map(o => ({id: String(o.id), d: o.d}))}))
      // A known game, both sides valid (null = non-FBS), and stakes in range
      // (a stake can't exceed the 12 playoff spots).
      .filter(x => x.g && x.home !== undefined && x.away !== undefined && (x.home || x.away)
        && x.stake >= 0 && x.stake <= 12 && x.weight >= 0 && x.weight <= 12);
    if (list.length) STAKES = {week: Number(raw.week) || 0, date: typeof raw.date === "string" ? raw.date : "", N: Number(raw.N) || 0, games: list};
  } catch { /* not published yet */ }
}

const histSeries = (id, k = "cfp") => HIST ? HIST.map(x => x[k][id] || 0) : [];
const fmtDay = d => new Date(d + "T12:00:00").toLocaleDateString(undefined, {month: "short", day: "numeric"});

function setSeason({season, warnings: w}, o) {
  D = season; origin = o; warnings = w; HIST = null; STAKES = null;
  IDX = new Map(D.teams.map((t, i) => [t.id, i]));
  REC = teamRecords(D);
  LAST = null; BASE = null; BASEKEY = "";
  const confs = D.conferences.map(c => c.name);
  if (S.view.conf && !confs.includes(S.view.conf)) S.view.conf = confs.includes("SEC") ? "SEC" : "";
  pruneForced();
  save();
}

function pruneForced() {
  const open = new Set(D.games.filter(g => g.hp == null).map(g => g.id));
  for (const id in S.forced) if (!open.has(id)) delete S.forced[id];
}

function renderInfo() {
  const parts = [];
  if (D.updated) parts.push(`Updated <b>${esc(apTime(D.updated))}</b>`);
  parts.push(`through week ${D.currentWeek - 1} of the ${D.season} season`);
  if (D.source) parts.push(`data from ${esc(D.source)}`);
  $("dataInfo").innerHTML = parts.join(" · ");
  const b = $("banner"), msgs = [];
  if (origin === "demo") msgs.push("Showing <b>demo data</b>: the teams are real, but the ratings, schedule and scores are made up. Real data appears once the update workflow publishes <code>data/season.json</code> (see the README).");
  if (origin === "imported") msgs.push(`Using an imported season file. <button class="link" id="usePublished">Switch back to published data</button>`);
  if (warnings.length) msgs.push("Some entries in the season file were skipped: " + esc(warnings.join("; ")) + ".");
  b.innerHTML = msgs.join("<br>");
  b.hidden = !msgs.length;
  const up = $("usePublished");
  if (up) up.onclick = () => { store.del(CUSTOM_KEY); customMem = null; refresh(); };
}

function showMessage(html, bad) {
  const b = $("banner");
  b.innerHTML = html;
  b.className = bad ? "banner bad" : "banner";
  b.hidden = false;
}

// Watches the published file and offers new scores when they land.
function startPolling() {
  clearInterval(pollTimer);
  if (origin !== "published") return;
  pollTimer = setInterval(async () => {
    try {
      const res = await fetch("data/season.json", {cache: "no-cache"});
      const raw = res.ok && await res.json();
      if (raw && raw.updated && raw.updated !== D.updated) {
        showMessage(`New scores or ratings are available (updated ${esc(apTime(raw.updated))}). <button class="link" id="loadNew">Load and re-run</button>`);
        $("loadNew").onclick = refresh;
      }
    } catch { /* offline: try again next time */ }
  }, POLL_MS);
}

async function refresh() {
  $("banner").className = "banner";
  try { await loadSeason(); } catch (e) { return showMessage(`Couldn't load season data (${esc(e.message)}).`, true); }
  renderAll();
  run();
  startPolling();
}

// ---- Ratings and inputs ------------------------------------------------------

function computeRatings() {
  const {src, values} = baseRatings(D, S.settings), prev = previousRatings(D, S.settings), eff = {};
  for (const t of D.teams) eff[t.id] = Number.isFinite(S.overrides[t.id]) ? S.overrides[t.id] : values[t.id];
  RT = {src, base: values, prev, eff, series: ratingSeries(src, values)};
}

// Each team's rating by week for the sparklines: saved snapshots of the
// source (or the results model recomputed through each week), ending with
// the current value.
function ratingSeries(src, now) {
  const weeks = [];
  if (src === "score") {
    const prior = priorRatings(D);
    for (let w = 2; w < D.currentWeek; w++) weeks.push(resultsRatings(D, S.settings, prior, w));
  } else {
    for (const h of D.history) if (h.week < D.currentWeek && h.ratings[src]) weeks.push(h.ratings[src]);
  }
  weeks.push(now);
  const out = {};
  for (const t of D.teams) out[t.id] = weeks.map(r => r[t.id]);
  return out;
}

function srcLabel(k) { return (D && D.ratingNames[k]) || SOURCE_LABELS[k] || k; }

function bindSettings() {
  const sel = $("s_source"), have = Object.keys(D.ratings);
  sel.innerHTML = [["auto", `Auto (${srcLabel(baseRatings(D, {...S.settings, source: "auto"}).src)})`], ...have.map(k => [k, srcLabel(k)]), ["score", SOURCE_LABELS.score]]
    .map(([k, l]) => `<option value="${esc(k)}">${esc(l)}</option>`).join("");
  document.querySelectorAll("[data-g]").forEach(el => {
    const g = el.dataset.g, k = el.dataset.k;
    if (el.type === "checkbox") {
      el.checked = !!S[g][k];
      el.onchange = () => { S[g][k] = el.checked; save(); };
      return;
    }
    el.value = S[g][k];
    if (el.tagName === "SELECT" && el.value !== String(S[g][k])) {
      el.insertAdjacentHTML("beforeend", `<option value="${esc(S[g][k])}">${esc(Number(S[g][k]).toLocaleString())}</option>`);
      el.value = S[g][k];
    }
    const apply = () => {
      S[g][k] = el.tagName === "SELECT" && (k === "source" || k === "model" || k === "seeding") ? el.value : cleanSetting(g, k, el.value);
      save();
      if (k === "model") showModel();
      if (g === "cfp") $("cfpErr").textContent = bracketError(S.cfp) || "";
      if (["source", "hfa", "fcs", "priorW", "cap", "gsd", "rsd"].includes(k)) { computeRatings(); renderTeams(); renderPicks(); }
    };
    el.oninput = el.tagName === "SELECT" ? null : apply;
    el.onchange = () => { apply(); if (el.tagName !== "SELECT") el.value = S[g][k]; };
  });
  $("cfpErr").textContent = bracketError(S.cfp) || "";
  showModel();
}

// Show only the inputs the chosen committee model uses, and explain it.
function showModel() {
  const m = S.cfp.model;
  document.querySelectorAll("[data-model]").forEach(el => { el.hidden = el.dataset.model !== m; });
  const tail = " A lost conference title game counts as a fraction of a loss (the title-game loss weight: 0 ignores it, 1 counts it fully). If a team finishes within the head-to-head window of a team it beat, it moves just ahead of that team. The highest-scoring conference champions get the automatic bids, and the rest of the field goes to the highest remaining scores. Seeding follows the score order and the top seeds get byes (under the 2024 rule, byes went to the four highest-ranked conference champions). The bracket is then played out, with first-round games at the higher seed and later rounds at neutral sites.";
  $("cfpExplain").textContent = (m === "sor"
    ? "In every simulated season, each FBS team gets a committee score: rating + SOR weight × strength of record + champion bonus (conference champions) + noise. Strength of record is wins minus the wins a bubble team (the field-size-th best rating) would expect against the same schedule at the same sites, so a loss to a top team costs much less than a loss to a weak one."
    : "In every simulated season, each FBS team gets a committee score: rating − loss penalty × losses + SoS weight × average opponent rating + champion bonus (conference champions) + noise. Every loss costs the same, whoever it's against.") + tail;
}

function renderConfPicker() {
  $("confSel").innerHTML = `<option value="">All FBS</option>` +
    D.conferences.map(c => `<option${c.name === S.view.conf ? " selected" : ""}>${esc(c.name)}</option>`).join("");
  $("confSel").value = S.view.conf;
}

const inView = t => !S.view.conf || t.conf === S.view.conf;

function renderTeams() {
  const all = !S.view.conf, idx = D.teams.map((_, i) => i).filter(i => inView(D.teams[i]));
  // Sparklines only once the source has at least two weeks to draw.
  const spark = Object.values(RT.series).some(v => v.filter(Number.isFinite).length > 1);
  idx.sort((a, b) => RT.base[D.teams[b].id] - RT.base[D.teams[a].id]);
  $("teamsNote").textContent = `${srcLabel(RT.src)} ratings`;
  const head = `<thead><tr><th>Team</th>${all ? "<th>Conf</th>" : ""}<th class="num">W–L</th><th class="num">Conf</th>
    <th class="num">${esc(srcLabel(RT.src))}</th>${spark ? "<th>By week</th>" : ""}<th class="num">Δ wk</th><th>Override</th></tr></thead>`;
  const body = idx.map(i => {
    const t = D.teams[i], r = REC[i], base = RT.base[t.id], prev = RT.prev && RT.prev[t.id];
    const dv = Number.isFinite(prev) ? base - prev : null;
    const dtxt = dv === null ? "" : Math.abs(dv) < 0.05 ? "0.0" : `<span class="${dv > 0 ? "up" : "dn"}">${dv > 0 ? "+" : ""}${dv.toFixed(1)}</span>`;
    const ov = S.overrides[t.id];
    return `<tr><td>${esc(t.name)}</td>${all ? `<td class="muted">${esc(t.conf)}</td>` : ""}
      <td class="num">${r.w}–${r.l}</td><td class="num">${r.cw}–${r.cl}</td><td class="num">${base.toFixed(1)}</td>${spark ? `<td>${sparkline(RT.series[t.id])}</td>` : ""}<td class="num">${dtxt}</td>
      <td><input type="number" step="0.5" data-id="${esc(t.id)}" value="${Number.isFinite(ov) ? ov : ""}" placeholder="${base.toFixed(1)}" aria-label="Rating override for ${esc(t.name)}"></td></tr>`;
  }).join("");
  $("teams").innerHTML = head + `<tbody>${body}</tbody>`;
  $("teams").querySelectorAll("input").forEach(el => el.oninput = () => {
    const v = el.value.trim(), x = Number(v);
    if (!v || !Number.isFinite(x)) delete S.overrides[el.dataset.id];
    else S.overrides[el.dataset.id] = clampRating(x);
    save(); computeRatings(); renderPicks();
  });
}

const gName = (g, side) => side === "h" ? (g.home ? D.teams[IDX.get(g.home)].name : g.homeName) : (g.away ? D.teams[IDX.get(g.away)].name : g.awayName);
const gConf = (g, conf) => (g.home && D.teams[IDX.get(g.home)].conf === conf) || (g.away && D.teams[IDX.get(g.away)].conf === conf);

// Pick the rest of the followed team's schedule: two buttons per remaining
// game. Clicking a team forces its win; clicking it again undoes the pick.
function renderPicks() {
  const id = S.view.team, c = Object.keys(S.forced).length;
  $("clearBtn").disabled = !c;
  if (!id || !IDX.has(id)) {
    $("games").innerHTML = "";
    $("winOutBtn").disabled = true;
    $("fc").textContent = c ? `${c} game${c > 1 ? "s" : ""} picked` : "";
    return;
  }
  const t = D.teams[IDX.get(id)], list = D.games.filter(g => g.hp == null && (g.home === id || g.away === id));
  $("pkHead").textContent = `Pick the rest of ${t.name}'s schedule`;
  const {hfa, gsd, rsd, fcs} = S.settings, sd = Math.sqrt(gsd * gsd + 2 * rsd * rsd) || 1;
  const rating = x => x ? RT.eff[x] : fcs;
  $("games").innerHTML = list.length ? list.map(g => {
    const A = gName(g, "a"), H = gName(g, "h"), f = S.forced[g.id] || 0;
    const ph = phi((rating(g.home) - rating(g.away) + (g.neutral ? 0 : hfa)) / sd), when = g.date ? kickoff(g.date) : "";
    const btn = (v, nameTxt, p) => `<button data-k="${esc(g.id)}" data-v="${v}" class="${f === v ? "on" : f ? "off" : ""}" aria-pressed="${f === v}"
        title="${f === v ? "Undo this pick" : `Pick ${esc(nameTxt)} to win`}">${esc(sh(nameTxt))}<span>${f === v ? "Your pick" : `${pc(p)} to win`}</span></button>`;
    return `<div class="pick"><span class="tag">Week ${g.week}${when ? ` · ${esc(when)}` : ""}${g.champ ? " · conference championship game" : ""}</span>
      ${btn(1, A, 1 - ph)}<span class="at">${g.neutral ? "vs." : "at"}</span>${btn(2, H, ph)}</div>`;
  }).join("") : `<p class="col note">${esc(t.name)} has no games left to play${D.games.some(g => g.home === id || g.away === id) ? " on the schedule" : ""}.</p>`;
  const mine = list.filter(g => S.forced[g.id]).length, other = c - mine;
  $("fc").textContent = c ? `${mine} of ${list.length} picked${other ? `, plus ${other} other game${other > 1 ? "s" : ""}` : ""}` : "";
  $("winOutBtn").textContent = `${sh(t.name)} wins out`;
  $("winOutBtn").disabled = !list.length || list.every(g => S.forced[g.id] === (g.home === id ? 2 : 1));
}

// Picks the followed team to win every remaining game.
function winOut() {
  const id = S.view.team;
  if (!id) return;
  for (const g of D.games) if (g.hp == null && (g.home === id || g.away === id)) S.forced[g.id] = g.home === id ? 2 : 1;
  save(); renderPicks(); renderBigWeek(); run();
}

// Sets or clears a pick from any pick button (data-k = game id, data-v =
// 1 for the away team, 2 for the home team).
function togglePick(id, v) {
  if (S.forced[id] === v) delete S.forced[id]; else S.forced[id] = v;
  save(); renderPicks(); renderBigWeek(); run();
}

// ---- Running -----------------------------------------------------------------

function setProgress(f) {
  $("prog").classList.toggle("on", f !== null);
  $("progBar").style.width = `${Math.round((f || 0) * 100)}%`;
  if (f !== null) $("status").textContent = `Running… ${Math.round(f * 100)}%`;
}

function run() {
  if (!D) return;
  const err = bracketError(S.cfp);
  if (err) { $("cfpErr").textContent = err; $("status").textContent = "Fix the playoff format to run."; return; }
  pruneForced(); save();
  const P = prepare(D, S, RT.eff), any = P.forced.some(Boolean);
  // The no-what-if baseline doesn't depend on which games are forced, so
  // it's reused until the data, ratings or settings change.
  const key = JSON.stringify([D.updated, origin, S.settings, S.cfp, S.overrides]);
  const haveBase = BASE && BASEKEY === key, id = ++runId, t0 = performance.now();
  setProgress(0);
  const finish = (A, B) => {
    if (id !== runId) return;
    if (!any) { BASE = A; BASEKEY = key; } else if (B) { BASE = B; BASEKEY = key; }
    LAST = {A, B: any ? BASE : null, P};
    setProgress(null);
    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    $("status").textContent = `Based on ${A.N.toLocaleString()} simulations (${secs} seconds).` + (any ? " Green and red numbers show the change from your picks, in percentage points." : "");
    renderSummary(); renderResults(); renderNational(); renderHeat(); renderBids(); renderTeamPage();
  };
  const fail = msg => { if (id === runId) { setProgress(null); $("status").textContent = `Simulation failed: ${msg}`; } };

  if (worker) worker.terminate();
  worker = null;
  try { worker = new Worker(new URL("./worker.js", import.meta.url), {type: "module"}); } catch { worker = null; }
  if (worker) {
    worker.onmessage = e => {
      const m = e.data;
      if (id !== runId) return;
      if (m.type === "progress") setProgress(m.value);
      else if (m.type === "done") { finish(m.A, m.B); worker.terminate(); worker = null; }
      else fail(m.message);
    };
    worker.onerror = e => fail(e.message || "worker error");
    worker.postMessage({P, base: any && !haveBase});
  } else {
    import("./sim.js").then(({simulate}) => setTimeout(() => {
      try {
        const A = simulate(P, true), B = any && !haveBase ? simulate(P, false) : null;
        finish(A, B);
      } catch (e) { fail(e.message); }
    }, 20));
  }
}

// ---- Results -----------------------------------------------------------------

const COLS = [
  {k: "name", label: "Team"}, {k: "conf", label: "Conf.", allOnly: true}, {k: "rating", label: "Rating", num: true},
  {k: "rec", label: "Record", num: true}, {k: "proj", label: "Proj. record", num: true}, {k: "projc", label: "Proj. conf.", num: true},
  {k: "t2", label: "Reach title game", num: true, p: true}, {k: "ch", label: "Win conference", num: true, p: true},
  {k: "cfp", label: "Make playoff", num: true, p: true}, {k: "bye", label: "Get a bye", num: true, p: true},
  {k: "natl", label: "Win title", num: true, p: true}
];

// Change vs. the no-picks run, in percentage points; hidden under 1.
function dl(v) {
  const x = Math.round(v * 100);
  if (!x) return "";
  return ` <span class="d" style="color:var(--${x > 0 ? "good" : "bad"})">${x > 0 ? "+" : "−"}${Math.abs(x)}</span>`;
}

function renderResults() {
  if (!LAST) return;
  const {A, B, P} = LAST, N = A.N, all = !S.view.conf;
  renderConfIntro();
  const rows = D.teams.map((t, i) => {
    const z = {t, i, name: t.name, conf: t.conf, rating: P.R[i], rec: REC[i].w - REC[i].l, proj: A.sw[i] / N, projc: A.scw[i] / N,
      none: P.confs[P.confOf[i]].format === "none"};
    for (const c of COLS) if (c.p) { z[c.k] = A[c.k === "t2" ? "top2" : c.k][i] / N; if (B) z["d" + c.k] = (A[c.k === "t2" ? "top2" : c.k][i] - B[c.k === "t2" ? "top2" : c.k][i]) / N; }
    return z;
  }).filter(z => inView(z.t));
  const sort = S.view.sort || {key: all ? "cfp" : "ch", dir: -1};
  rows.sort((a, b) => {
    const x = a[sort.key], y = b[sort.key];
    const c = typeof x === "string" ? x.localeCompare(y) : x - y;
    return c * sort.dir || b.cfp - a.cfp || a.name.localeCompare(b.name);
  });
  const cols = COLS.filter(c => all || !c.allOnly);
  $("out").innerHTML = `<table><thead><tr>${cols.map(c => `<th class="sort${c.num ? " num" : ""}" data-k="${c.k}" tabindex="0"
      aria-sort="${sort.key === c.k ? (sort.dir > 0 ? "ascending" : "descending") : "none"}">${c.label}${sort.key === c.k ? (sort.dir > 0 ? " ▲" : " ▼") : ""}</th>`).join("")}</tr></thead><tbody>
    ${rows.map(z => {
      const r = REC[z.i];
      return `<tr><td>${tl(z.t.id, z.name)}</td>${all ? `<td class="muted">${esc(z.conf)}</td>` : ""}
        <td class="num">${z.rating.toFixed(1)}</td>
        <td class="num">${r.w}–${r.l}</td>
        <td class="num">${z.proj.toFixed(1)}–${(A.sl[z.i] / N).toFixed(1)}</td>
        <td class="num">${z.none ? "–" : `${z.projc.toFixed(1)}–${(A.scl[z.i] / N).toFixed(1)}`}</td>
        ${["t2", "ch", "cfp", "bye", "natl"].map(k => z.none && (k === "t2" || k === "ch") ? `<td class="num muted">—</td>`
          : `<td class="num pb" style="--p:${(z[k] * 100).toFixed(1)}%">${pc(z[k])}${B ? dl(z["d" + k]) : ""}</td>`).join("")}</tr>`;
    }).join("")}
    </tbody></table>`;
  $("out").querySelectorAll("th.sort").forEach(th => {
    const go = () => {
      const k = th.dataset.k, cur = S.view.sort || sort;
      S.view.sort = {key: k, dir: cur.key === k ? -cur.dir : (k === "name" || k === "conf" ? 1 : -1)};
      save(); renderResults();
    };
    th.onclick = go;
    th.onkeydown = e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } };
  });
}

const CONF_SHORT = {"FBS Independents": "Independent", "American Athletic": "American", "Mountain West": "Mountain West",
  "Conference USA": "C-USA", "Mid-American": "MAC"};
const STAGE = {1: "Win title", 2: "Final", 4: "Semis", 8: "Quarters", 16: "Round of 16", 32: "Round of 32"};
const ROUND = {2: "Semifinal", 4: "Quarterfinal", 8: "Quarterfinal", 16: "Round of 16"};

// National view: the projected field and bracket, then every contender's
// seed distribution and round-by-round odds.
// The projected field: the F teams most likely to make it, seeded by
// average finish (a missed field counts as seed F + 1). `byChance` lists
// every team, most likely first.
function projectField(A) {
  const N = A.N, F = A.F;
  const pos = D.teams.map((_, i) => {
    let e = (F + 1) * (N - A.cfp[i]);
    for (let q = 0; q < F; q++) e += (q + 1) * A.seed[i * F + q];
    return e / N;
  });
  const byChance = D.teams.map((_, i) => i).sort((a, b) => A.cfp[b] - A.cfp[a] || pos[a] - pos[b]);
  return {pos, byChance, field: byChance.slice(0, F).sort((a, b) => pos[a] - pos[b])};
}

function renderNational() {
  if (!LAST) return;
  const {A, B, P} = LAST, N = A.N, F = A.F, byes = A.B, hosts = (F - byes) / 2, conf = S.view.conf;
  const pIn = i => A.cfp[i] / N, {pos, field} = projectField(A);
  const rec = i => `${Math.round(A.sw[i] / N)}–${Math.round(A.sl[i] / N)}`;
  const hl = i => conf && D.teams[i].conf === conf ? " hl" : "";

  const line = (q, role) => {
    const i = field[q], what = role === "bye" ? `bye ${pc(A.bye[i] / N)}` : role === "host" ? `hosts ${pc(A.host[i] / N)}` : `in ${pc(pIn(i))}`;
    return `<div class="tm${hl(i)}" title="${esc(D.teams[i].name)}: seed ${q + 1} in ${pc(A.seed[i * F + q] / N)} of seasons, in the field in ${pc(pIn(i))}">
      <span class="sd">${q + 1}</span><span class="nm">${tl(D.teams[i].id)} <span class="rec">${rec(i)}</span></span>
      <span class="pr">${what}</span></div>`;
  };
  const slot = s => s <= byes
    ? line(s - 1, "bye")
    : `${line(s - 1, "host")}<div class="vs">vs.</div>${line(F + byes - s, "away")}`;
  const order = bracketSlots(A.M), pods = [];
  for (let j = 0; j < order.length; j += 2) {
    const pair = order.slice(j, j + 2);
    pods.push(`<div class="pod"><div class="lbl">${ROUND[A.M] || "Round"} ${j / 2 + 1}</div>${pair.map(slot).join('<div class="sep"></div>')}</div>`);
  }
  $("bracket").innerHTML = pods.join("");
  const w = x => NUMW[x] || String(x), cap = x => ({10: "Ten", 11: "Eleven", 12: "Twelve", 16: "Sixteen"})[x] || (w(x).charAt(0).toUpperCase() + w(x).slice(1));
  $("natIntro").textContent = `${cap(F)} teams make the field: the ${w(P.params.autoBids)} highest-ranked conference champions and the ${w(F - P.params.autoBids)} best remaining teams.`
    + (byes ? ` Seeds 1 through ${byes} get first-round byes, and seeds ${byes + 1} through ${byes + hosts} host first-round games.` : ` Seeds 1 through ${hosts} host first-round games.`)
    + ` This is the most likely field, seeded by each team's average finish across all simulations.`;
  $("natNote").textContent = `Each team's chance of a bye, of hosting a first-round game, or of making the field. Hover over a team for its chance of that exact seed.${conf ? ` ${conf} teams are in red.` : ""}`;
  renderNatChart();

  const rows = D.teams.map((_, i) => i).filter(i => pIn(i) >= 0.005).sort((a, b) => pIn(b) - pIn(a) || pos[a] - pos[b]);
  // The last three rounds (semifinals, final, title) keep the table readable.
  const stageCols = Array.from({length: A.stages}, (_, k) => k).slice(-3);
  const d = (k, i) => B ? dl((A[k][i] - B[k][i]) / N) : "";
  const cell = (i, q) => {
    const p = A.seed[i * F + q] / N * 100;
    return heatCell(p, `${D.teams[i].name}: No. ${q + 1} seed in ${pc(p / 100)} of simulations`, "hc");
  };
  $("natTable").innerHTML = rows.length ? `<table class="nat"><thead><tr><th>Team</th><th>Conf.</th>
      <th class="num">Make playoff</th>${HIST && HIST.length > 1 ? `<th title="Playoff chances by day, ${esc(apDay(HIST[0].date))} to ${esc(apDay(HIST[HIST.length - 1].date))}">Trend</th>` : ""}<th class="num" title="Gets in as one of the ${P.params.autoBids} highest-ranked conference champions">Auto bid</th>
      <th class="num">Bye</th><th class="num">Host 1st round</th><th class="num" title="Projected wins above a bubble team's expected wins against the same schedule">SOR</th><th class="num" title="Average seed in simulations where it makes the field">Avg. seed</th>
      ${stageCols.map(k => `<th class="num">${STAGE[A.M >> k] || ""}</th>`).join("")}</tr></thead><tbody>
    ${rows.map(i => {
      let avg = 0;
      for (let q = 0; q < F; q++) avg += (q + 1) * A.seed[i * F + q];
      return `<tr class="${hl(i).trim()}"><td title="${esc(D.teams[i].name)}">${tl(D.teams[i].id)}</td><td class="muted" style="white-space:nowrap">${esc(CONF_SHORT[D.teams[i].conf] || D.teams[i].conf)}</td>
        <td class="num big">${pc(pIn(i))}${d("cfp", i)}</td>${HIST && HIST.length > 1 ? `<td>${sparkline(histSeries(D.teams[i].id), 56, 16, [0, 1])}</td>` : ""}<td class="num">${pc(A.auto[i] / N)}</td>
        <td class="num">${pc(A.bye[i] / N)}${d("bye", i)}</td><td class="num">${pc(A.host[i] / N)}${d("host", i)}</td>
        <td class="num">${(A.sor[i] / N >= 0 ? "+" : "−") + Math.abs(A.sor[i] / N).toFixed(1)}</td><td class="num">${(avg / A.cfp[i]).toFixed(1)}</td>
        ${stageCols.map(k => `<td class="num">${pc(A.reach[i * A.stages + k] / N)}</td>`).join("")}</tr>`;
    }).join("")}
    </tbody></table>
    <details style="margin-top:14px"><summary>Chance of each seed</summary>
      <p class="note">Darker is more likely; a dot is under 1 percent.</p>
      <div class="scroll"><table class="nat seeds"><thead><tr><th>Team</th>${Array.from({length: F}, (_, q) => `<th class="hc">${q + 1}</th>`).join("")}</tr></thead><tbody>
      ${rows.map(i => `<tr class="${hl(i).trim()}"><td>${tl(D.teams[i].id)}</td>${Array.from({length: F}, (_, q) => cell(i, q)).join("")}</tr>`).join("")}
      </tbody></table></div></details>` : `<div class="muted">No team made the field.</div>`;
}

// Published playoff chances by day for the bubble teams (between 15 and 85
// percent today) and the team being followed, labeled at the line ends.
function renderNatChart() {
  const el = $("natChart");
  if (!HIST || HIST.length < 2) { el.innerHTML = ""; return; }
  const last = HIST[HIST.length - 1];
  const ids = D.teams.map(t => t.id).filter(id => (last.cfp[id] || 0) >= 0.15 && (last.cfp[id] || 0) <= 0.85)
    .sort((a, b) => last.cfp[b] - last.cfp[a]).slice(0, 8);
  if (S.view.team && !ids.includes(S.view.team) && IDX.has(S.view.team)) ids.push(S.view.team);
  if (!ids.length) { el.innerHTML = ""; return; }
  el.innerHTML = `<h3>How the bubble has moved</h3><p class="note">Published playoff chances by day for teams now between 15 and 85 percent${S.view.team ? `, with ${esc(D.teams[IDX.get(S.view.team)].name)} in red` : ""}.</p>`
    + lineChart(ids.map(id => ({id, vals: histSeries(id), cls: id === S.view.team ? "hl" : ""})), {w: 760, h: 260});
}

// Lines on a 0–100% scale over the published dates, each labeled at its
// right end (labels nudged apart so they don't collide). Optional marks
// annotate dates along the bottom.
function lineChart(series, {w = 760, h = 240, marks = []} = {}) {
  const padL = 34, padR = 150, padT = 10, padB = 34, n = HIST.length;
  const t0 = new Date(HIST[0].date + "T12:00:00").getTime(), t1 = new Date(HIST[n - 1].date + "T12:00:00").getTime();
  const xd = ms => padL + (ms - t0) / Math.max(1, t1 - t0) * (w - padL - padR);
  const x = k => xd(new Date(HIST[k].date + "T12:00:00").getTime()), y = p => padT + (1 - p) * (h - padT - padB);
  const path = vals => vals.map((v, k) => `${k ? "L" : "M"}${x(k).toFixed(1)},${y(v).toFixed(1)}`).join("");
  const ends = series.map(s => ({s, y: y(s.vals[n - 1])})).sort((a, b) => a.y - b.y);
  for (let k = 1; k < ends.length; k++) ends[k].y = Math.max(ends[k].y, ends[k - 1].y + 13);
  const grid = [0, 0.25, 0.5, 0.75, 1].map(p => `<line x1="${padL}" x2="${w - padR}" y1="${y(p)}" y2="${y(p)}" class="${p ? "grid" : "axis"}"/>
    <text x="${padL - 6}" y="${y(p) + 4}" text-anchor="end">${p * 100}${p === 1 ? "%" : ""}</text>`).join("");
  const mk = marks.filter(m => m.ms >= t0 && m.ms <= t1).map(m => `<line x1="${xd(m.ms)}" x2="${xd(m.ms)}" y1="${y(0)}" y2="${y(0) + 5}" class="gm"/>
    <text x="${xd(m.ms)}" y="${y(0) + 16}" text-anchor="middle">${esc(m.label)}</text>`).join("");
  const lines = series.map(s => `<path d="${path(s.vals)}" class="${s.cls === "hl" ? "lhl" : s.cls === "main" ? "l1" : s.cls === "second" ? "l2" : "lo"}"/>`).join("");
  const labels = ends.map(e => `<text x="${w - padR + 6}" y="${e.y + 4}" class="${e.s.cls === "hl" ? "hl" : e.s.cls === "main" ? "lbl1" : ""}">${esc(e.s.label || sh(D.teams[IDX.get(e.s.id)].name))} ${Math.round(e.s.vals[n - 1] * 100)}%</text>`).join("");
  return `<svg class="chart" viewBox="0 0 ${w} ${h}" width="100%" style="max-width:${w}px" role="img" aria-label="Chances by day">
    ${grid}${mk}${lines}${labels}
    <text x="${padL}" y="${h - 2}">${esc(apDay(HIST[0].date))}</text><text x="${w - padR}" y="${h - 2}" text-anchor="end">${esc(apDay(HIST[n - 1].date))}</text></svg>`;
}

function renderHeat() {
  $("vPlace").className = S.view.heat === "place" ? "on" : "";
  $("vWins").className = S.view.heat === "wins" ? "on" : "";
  if (!LAST) return;
  const {A, P} = LAST, N = A.N, c = P.confs.findIndex(x => x.name === S.view.conf);
  if (c < 0 || P.confs[c].format === "none") {
    $("heat").innerHTML = `<div class="muted">Pick a conference above to see its standings distribution.</div>`;
    return;
  }
  const mem = P.confs[c].members, byPlace = S.view.heat === "place";
  const stride = byPlace ? A.maxConfSize : A.maxConfG + 1, arr = byPlace ? A.place : A.cwins;
  const cols = byPlace ? mem.length : Math.max(...mem.map(i => P.confG[i])) + 1;
  const exp = new Map(mem.map(i => {
    let e = 0;
    for (let q = 0; q < mem.length; q++) e += (q + 1) * A.place[i * A.maxConfSize + q];
    return [i, e / N];
  }));
  const order = mem.slice().sort((a, b) => exp.get(a) - exp.get(b));
  const labels = Array.from({length: cols}, (_, k) => byPlace ? k + 1 : k);
  $("heat").innerHTML = `<table class="heat"><thead><tr><th>${byPlace ? "Place →" : "Conf wins →"}</th>
      ${labels.map(l => `<th>${l}</th>`).join("")}<th class="avg">Avg</th></tr></thead><tbody>
    ${order.map(i => `<tr><td title="${esc(D.teams[i].name)}">${esc(sh(D.teams[i].name))}</td>
      ${labels.map((l, k) => {
        const p = arr[i * stride + k] / N * 100;
        return heatCell(p, `${D.teams[i].name}: ${byPlace ? `finishes ${l}` : `${l} conference wins`} in ${p.toFixed(1)}% of seasons`);
      }).join("")}
      <td class="avg num">${byPlace ? exp.get(i).toFixed(1) : (A.scw[i] / N).toFixed(1)}</td></tr>`).join("")}
    </tbody></table>`;
}

function renderBids() {
  if (!LAST) return;
  const {A, P} = LAST, N = A.N, F = A.F, c = P.confs.findIndex(x => x.name === S.view.conf);
  const dist = k => Array.from({length: F + 1}, (_, b) => A.bids[k * (F + 1) + b] / N);
  const avg = d => d.reduce((s, v, b) => s + v * b, 0);
  if (c >= 0) {
    const d = dist(c), hi = Math.min(F, P.confs[c].members.length);
    let top = hi;
    while (top > 2 && d[top] < 0.0005) top--;
    const vals = d.slice(0, top + 1), mx = Math.max(...vals) || 1;
    $("bidAvg").textContent = `${S.view.conf} average: ${avg(d).toFixed(1)} teams`;
    $("bids").hidden = false;
    $("bids").innerHTML = `<div class="bids">${vals.map(v => `<div class="c"><span>${pc(v)}</span>
        <div class="b" style="height:${(v / mx * 96).toFixed(1)}px"></div></div>`).join("")}</div>
      <div class="bids-x">${vals.map((_, b) => `<span>${b}</span>`).join("")}</div>
      <div class="muted" style="max-width:520px;text-align:center">teams selected</div>`;
  } else {
    $("bidAvg").textContent = "";
    $("bids").hidden = true;
  }
  const rows = P.confs.map((x, k) => ({name: x.name, d: dist(k)})).map(z => ({...z, avg: avg(z.d)})).sort((a, b) => b.avg - a.avg);
  const cols = [0, 1, 2, 3, 4], tail = 5;
  $("bidTable").innerHTML = `<table><thead><tr><th>Conference</th><th class="num">Avg bids</th>
    ${cols.map(b => `<th class="num">${b} bid${b === 1 ? "" : "s"}</th>`).join("")}<th class="num">${tail}+</th></tr></thead><tbody>
    ${rows.map(z => `<tr${z.name === S.view.conf ? ' class="hl"' : ""}><td>${esc(CONF_SHORT[z.name] || z.name)}</td><td class="num">${z.avg.toFixed(2)}</td>
      ${cols.map(b => `<td class="num">${z.d[b] ? pc(z.d[b]) : "—"}</td>`).join("")}
      <td class="num">${(t => t ? pc(t) : "—")(z.d.slice(tail).reduce((s, v) => s + v, 0))}</td></tr>`).join("")}
    </tbody></table>`;
}

// Opening paragraph: the headline numbers in words.
// "Sat., 7:30 p.m. ET" (kickoff, Eastern time).
function kickoff(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return "";
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", {timeZone: "America/New_York", weekday: "short", hour: "numeric", minute: "2-digit", hour12: true})
    .formatToParts(d).map(x => [x.type, x.value]));
  return `${p.weekday}., ${p.hour}${p.minute === "00" ? "" : ":" + p.minute} ${p.dayPeriod === "PM" ? "p.m." : "a.m."} ET`;
}

// The week's biggest games nationally, from the published stakes: rank,
// matchup, each team's playoff chance if it wins or loses (team names are
// pick buttons), and how much playoff chance is at stake.
function renderBigWeek() {
  const sec = $("bigweek");
  const games = STAKES ? STAKES.games.filter(x => x.g.hp == null).slice(0, 8) : [];
  sec.hidden = !games.length;
  if (!games.length) return;
  const W = 400, padR = 44, x = p => 8 + p * (W - 8 - padR), maxStake = Math.max(...games.map(x => x.stake));
  const team = id => D.teams[IDX.get(id)];
  const strip = (side, axisOnly) => {
    const grid = [0, 0.25, 0.5, 0.75, 1].map(p => `<line class="tick" x1="${x(p)}" x2="${x(p)}" y1="0" y2="26"/>`).join("");
    if (axisOnly) return `<svg class="db ax" viewBox="0 0 ${W} 16" preserveAspectRatio="none">${[0, 0.5, 1].map(p =>
      `<text x="${x(p)}" y="11" text-anchor="${p ? p === 1 ? "end" : "middle" : "start"}">${p * 100}%${p === 0.5 ? " chance to make the playoff" : ""}</text>`).join("")}</svg>`;
    if (!side) return `<svg class="db" viewBox="0 0 ${W} 26">${grid}</svg>`;
    const a = x(side.ifLose), b = x(side.ifWin), y = 13;
    return `<svg class="db" viewBox="0 0 ${W} 26" role="img" aria-label="${esc(team(side.id).name)}: ${pc(side.ifWin)} if it wins, ${pc(side.ifLose)} if it loses">${grid}
      <line class="seg" x1="${a}" x2="${b}" y1="${y}" y2="${y}"/><line class="now" x1="${x(side.now)}" x2="${x(side.now)}" y1="${y - 7}" y2="${y + 7}"/>
      <circle class="lose" cx="${a}" cy="${y}" r="4.5"/><circle class="win" cx="${b}" cy="${y}" r="5"/>
      <text x="${Math.min(a, b) - 8}" y="${y + 4}" text-anchor="end">${b >= a ? pc(side.ifLose) : pc(side.ifWin)}</text>
      <text class="v" x="${Math.max(a, b) + 8}" y="${y + 4}">${b >= a ? pc(side.ifWin) : pc(side.ifLose)}</text></svg>`;
  };
  const row = (g, side, v, name) => {
    const f = S.forced[g.id] || 0;
    const btn = `<button data-k="${esc(g.id)}" data-v="${v}" class="${f === v ? "on" : f ? "off" : ""}" aria-pressed="${f === v}"
      title="${f === v ? "Undo this pick" : `Pick ${esc(name)} to win`}">${esc(sh(name))}</button>`;
    return `<div class="db-row">${btn}${strip(side)}</div>`;
  };
  $("bwKicker").textContent = `Week ${STAKES.week} · The games that matter`;
  $("bwHead").textContent = `The ${games.length === 8 ? "Eight" : NUMW[games.length] ? NUMW[games.length][0].toUpperCase() + NUMW[games.length].slice(1) : games.length} Games That Will Shape the Playoff Race This Week`;
  $("bwList").innerHTML = games.map((s, k) => {
    const g = s.g, A = gName(g, "a"), H = gName(g, "h");
    const fav = s.home && s.home.pWin >= 0.5 ? [H, s.home.pWin] : s.away ? [A, s.away.pWin] : [H, s.home.pWin];
    const also = s.others.length && s.home ? `If <b>${esc(H)}</b> wins: ` + s.others.map(o => `${esc(team(o.id).name)} ${o.d > 0 ? "+" : "−"}${Math.round(Math.abs(o.d) * 100)}`).join(", ") + " (points of playoff chance)" : "";
    return `<div class="bw">
      <div class="rank">${k + 1}</div>
      <div class="match"><div class="t">${esc(A)} <span>${g.neutral ? "vs." : "at"}</span> ${esc(H)}</div>
        <div class="s">${esc(kickoff(g.date))}${g.date ? " · " : ""}${esc(fav[0])} wins ${pw(fav[1])} of the time</div></div>
      <div class="chart">${k === 0 ? `<div class="db-axis"><span></span>${strip(null, true)}</div>` : ""}${row(g, s.away, 1, A)}${row(g, s.home, 2, H)}</div>
      <div class="stake"><div class="v">${Math.round(s.stake * 100)}</div><div class="l">points of playoff<br>chance at stake</div>
        <div class="bar"><div style="width:${(s.stake / maxStake * 100).toFixed(0)}%"></div></div></div>
      ${also ? `<div class="also">${also}</div>` : ""}
    </div>`;
  }).join("");
  $("bwFoot").textContent = `Published ${STAKES.date ? apDay(STAKES.date) : ""} from ${STAKES.N ? STAKES.N.toLocaleString() + " " : ""}simulations per result with the default model settings, so these numbers don't change with your picks or settings. `
    + `"Playoff chance at stake" adds up how many percentage points of playoff chance move between teams from one result to the other, including teams not playing in the game.`;
}

// One or two sentences on the selected conference's race.
function renderConfIntro() {
  const {A, P} = LAST, N = A.N, c = P.confs.findIndex(x => x.name === S.view.conf);
  if (c < 0 || P.confs[c].format === "none") {
    $("confIntro").textContent = "Pick a conference at the top of the page to follow its race. Below, every team's chances across all of FBS.";
    return;
  }
  const C = P.confs[c], mem = C.members.slice().sort((a, b) => A.ch[b] - A.ch[a]), nm = i => esc(D.teams[i].name);
  const top = mem.filter(i => A.ch[i] / N >= 0.05).slice(0, 4);
  const parts = top.map((i, k) => k ? `${nm(i)} in ${pw(A.ch[i] / N)}` : `${nm(i)} wins the ${esc(C.name)} in ${pw(A.ch[i] / N)} of simulations`);
  const rest = mem.length - top.length;
  $("confIntro").innerHTML = `${andList(parts)}.${rest > 0 ? ` The other ${NUMW[rest] || rest} teams win it in ${pw(mem.slice(top.length).reduce((t, i) => t + A.ch[i], 0) / N)} combined.` : ""}`
    + (C.format === "divisions" ? " The two division winners meet in the title game." : C.format === "top2" ? " The top two teams in the standings meet in the title game." : "");
}

// The story at the top: a headline and summary line written from the
// results, then a paragraph with the key numbers.
function renderSummary() {
  if (!LAST) { $("summary").textContent = ""; return; }
  const {A, P} = LAST, N = A.N, F = A.F, nm = i => `<b>${esc(D.teams[i].name)}</b>`, name = i => esc(D.teams[i].name);
  const top = arr => D.teams.reduce((b, _, i) => arr[i] > arr[b] ? i : b, 0);
  const {byChance} = projectField(A), natl = top(A.natl), one = top(A.seed.filter((_, k) => k % F === 0));
  const last = byChance[F - 1], out = byChance[F];
  const c = P.confs.findIndex(x => x.name === S.view.conf), conf = c >= 0 && P.confs[c].format !== "none" ? P.confs[c] : null;
  const bubbleOf = idx => idx.filter(i => A.cfp[i] / N >= 0.25 && A.cfp[i] / N <= 0.75).sort((a, b) => A.cfp[b] - A.cfp[a]).slice(0, 2);

  let head, dek;
  if (conf) {
    const mem = conf.members.slice().sort((a, b) => A.ch[b] - A.ch[a]), fav = mem[0], p = A.ch[fav] / N, cn = esc(conf.name);
    head = p >= 0.5 ? `${name(fav)} Is the Clear Favorite in the ${cn}` : p >= 0.3 ? `${name(fav)} Leads a Crowded ${cn} Race` : `The ${cn} Race Is Wide Open`;
    const bub = bubbleOf(conf.members);
    if (bub.length) head += `, and ${andList(bub.map(name))} ${bub.length > 1 ? "Are" : "Is"} on the Playoff Bubble`;
    const d = Array.from({length: F + 1}, (_, b) => A.bids[c * (F + 1) + b] / N), avg = d.reduce((t, v, b) => t + v * b, 0);
    const mode = d.indexOf(Math.max(...d)), more = d.slice(mode + 1).reduce((t, v) => t + v, 0);
    dek = `We simulated the rest of the season ${N.toLocaleString()} times. The ${cn} most often sends ${NUMW[mode] || mode} team${mode === 1 ? "" : "s"} to the playoff, and ${NUMW[mode + 1] || mode + 1} or more in ${pw(more)} of simulations.`;
  } else {
    const p = A.natl[natl] / N;
    head = p >= 0.2 ? `${name(natl)} Is the Favorite to Win the National Title` : `No Team Is a Clear Favorite for the National Title`;
    head += `, and ${name(last)} Is Clinging to the Last Playoff Spot`;
    dek = `We simulated the rest of the season ${N.toLocaleString()} times to see which 12 teams make the College Football Playoff and how they get there.`;
  }
  $("headline").innerHTML = head;
  $("dek").innerHTML = dek;
  document.title = `${D.teams[conf ? conf.members.reduce((b, i) => A.ch[i] > A.ch[b] ? i : b, conf.members[0]) : natl].name} and the playoff race: forecast`;

  let html = `${nm(natl)} wins the national title in ${pw(A.natl[natl] / N)} of our simulations, more than any other team`
    + (one === natl ? `, and it is the most likely No.&nbsp;1 seed.` : `; ${nm(one)} is the most likely No.&nbsp;1 seed.`)
    + ` The race for the last spots is close: ${nm(last)} makes the field in ${pw(A.cfp[last] / N)} of simulations, and ${nm(out)}, the first team out, in ${pw(A.cfp[out] / N)}.`;
  if (conf) {
    const mem = conf.members.slice().sort((a, b) => A.ch[b] - A.ch[a]);
    html += ` In the ${esc(conf.name)}, ${nm(mem[0])} wins the conference in ${pw(A.ch[mem[0]] / N)} of simulations, followed by ${nm(mem[1])} at ${pw(A.ch[mem[1]] / N)}.`;
  }
  html += moversSentence();
  $("summary").innerHTML = html;
}

// Biggest moves in published playoff odds over about the last week.
// Biggest moves in published playoff odds over about the last week.
function moversSentence() {
  if (!HIST || HIST.length < 2) return "";
  const last = HIST[HIST.length - 1], cutoff = new Date(last.date + "T12:00:00");
  cutoff.setDate(cutoff.getDate() - 7);
  const day = cutoff.toISOString().slice(0, 10);
  const then = [...HIST].reverse().find(x => x.date <= day) || HIST[0];
  if (then === last) return "";
  const moves = D.teams.map(t => ({id: t.id, d: (last.cfp[t.id] || 0) - (then.cfp[t.id] || 0)})).filter(m => Math.abs(m.d) >= 0.03);
  const up = moves.filter(m => m.d > 0).sort((a, b) => b.d - a.d).slice(0, 3), down = moves.filter(m => m.d < 0).sort((a, b) => a.d - b.d).slice(0, 3);
  if (!up.length && !down.length) return ` The forecast has barely moved since ${apDay(then.date)}.`;
  const list = ms => ms.map(m => `<b>${esc(D.teams[IDX.get(m.id)].name)}</b> (${m.d > 0 ? "up" : "down"} ${Math.round(Math.abs(m.d) * 100)} points)`).join(", ");
  return ` Since ${apDay(then.date)}, the biggest gains in playoff chances belong to ${up.length ? list(up) : "no one"}`
    + `${down.length ? `; the biggest drops, to ${list(down)}` : ""}.`;
}

// What a remaining game is worth: each side's chance of making the playoff
// and of winning its conference, in simulated seasons where it wins vs.
// loses. Null when one result never (or almost never) happened.
function gameStakes(j) {
  const {A, P} = LAST, g = P.rem[j], N = A.N, hw = A.levH[j], aw = N - hw, b = j * 8;
  if (hw < 30 || aw < 30) return null;
  const side = (t, off, winsWhenHome) => t < 0 ? null : {
    i: t, pWin: winsWhenHome ? hw / N : aw / N,
    cfpWin: A.lev[b + off + (winsWhenHome ? 0 : 2)] / (winsWhenHome ? hw : aw), cfpLoss: A.lev[b + off + (winsWhenHome ? 2 : 0)] / (winsWhenHome ? aw : hw),
    chWin: A.lev[b + off + (winsWhenHome ? 1 : 3)] / (winsWhenHome ? hw : aw), chLoss: A.lev[b + off + (winsWhenHome ? 3 : 1)] / (winsWhenHome ? aw : hw)
  };
  const home = side(g.h, 0, true), away = side(g.a, 4, false);
  const swing = x => x ? (x.cfpWin - x.cfpLoss) + 0.5 * (x.chWin - x.chLoss) : 0;
  return {home, away, weight: swing(home) + swing(away)};
}

const GAME_INDEX = () => new Map(LAST.P.remIds.map((id, j) => [id, j]));

// One team: odds, published odds over time, and every game on the schedule
// with what the remaining ones are worth.
// Follow a team: headline numbers, the outlook in words, what it needs,
// its chances by day, and every game on its schedule.
function renderTeamPage() {
  if (!LAST) return;
  const {A, P} = LAST, N = A.N;
  if (!S.view.team || !IDX.has(S.view.team)) {
    const pool = D.teams.map((_, i) => i).filter(i => inView(D.teams[i]));
    S.view.team = D.teams[pool.reduce((b, i) => A.cfp[i] > A.cfp[b] ? i : b, pool[0] ?? 0)].id;
  }
  const i = IDX.get(S.view.team), t = D.teams[i], r = REC[i], none = P.confs[P.confOf[i]].format === "none";
  const cs = CONF_SHORT[t.conf] || t.conf, pIn = A.cfp[i] / N;
  $("teamSel").innerHTML = [...D.teams].sort((a, b) => a.name.localeCompare(b.name))
    .map(x => `<option value="${esc(x.id)}"${x.id === t.id ? " selected" : ""}>${esc(x.name)}</option>`).join("");

  const fig = (v, label) => `<div class="fig"><div class="fv">${pc(v)}</div><div class="fl">${label}</div></div>`;
  let html = `<div class="col"><div class="figs">${fig(pIn, "Make the playoff")}${fig(A.bye[i] / N, "Get a first-round bye")}`
    + `${none ? "" : fig(A.ch[i] / N, `Win the ${esc(cs)}`)}${fig(A.natl[i] / N, "Win the national title")}</div>`;
  html += `<p class="intro">${esc(t.name)} (${r.w}–${r.l}${none ? "" : `, ${r.cw}–${r.cl} ${esc(cs)}`}) is projected to finish ${Math.round(A.sw[i] / N)}–${Math.round(A.sl[i] / N)}. `
    + `It makes the playoff in ${pw(pIn)} of our simulations${pIn >= 0.005 ? `, gets a bye in ${pw(A.bye[i] / N)} and hosts a first-round game in ${pw(A.host[i] / N)}` : ""}.`
    + `${none ? "" : ` It wins the ${esc(t.conf)} in ${pw(A.ch[i] / N)}.`}</p>`;

  // What it needs: remaining games it almost always wins in the simulations
  // where it makes the playoff, compared with its chance overall.
  const gi = GAME_INDEX(), rows = D.games.filter(g => g.home === t.id || g.away === t.id);
  const needs = [];
  for (const g of rows) {
    if (g.hp != null || !gi.has(g.id) || S.forced[g.id]) continue;
    const j = gi.get(g.id), home = g.home === t.id, b = j * 8, hw = A.levH[j];
    const winIn = A.cfp[i] ? (home ? A.lev[b] : A.lev[b + 6]) / A.cfp[i] : 0, pWin = (home ? hw : N - hw) / N;
    needs.push({g, home, winIn, pWin});
  }
  if (pIn >= 0.005 && pIn <= 0.995 && needs.length) {
    const key = needs.filter(x => x.winIn - x.pWin >= 0.05).sort((a, b) => (b.winIn - b.pWin) - (a.winIn - a.pWin)).slice(0, 3);
    const opp = x => esc(x.home ? gName(x.g, "a") : gName(x.g, "h"));
    if (key.length) html += `<h3>What ${esc(t.name)} needs</h3><p class="intro">In the simulations where ${esc(t.name)} makes the playoff, it beats `
      + andList(key.map((x, k) => `${opp(x)} ${Math.round(x.winIn * 100)} percent${k ? "" : " of the time"} (vs. ${Math.round(x.pWin * 100)} percent overall)`))
      + `. Those are the games that matter most for its playoff hopes.</p>`;
  } else if (pIn > 0.995) html += `<p class="intro">${esc(t.name)} makes the playoff in virtually every simulation; the question is seeding.</p>`;
  html += seedHistogram(i) + `</div>`;

  if (HIST && HIST.length > 1) {
    const marks = rows.filter(g => g.hp != null && g.date).map(g => {
      const home = g.home === t.id, us = home ? g.hp : g.ap, them = home ? g.ap : g.hp, opp = home ? g.away : g.home;
      const on = opp ? (D.teams[IDX.get(opp)].abbr || sh(D.teams[IDX.get(opp)].name).slice(0, 8)) : "FCS";
      return {ms: new Date(g.date).getTime(), label: `${us > them ? "W" : "L"} ${on}`};
    });
    const series = [{id: t.id, vals: histSeries(t.id, "cfp"), cls: "main", label: "Playoff"}];
    if (!none) series.push({id: t.id, vals: histSeries(t.id, "ch"), cls: "second", label: `Win ${cs}`});
    html += `<h3>${esc(t.name)}'s chances by day</h3>` + lineChart(series, {w: 760, h: 220, marks});
  }

  html += `<h3>Schedule</h3><div class="scroll"><table><thead><tr><th class="num">Wk.</th><th>Opponent</th><th class="num">Result or chance to win</th>
    <th class="num" title="How often it wins this game in the simulations where it makes the playoff">Wins it in playoff seasons</th>
    <th class="num">Playoff chance if it wins / loses</th>${none ? "" : `<th class="num">${esc(cs)} title if it wins / loses</th>`}</tr></thead><tbody>
    ${rows.map(g => {
      const home = g.home === t.id, opp = home ? g.away : g.home, oppName = opp ? tl(opp, D.teams[IDX.get(opp)].name) : esc(home ? g.awayName : g.homeName);
      const where = g.neutral ? "vs." : home ? "" : "at";
      let res = "", cfp = "", ch = "", inP = "";
      if (g.hp != null) {
        const us = home ? g.hp : g.ap, them = home ? g.ap : g.hp;
        res = `${us > them ? "W" : "L"} ${us}–${them}`;
      } else if (gi.has(g.id)) {
        const st = gameStakes(gi.get(g.id)), me = st && (home ? st.home : st.away), forced = S.forced[g.id];
        const nd = needs.find(x => x.g === g);
        res = forced ? `<span class="muted">${(forced === 2) === home ? "W" : "L"} (your pick)</span>` : me ? pc(me.pWin) : "";
        if (nd && pIn >= 0.005) inP = pc(nd.winIn);
        if (me) { cfp = `${pc(me.cfpWin)} / ${pc(me.cfpLoss)}`; ch = `${pc(me.chWin)} / ${pc(me.chLoss)}`; }
      }
      return `<tr><td class="num">${g.week}</td><td><span class="muted">${where}</span> ${oppName}${g.champ ? ` <span class="muted">(title game)</span>` : ""}</td>
        <td class="num">${res}</td><td class="num">${inP}</td><td class="num">${cfp}</td>${none ? "" : `<td class="num">${ch}</td>`}</tr>`;
    }).join("")}
    </tbody></table></div>`;
  $("teamView").innerHTML = html;
  renderPicks();
}

// How often the team gets each playoff seed, as columns grouped by what the
// seed means (bye, home game, road game). The most likely seed is in red;
// with picks, a gray line marks each seed's share without them.
function seedHistogram(i) {
  const {A, B} = LAST, N = A.N, F = A.F, t = D.teams[i], pIn = A.cfp[i] / N;
  if (!F) return "";
  const share = (X, q) => X.seed[i * F + q] / X.N, s = Array.from({length: F}, (_, q) => share(A, q));
  const base = B ? Array.from({length: F}, (_, q) => share(B, q)) : null;
  const top = Math.max(...s, ...(base || [])), best = pIn >= 0.005 ? s.indexOf(Math.max(...s)) : -1;
  const head = `<h3>Where ${esc(t.name)} lands in the bracket</h3>`;
  if (pIn < 0.005 && (!B || B.cfp[i] / N < 0.005)) return head + `<p class="note">${esc(t.name)} makes the playoff in less than 1 percent of simulations, too few to chart.</p>`;
  const cols = s.map((v, q) => {
    // Bars use the bottom 85% so the labels above the tallest one fit.
    const h = top ? v / top * 85 : 0, bh = base && Math.abs(base[q] - v) >= 0.005 ? base[q] / top * 85 : null, n = A.seed[i * F + q];
    return `<div class="c${q === best ? " top" : ""}" title="Seed ${q + 1}: ${n.toLocaleString()} of ${N.toLocaleString()} simulations${base ? ` (${pc(base[q])} without your picks)` : ""}">
      <div class="b" style="height:${h.toFixed(1)}%"></div>${bh != null ? `<div class="base" style="bottom:${bh.toFixed(1)}%"></div>` : ""}
      ${v > 0 ? `<span class="v" style="bottom:calc(${Math.max(h, bh || 0).toFixed(1)}% + 3px)">${pc(v)}</span>` : ""}</div>`;
  }).join("");
  const nums = s.map((_, q) => `<div class="n">${q + 1}</div>`).join("");
  const hosts = A.M - A.B, groups = [[A.B, "First-round bye"], [hosts, "Hosts first round"], [F - A.B - hosts, "Plays first round away"]];
  let at = 1;
  const glabels = groups.filter(([k]) => k > 0).map(([k, label]) => {
    const g = `<div class="g" style="grid-column:${at} / span ${k}">${k >= 2 ? label : label.split(" ")[0]}</div>`;
    at += k;
    return g;
  }).join("");
  const missed = 1 - pIn;
  return head + `<p class="note">Share of the ${N.toLocaleString()} simulations in which ${esc(t.name)} gets each seed. `
    + (missed > 0 ? `It misses the playoff in ${pw(missed)}` : `It never misses the playoff`)
    + `${B ? ` (${B.cfp[i] < N ? pw(1 - B.cfp[i] / N) : "never"} without your picks; gray lines show each seed without them)` : ""}. `
    + `${best >= 0 ? `Seed ${best + 1} is the most likely.` : ""}</p>`
    + `<div class="sh" style="grid-template-columns:repeat(${F}, minmax(0, 1fr))" role="img" aria-label="${esc(t.name)}'s chance of each playoff seed">${cols}${nums}${glabels}</div>`;
}

// Published playoff (and conference title) odds by day for one team, on a
// fixed 0–100% scale with the lines labeled at their ends.

function renderAll() {
  computeRatings();
  bindSettings();
  renderConfPicker();
  renderInfo();
  renderTeams();
  renderPicks();
  renderBigWeek();
  renderSummary(); renderResults(); renderNational(); renderHeat(); renderBids(); renderTeamPage();
}

// ---- Import / export / reset ------------------------------------------------

function importFile(txt) {
  let obj;
  try { obj = JSON.parse(txt); } catch { return showMessage("That file isn't valid JSON.", true); }
  if (obj && (obj.format === SEASON_FORMAT || (Array.isArray(obj.teams) && Array.isArray(obj.games)))) {
    let v;
    try { v = validateSeason(obj); } catch (e) { return showMessage(`That season file can't be used: ${esc(e.message)}.`, true); }
    customMem = store.set(CUSTOM_KEY, JSON.stringify(obj)) ? null : obj;
    setSeason(v, "imported");
    renderAll(); run(); startPolling();
    return;
  }
  if (obj && Array.isArray(obj.teams) && typeof obj.schedule === "string") {
    S = {...migrateV1(obj), view: S.view};
    save(); renderAll(); run();
    return showMessage("That's an export from the SEC-only version. Its model settings were imported; ratings and the hand-entered schedule weren't, since teams and games now come from the season data.");
  }
  if (obj && (obj.format === STATE_FORMAT || obj.settings || obj.cfp)) {
    S = validateState(obj);
    pruneForced(); save(); renderAll(); run();
    return renderInfo();
  }
  showMessage("That file isn't a simulator settings export or a season data file.", true);
}

// Theme button: auto (follow the system) → light → dark.
const THEME_KEY = "fbsSim.theme", THEMES = ["auto", "light", "dark"];
function applyTheme(t) {
  if (t === "auto") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
  $("themeBtn").textContent = `Theme: ${t}`;
}

function bindStatic() {
  applyTheme(THEMES.includes(store.get(THEME_KEY)) ? store.get(THEME_KEY) : "auto");
  $("themeBtn").onclick = () => {
    const cur = document.documentElement.dataset.theme || "auto", next = THEMES[(THEMES.indexOf(cur) + 1) % THEMES.length];
    if (next === "auto") store.del(THEME_KEY); else store.set(THEME_KEY, next);
    applyTheme(next);
  };
  $("runBtn").onclick = run;
  $("refreshBtn").onclick = refresh;
  $("clearBtn").onclick = () => { S.forced = {}; save(); renderPicks(); renderBigWeek(); run(); };
  $("winOutBtn").onclick = winOut;
  $("confSel").onchange = () => { S.view.conf = $("confSel").value; S.view.sort = null; save(); renderTeams(); renderSummary(); renderResults(); renderNational(); renderHeat(); renderBids(); renderTeamPage(); };
  $("teamSel").onchange = () => { S.view.team = $("teamSel").value; save(); renderTeamPage(); renderNatChart(); };
  document.addEventListener("click", e => {
    const pick = e.target.closest("button[data-k][data-v]");
    if (pick && D) { togglePick(pick.dataset.k, +pick.dataset.v); return; }
    const a = e.target.closest("a.tl[data-team]");
    if (!a || !D || !IDX.has(a.dataset.team)) return;
    S.view.team = a.dataset.team; save(); renderTeamPage(); renderNatChart();
  });
  $("vPlace").onclick = () => { S.view.heat = "place"; save(); renderHeat(); };
  $("vWins").onclick = () => { S.view.heat = "wins"; save(); renderHeat(); };
  $("resetBtn").onclick = () => {
    if (!confirm("Reset model settings, rating overrides and what-ifs to defaults?")) return;
    S = defaultState(); save(); renderAll(); run();
  };
  $("exportBtn").onclick = () => {
    const blob = new Blob([JSON.stringify({format: STATE_FORMAT, version: 2, season: D && D.season, ...S}, null, 2)], {type: "application/json"});
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "fbs-simulator-settings.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  $("importBtn").onclick = () => $("importFile").click();
  $("importFile").onchange = e => {
    const file = e.target.files[0];
    if (file) file.text().then(importFile);
    e.target.value = "";
  };
}

$("boot").remove();
bindStatic();
refresh();
