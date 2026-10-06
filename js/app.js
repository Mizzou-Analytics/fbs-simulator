import {bracketSlots} from "./sim.js";
import {validateSeason, validateState, defaultState, migrateV1, cleanSetting, clampRating, prepare, baseRatings, previousRatings,
  teamRecords, bracketError, phi, SOURCE_LABELS, STATE_FORMAT, SEASON_FORMAT} from "./model.js";

const KEY = "fbsSim.v2", CUSTOM_KEY = "fbsSim.season", POLL_MS = 10 * 60 * 1000;
const SHORT = {"Mississippi State": "Miss. State", "South Carolina": "S. Carolina", "Appalachian State": "App State",
  "Georgia Southern": "Ga. Southern", "Middle Tennessee": "Middle Tenn.", "Jacksonville State": "Jax State",
  "Western Kentucky": "W. Kentucky", "Western Michigan": "W. Michigan", "Central Michigan": "C. Michigan",
  "Eastern Michigan": "E. Michigan", "Northern Illinois": "N. Illinois", "Florida Atlantic": "FAU", "Coastal Carolina": "Coastal",
  "San José State": "San José St.", "San Diego State": "San Diego St.", "Washington State": "Wash. State",
  "Colorado State": "Colorado St.", "Sacramento State": "Sac State", "New Mexico State": "NM State"};

const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]));
const sh = n => SHORT[n] || n;
const pc = v => v > 0 && v < 0.001 ? "<0.1%" : (v * 100).toFixed(1) + "%";
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); return true; } catch { return false; } },
  del(k) { try { localStorage.removeItem(k); } catch { /* storage unavailable */ } }
};

let S = loadState();
let D = null, origin = "", warnings = [], customMem = null;
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
    try { return setSeason(await fetchSeason(url), o); } catch (e) { err = e; }
  }
  throw err;
}

function setSeason({season, warnings: w}, o) {
  D = season; origin = o; warnings = w;
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
  const parts = [`${D.season} season`, `through week ${D.currentWeek - 1}`];
  if (D.updated) parts.push(`data updated ${fmtDate(D.updated)}`);
  if (D.source) parts.push(D.source);
  $("dataInfo").textContent = parts.join(" · ");
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
        showMessage(`New scores or ratings are available (updated ${esc(fmtDate(raw.updated))}). <button class="link" id="loadNew">Load and re-run</button>`);
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
  RT = {src, base: values, prev, eff};
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
      S[g][k] = el.tagName === "SELECT" && k === "source" ? el.value : cleanSetting(g, k, el.value);
      save();
      if (g === "cfp") $("cfpErr").textContent = bracketError(S.cfp) || "";
      if (["source", "hfa", "fcs", "priorW", "cap", "gsd", "rsd"].includes(k)) { computeRatings(); renderTeams(); renderGames(); }
    };
    el.oninput = el.tagName === "SELECT" ? null : apply;
    el.onchange = () => { apply(); if (el.tagName !== "SELECT") el.value = S[g][k]; };
  });
  $("cfpErr").textContent = bracketError(S.cfp) || "";
}

function renderConfPicker() {
  $("confSel").innerHTML = `<option value="">All FBS</option>` +
    D.conferences.map(c => `<option${c.name === S.view.conf ? " selected" : ""}>${esc(c.name)}</option>`).join("");
  $("confSel").value = S.view.conf;
}

const inView = t => !S.view.conf || t.conf === S.view.conf;

function renderTeams() {
  const all = !S.view.conf, idx = D.teams.map((_, i) => i).filter(i => inView(D.teams[i]));
  idx.sort((a, b) => RT.base[D.teams[b].id] - RT.base[D.teams[a].id]);
  $("teamsNote").textContent = `${srcLabel(RT.src)} ratings`;
  const head = `<thead><tr><th>Team</th>${all ? "<th>Conf</th>" : ""}<th class="num">W–L</th><th class="num">Conf</th>
    <th class="num">${esc(srcLabel(RT.src))}</th><th class="num">Δ wk</th><th>Override</th></tr></thead>`;
  const body = idx.map(i => {
    const t = D.teams[i], r = REC[i], base = RT.base[t.id], prev = RT.prev && RT.prev[t.id];
    const dv = Number.isFinite(prev) ? base - prev : null;
    const dtxt = dv === null ? "" : Math.abs(dv) < 0.05 ? "0.0" : `<span class="${dv > 0 ? "up" : "dn"}">${dv > 0 ? "+" : ""}${dv.toFixed(1)}</span>`;
    const ov = S.overrides[t.id];
    return `<tr><td>${esc(t.name)}</td>${all ? `<td class="muted">${esc(t.conf)}</td>` : ""}
      <td class="num">${r.w}–${r.l}</td><td class="num">${r.cw}–${r.cl}</td><td class="num">${base.toFixed(1)}</td><td class="num">${dtxt}</td>
      <td><input type="number" step="0.5" data-id="${esc(t.id)}" value="${Number.isFinite(ov) ? ov : ""}" placeholder="${base.toFixed(1)}" aria-label="Rating override for ${esc(t.name)}"></td></tr>`;
  }).join("");
  $("teams").innerHTML = head + `<tbody>${body}</tbody>`;
  $("teams").querySelectorAll("input").forEach(el => el.oninput = () => {
    const v = el.value.trim(), x = Number(v);
    if (!v || !Number.isFinite(x)) delete S.overrides[el.dataset.id];
    else S.overrides[el.dataset.id] = clampRating(x);
    save(); computeRatings(); renderGames();
  });
}

const gName = (g, side) => side === "h" ? (g.home ? D.teams[IDX.get(g.home)].name : g.homeName) : (g.away ? D.teams[IDX.get(g.away)].name : g.awayName);
const gConf = (g, conf) => (g.home && D.teams[IDX.get(g.home)].conf === conf) || (g.away && D.teams[IDX.get(g.away)].conf === conf);

function renderGames() {
  const conf = S.view.conf, rem = D.games.filter(g => g.hp == null && (!conf || gConf(g, conf)));
  const weeks = [...new Set(rem.map(g => g.week))].sort((a, b) => a - b);
  if (!weeks.includes(S.view.week)) S.view.week = weeks.length ? weeks[0] : null;
  $("weekSel").innerHTML = weeks.map(w => `<option value="${w}"${w === S.view.week ? " selected" : ""}>Week ${w}</option>`).join("");
  $("weekSel").disabled = !weeks.length;
  const {hfa, gsd, rsd, fcs} = S.settings, sd = Math.sqrt(gsd * gsd + 2 * rsd * rsd) || 1;
  const rating = id => id ? RT.eff[id] : fcs;
  const list = rem.filter(g => g.week === S.view.week);
  $("games").innerHTML = list.length ? list.map(g => {
    const A = gName(g, "a"), H = gName(g, "h"), f = S.forced[g.id] || 0;
    const ph = phi((rating(g.home) - rating(g.away) + (g.neutral ? 0 : hfa)) / sd);
    return `<div class="gm">
      <span class="t ${f ? "forced" : ""}" title="${esc(A)} ${g.neutral ? "vs" : "at"} ${esc(H)}">${esc(sh(A))} ${g.neutral ? "vs" : "@"} ${esc(sh(H))}${g.champ ? " · title game" : ""}</span>
      <span class="num muted" style="width:40px">${Math.round(ph * 100)}%</span>
      <select data-k="${esc(g.id)}" aria-label="Outcome for ${esc(A)} ${g.neutral ? "vs" : "at"} ${esc(H)}">
        <option value="0"${f === 0 ? " selected" : ""}>Simulate</option>
        <option value="1"${f === 1 ? " selected" : ""}>${esc(sh(A))} wins</option>
        <option value="2"${f === 2 ? " selected" : ""}>${esc(sh(H))} wins</option>
      </select></div>`;
  }).join("") : `<div class="muted">No remaining games${conf ? ` involving ${esc(conf)} teams` : ""}.</div>`;
  $("games").querySelectorAll("select").forEach(el => el.onchange = () => {
    const v = +el.value;
    if (v) S.forced[el.dataset.k] = v; else delete S.forced[el.dataset.k];
    save(); renderGames(); run();
  });
  const c = Object.keys(S.forced).length, here = list.filter(g => S.forced[g.id]).length;
  $("fc").textContent = c ? `${c} game${c > 1 ? "s" : ""} forced${c !== here ? ` (${here} this week)` : ""}` : "";
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
    $("status").textContent = `${A.N.toLocaleString()} seasons in ${secs}s` + (any ? " · colored numbers = change vs. no what-ifs (same random draws), in points" : "");
    renderResults(); renderNational(); renderHeat(); renderBids();
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
  {k: "name", label: "Team"}, {k: "conf", label: "Conf", allOnly: true}, {k: "rating", label: "Rating", num: true},
  {k: "rec", label: "Record", num: true}, {k: "proj", label: "Proj W–L", num: true}, {k: "projc", label: "Proj conf", num: true},
  {k: "t2", label: "Title game", num: true, p: true}, {k: "ch", label: "Conf champ", num: true, p: true},
  {k: "cfp", label: "Makes CFP", num: true, p: true}, {k: "bye", label: "Bye", num: true, p: true},
  {k: "natl", label: "Natl champ", num: true, p: true}
];

// Change vs. the no-what-if run, in percentage points; hidden under 0.5.
function dl(v) {
  const x = v * 100;
  if (Math.abs(x) < 0.5) return "";
  return ` <span class="d" style="color:var(--${x > 0 ? "good" : "bad"})">${x > 0 ? "+" : ""}${x.toFixed(1)}</span>`;
}

function renderResults() {
  if (!LAST) return;
  const {A, B, P} = LAST, N = A.N, all = !S.view.conf;
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
      return `<tr><td>${esc(z.name)}</td>${all ? `<td class="muted">${esc(z.conf)}</td>` : ""}
        <td class="num">${z.rating.toFixed(1)}</td>
        <td class="num">${r.w}–${r.l}</td>
        <td class="num">${z.proj.toFixed(1)}–${(A.sl[z.i] / N).toFixed(1)}</td>
        <td class="num">${z.none ? "—" : `${z.projc.toFixed(1)}–${(A.scl[z.i] / N).toFixed(1)}`}</td>
        ${["t2", "ch", "cfp", "bye", "natl"].map(k => `<td class="num">${z.none && (k === "t2" || k === "ch") ? "—" : pc(z[k]) + (B ? dl(z["d" + k]) : "")}</td>`).join("")}</tr>`;
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
const STAGE = {1: "Title", 2: "Final", 4: "Semis", 8: "QF", 16: "R16", 32: "R32"};
const ROUND = {2: "Semifinal", 4: "Quarterfinal", 8: "Quarterfinal", 16: "Round of 16"};

// National view: the projected field and bracket, then every contender's
// seed distribution and round-by-round odds.
function renderNational() {
  if (!LAST) return;
  const {A, B, P} = LAST, N = A.N, F = A.F, byes = A.B, hosts = (F - byes) / 2, conf = S.view.conf;
  const pIn = i => A.cfp[i] / N;
  // Average finish, counting a missed field as seed F + 1.
  const pos = D.teams.map((_, i) => {
    let e = (F + 1) * (N - A.cfp[i]);
    for (let q = 0; q < F; q++) e += (q + 1) * A.seed[i * F + q];
    return e / N;
  });
  const field = D.teams.map((_, i) => i).sort((a, b) => pIn(b) - pIn(a) || pos[a] - pos[b]).slice(0, F).sort((a, b) => pos[a] - pos[b]);
  const rec = i => `${Math.round(A.sw[i] / N)}–${Math.round(A.sl[i] / N)}`;
  const hl = i => conf && D.teams[i].conf === conf ? " hl" : "";

  const line = (q, role) => {
    const i = field[q], what = role === "bye" ? `bye ${pc(A.bye[i] / N)}` : role === "host" ? `hosts ${pc(A.host[i] / N)}` : `in ${pc(pIn(i))}`;
    return `<div class="tm${hl(i)}" title="${esc(D.teams[i].name)}: seed ${q + 1} in ${pc(A.seed[i * F + q] / N)} of seasons, in the field in ${pc(pIn(i))}">
      <span class="sd">${q + 1}</span><span class="nm">${esc(sh(D.teams[i].name))} <span class="muted">${rec(i)}</span></span>
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
  $("natNote").textContent = `${F}-team field · ${byes} byes · ${hosts} first-round hosts`;

  const rows = D.teams.map((_, i) => i).filter(i => pIn(i) >= 0.005).sort((a, b) => pIn(b) - pIn(a) || pos[a] - pos[b]);
  const stageCols = Array.from({length: A.stages}, (_, k) => k);
  const d = (k, i) => B ? dl((A[k][i] - B[k][i]) / N) : "";
  const cell = (i, q) => {
    const p = A.seed[i * F + q] / N * 100, shade = Math.min(100, p * 1.6);
    const txt = p >= 0.5 ? Math.round(p) : p > 0 ? "·" : "";
    return `<td class="hc" title="${esc(D.teams[i].name)}: seed ${q + 1} in ${p.toFixed(1)}% of seasons"
      style="background:color-mix(in srgb, var(--accent) ${shade.toFixed(0)}%, transparent);${shade > 55 ? "color:#fff;" : ""}">${txt}</td>`;
  };
  $("natTable").innerHTML = rows.length ? `<table class="nat"><thead><tr><th>Team</th><th>Conf</th>
      <th class="num">Makes CFP</th><th class="num" title="Gets in as one of the ${P.params.autoBids} highest-ranked conference champions">Auto bid</th>
      <th class="num">Bye</th><th class="num">Hosts 1st rd</th><th class="num" title="Average seed in seasons it makes the field">Avg seed</th>
      ${Array.from({length: F}, (_, q) => `<th class="hc">${q + 1}</th>`).join("")}
      ${stageCols.map(k => `<th class="num">${STAGE[A.M >> k] || ""}</th>`).join("")}</tr></thead><tbody>
    ${rows.map(i => {
      let avg = 0;
      for (let q = 0; q < F; q++) avg += (q + 1) * A.seed[i * F + q];
      return `<tr class="${hl(i).trim()}"><td title="${esc(D.teams[i].name)}">${esc(sh(D.teams[i].name))}</td><td class="muted" style="white-space:nowrap">${esc(CONF_SHORT[D.teams[i].conf] || D.teams[i].conf)}</td>
        <td class="num">${pc(pIn(i))}${d("cfp", i)}</td><td class="num">${pc(A.auto[i] / N)}</td>
        <td class="num">${pc(A.bye[i] / N)}${d("bye", i)}</td><td class="num">${pc(A.host[i] / N)}${d("host", i)}</td>
        <td class="num">${(avg / A.cfp[i]).toFixed(1)}</td>
        ${Array.from({length: F}, (_, q) => cell(i, q)).join("")}
        ${stageCols.map(k => `<td class="num">${pc(A.reach[i * A.stages + k] / N)}</td>`).join("")}</tr>`;
    }).join("")}
    </tbody></table>` : `<div class="muted">No team made the field.</div>`;
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
      ${labels.map((_, k) => {
        const p = arr[i * stride + k] / N * 100, shade = Math.min(100, p * 1.6);
        const txt = p >= 0.5 ? Math.round(p) : p > 0 ? "·" : "";
        return `<td style="background:color-mix(in srgb, var(--accent) ${shade.toFixed(0)}%, transparent);${shade > 55 ? "color:#fff;" : ""}">${txt}</td>`;
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
    $("bidAvg").textContent = `${S.view.conf} average: ${avg(d).toFixed(2)} teams`;
    $("bids").hidden = false;
    $("bids").innerHTML = vals.map((v, b) => `<div class="c">
        <span class="num">${(v * 100).toFixed(1)}%</span>
        <div class="b" style="height:${(v / mx * 100).toFixed(1)}px"></div>
        <span class="muted">${b}</span></div>`).join("");
  } else {
    $("bidAvg").textContent = "";
    $("bids").hidden = true;
  }
  const rows = P.confs.map((x, k) => ({name: x.name, d: dist(k)})).map(z => ({...z, avg: avg(z.d)})).sort((a, b) => b.avg - a.avg);
  $("bidTable").innerHTML = `<table><thead><tr><th>Conference</th><th class="num">Avg bids</th><th class="num">0 bids</th>
    <th class="num">1</th><th class="num">2</th><th class="num">3+</th></tr></thead><tbody>
    ${rows.map(z => `<tr${z.name === S.view.conf ? ' style="font-weight:600"' : ""}><td>${esc(z.name)}</td><td class="num">${z.avg.toFixed(2)}</td>
      <td class="num">${pc(z.d[0])}</td><td class="num">${pc(z.d[1] || 0)}</td><td class="num">${pc(z.d[2] || 0)}</td>
      <td class="num">${pc(z.d.slice(3).reduce((s, v) => s + v, 0))}</td></tr>`).join("")}
    </tbody></table>`;
}

function renderAll() {
  computeRatings();
  bindSettings();
  renderConfPicker();
  renderInfo();
  renderTeams();
  renderGames();
  renderResults(); renderNational(); renderHeat(); renderBids();
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

function bindStatic() {
  $("runBtn").onclick = run;
  $("refreshBtn").onclick = refresh;
  $("clearBtn").onclick = () => { S.forced = {}; save(); renderGames(); run(); };
  $("confSel").onchange = () => { S.view.conf = $("confSel").value; S.view.sort = null; save(); renderTeams(); renderGames(); renderResults(); renderNational(); renderHeat(); renderBids(); };
  $("weekSel").onchange = () => { S.view.week = +$("weekSel").value; save(); renderGames(); };
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
