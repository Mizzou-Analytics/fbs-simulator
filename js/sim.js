import {benchWinProb, DEFAULT_TIEBREAK} from "./model.js";

// Monte Carlo season simulator. Pure functions with no DOM access, so it runs
// in a Web Worker, on the main thread, or under Node for tests.

// Every simulated season gets its own generator seeded from (seed, season
// number), and each season draws its random numbers in a fixed order whether
// or not a game is forced. Runs with and without what-ifs therefore share the
// same draws, so their differences come from the what-ifs, not from noise.
export function makeRng(seed, s) {
  let a = 0x9e3779b9, b = seed | 0, c = s | 0, d = (0x85ebca6b ^ Math.imul(s, 0x27d4eb2f)) | 0;
  const next = () => {
    a |= 0; b |= 0; c |= 0; d |= 0;
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
  for (let i = 0; i < 15; i++) next();
  return next;
}

export function gauss(rng) {
  const u = rng() || 1e-12, v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// Seed order for a fixed m-slot bracket, e.g. 8 → [1, 8, 4, 5, 2, 7, 3, 6].
export function bracketSlots(m) {
  let s = [1];
  while (s.length < m) {
    const k = s.length * 2;
    s = s.flatMap(x => [x, k + 1 - x]);
  }
  return s;
}

const EPS = 1e-9;

// Conference standings with tiebreakers. Each conference lists its own
// steps (CONF_TIEBREAKS in model.js), drawn from:
//   h2h          Head-to-head among the tied teams (if all played each other;
//                otherwise a team that beat all the others wins and one that
//                lost to all of them drops out)
//   common       Record against common conference opponents
//   tiers        Record against the highest-placed common opponent, working
//                down the standings
//   oppStrength  Combined conference winning percentage of conference opponents
//   totalWins    Total wins, all games
//   rank         The committee's ranking going into title weekend
//   metric       A ratings metric (the season's simulated team strength)
// Whenever a step separates some teams but not all, the rest start over at
// step 1, and once a team is placed the remaining teams start over too.
// ctx holds arrays the caller mutates between calls.
export function makeRanker(ctx) {
  const {n, G2, wins, CW, CL, confOpps, r, W, rankScore} = ctx;
  const pct = i => { const g = CW[i] + CL[i]; return g ? CW[i] / g : 0; };
  const vsGroup = (t, opps) => {
    let w = 0, g = 0;
    for (const o of opps) { w += wins[t * n + o]; g += G2[t * n + o]; }
    return g ? w / g : 0;
  };

  const STEP = {
    h2h(T) {
      let all = true;
      for (let x = 0; x < T.length && all; x++)
        for (let y = x + 1; y < T.length; y++) if (!G2[T[x] * n + T[y]]) { all = false; break; }
      if (all) return T.map(t => vsGroup(t, T));
      if (T.length === 2) return null;
      const beat = T.map(t => T.every(o => o === t || (G2[t * n + o] && wins[t * n + o] === G2[t * n + o])));
      if (beat.some(Boolean)) return beat.map(b => b ? 1 : 0);
      const lost = T.map(t => T.every(o => o === t || (G2[t * n + o] && !wins[t * n + o])));
      if (lost.some(Boolean)) return lost.map(b => b ? 0 : 1);
      return null;
    },
    common(T, pool) {
      const opps = pool.filter(o => !T.includes(o) && T.every(t => G2[t * n + o]));
      return opps.length ? T.map(t => vsGroup(t, opps)) : null;
    },
    tiers(T, pool) {
      const others = pool.filter(o => !T.includes(o)).sort((a, b) => pct(b) - pct(a));
      for (let i = 0; i < others.length;) {
        let j = i + 1;
        while (j < others.length && pct(others[i]) - pct(others[j]) < EPS) j++;
        const opps = others.slice(i, j).filter(o => T.every(t => G2[t * n + o]));
        if (opps.length) {
          const v = T.map(t => vsGroup(t, opps));
          if (Math.max(...v) - Math.min(...v) > EPS) return v;
        }
        i = j;
      }
      return null;
    },
    oppStrength: T => T.map(t => {
      let w = 0, g = 0;
      for (const o of confOpps[t]) { w += CW[o]; g += CW[o] + CL[o]; }
      return g ? w / g : 0;
    }),
    totalWins: T => W ? T.map(t => W[t]) : null,
    rank: T => rankScore ? T.map(t => rankScore[t]) : null,
    metric: T => T.map(t => r[t])
  };

  function pickTop(T, pool, steps) {
    let cur = T;
    restart: for (;;) {
      if (cur.length === 1) return cur[0];
      for (const name of steps) {
        const v = STEP[name] && STEP[name](cur, pool);
        if (!v) continue;
        const best = Math.max(...v), keep = cur.filter((_, k) => v[k] >= best - EPS);
        if (keep.length === 1) return keep[0];
        if (keep.length < cur.length) { cur = keep; continue restart; }
      }
      // Still tied after every listed step: fall back to the ratings metric.
      return cur.reduce((b, t) => r[t] > r[b] ? t : b, cur[0]);
    }
  }

  // Orders `members` by conference record, breaking ties against `pool`
  // (the whole conference, even when ranking one division).
  return function rank(members, pool = members, steps = DEFAULT_TIEBREAK) {
    const arr = members.slice().sort((a, b) => pct(b) - pct(a)), out = [];
    for (let i = 0; i < arr.length;) {
      let j = i + 1;
      while (j < arr.length && pct(arr[i]) - pct(arr[j]) < EPS) j++;
      let rest = arr.slice(i, j);
      while (rest.length > 1) {
        const t = pickTop(rest, pool, steps);
        out.push(t);
        rest = rest.filter(x => x !== t);
      }
      out.push(rest[0]);
      i = j;
    }
    return out;
  };
}

// Runs N seasons. With useForce, what-if results replace the simulated
// outcome of those games. Returns per-team counts over all seasons, plus
// per-game counts of each side's playoff and conference-title outcomes split
// by who won that game ("lev"), for measuring what each game is worth.
export function simulate(P, useForce, onProgress) {
  const {n, confs, confOf, R, rem, forced, sos, maxConfSize, maxConfG, expW} = P;
  const {N, seed, hfa, gsd, rsd, fcs, lossPen, champBonus, sosW, indSD, titleLossW, h2hWin, seeding,
    field: F, byes: B, autoBids, model, sorW, bench} = P.params;
  const nc = confs.length, cw1 = maxConfG + 1, nr = rem.length;
  // Bracket: M slots after the first round (byes plus first-round winners),
  // then log2(M) more rounds. Stage k of `reach` is the round with M / 2^k
  // teams left, so the last stage is the champion.
  const M = B + (F - B) / 2, stages = Math.round(Math.log2(M)) + 1, hosts = (F - B) / 2;
  const out = {N, n, F, B, M, stages, maxConfSize, maxConfG,
    seed: new Float64Array(n * F), host: new Float64Array(n), auto: new Float64Array(n), reach: new Float64Array(n * stages), sor: new Float64Array(n),
    sw: new Float64Array(n), sl: new Float64Array(n), scw: new Float64Array(n), scl: new Float64Array(n),
    top2: new Float64Array(n), ch: new Float64Array(n), cfp: new Float64Array(n), bye: new Float64Array(n), natl: new Float64Array(n),
    place: new Float64Array(n * maxConfSize), cwins: new Float64Array(n * cw1), bids: new Float64Array(nc * (F + 1)),
    // lev[j*8 + (side*2 + result)*2 + metric]: side 0 = home, 1 = away;
    // result 0 = home won, 1 = away won; metric 0 = made the field, 1 = won
    // the conference. levH[j] counts home wins.
    lev: new Float64Array(nr * 8), levH: new Float64Array(nr)};

  const r = new Float64Array(n), W = new Int16Array(n), L = new Int16Array(n), CW = new Int16Array(n), CL = new Int16Array(n);
  const wins = new Int16Array(n * n), champW = new Int16Array(nc), champL = new Int16Array(nc);
  const isChamp = new Uint8Array(n), lostTitle = new Uint8Array(n), inField = new Uint8Array(n), sc = new Float64Array(n);
  const noise = new Float64Array(n), preScore = new Float64Array(n), titleOpp = new Int16Array(n), titleHome = new Int16Array(n);
  const seeded = new Uint8Array(n), resHome = new Uint8Array(nr), tW = new Int16Array(nc), tL = new Int16Array(nc);
  const bidCount = new Int16Array(nc), seeds = new Int16Array(F), slot = new Int16Array(F);
  const order = Array.from({length: n}, (_, i) => i), byScore = (a, b) => sc[b] - sc[a];
  const rank = makeRanker({n, G2: P.G2, wins, CW, CL, confOpps: P.confOpps, r, W, rankScore: preScore});
  const slots = bracketSlots(M), every = Math.max(1, Math.floor(N / 50));
  const play = (x, y, adv, z) => r[x] - r[y] + adv + gsd * z > 0 ? x : y;

  // Committee score before champion bonus and noise. A lost title game
  // counts with weight titleLossW (0 = ignored, 1 = a full loss).
  const committeeBase = (i, sor) => model === "losses"
    ? r[i] - lossPen * (L[i] - (lostTitle[i] ? 1 - titleLossW : 0)) + sosW * sos[i]
    : r[i] + sorW * sor;
  const sorOf = i => {
    let v = W[i] - expW[i];
    const o = titleOpp[i];
    if (o >= 0) {
      const p = benchWinProb(bench, R[o], titleHome[i] < 0 ? 0 : titleHome[i] === i ? hfa : -hfa, gsd);
      v -= lostTitle[i] ? titleLossW * p : p;
    }
    return v;
  };
  // Head-to-head: if a team finished within h2hWin points of a team it beat,
  // it moves just ahead of that team.
  const h2h = (w, l) => { if (w >= 0 && l >= 0 && sc[w] < sc[l] && sc[l] - sc[w] <= h2hWin) sc[w] = sc[l] + 1e-6; };

  for (let s = 0; s < N; s++) {
    const rng = makeRng(seed, s);
    for (let i = 0; i < n; i++) r[i] = R[i] + rsd * gauss(rng);
    W.set(P.W0); L.set(P.L0); CW.set(P.CW0); CL.set(P.CL0); wins.set(P.wins0);
    champW.fill(-1); champL.fill(-1); isChamp.fill(0); lostTitle.fill(0); titleOpp.fill(-1); tW.fill(-1);

    for (let j = 0; j < nr; j++) {
      const g = rem[j], z = gauss(rng), f = useForce ? forced[j] : 0;
      const hw = f ? f === 2 : (g.h >= 0 ? r[g.h] : fcs) - (g.a >= 0 ? r[g.a] : fcs) + (g.neu ? 0 : hfa) + gsd * z > 0;
      const w = hw ? g.h : g.a, l = hw ? g.a : g.h;
      resHome[j] = hw ? 1 : 0;
      if (w >= 0) W[w]++;
      if (l >= 0) L[l]++;
      if (g.champ >= 0) { champW[g.champ] = w; champL[g.champ] = l; }
      else if (g.conf) { CW[w]++; CL[l]++; wins[w * n + l]++; }
    }

    // Committee noise is drawn once per season and shared by the
    // title-weekend ranking (a tiebreak step in some conferences) and the
    // final selection.
    for (let i = 0; i < n; i++) {
      noise[i] = indSD * gauss(rng);
      preScore[i] = committeeBase(i, W[i] - expW[i]) + noise[i];
    }

    for (let c = 0; c < nc; c++) {
      const C = confs[c], z = gauss(rng);
      if (C.format === "none" || !C.members.length) continue;
      const tb = C.tiebreak || DEFAULT_TIEBREAK, ord = rank(C.members, C.members, tb);
      for (let p = 0; p < ord.length; p++) out.place[ord[p] * maxConfSize + p]++;
      let champ = -1, lo = -1, home = -1;
      if (C.champDone) { champ = C.champDone.w; lo = C.champDone.l; home = C.champDone.home; }
      else if (C.champGame >= 0) { champ = champW[c]; lo = champL[c]; const g = rem[C.champGame]; home = g.neu ? -1 : g.h; }
      else if (C.format === "first" || ord.length < 2) champ = ord[0];
      else {
        let x = ord[0], y = ord[1];
        if (C.divs) {
          const wn = C.divs.map(d => rank(d, C.members, tb)[0]).sort((a, b) => ord.indexOf(a) - ord.indexOf(b));
          [x, y] = wn;
        }
        if (y === undefined) champ = x;
        else {
          if (C.hosted) home = x;
          champ = play(x, y, C.hosted ? hfa : 0, z);
          lo = champ === x ? y : x;
          W[champ]++; L[lo]++;
          tW[c] = champ; tL[c] = lo;
        }
      }
      if (champ >= 0) { isChamp[champ] = 1; out.ch[champ]++; }
      if (champ >= 0 && lo >= 0) {
        out.top2[champ]++; out.top2[lo]++; lostTitle[lo] = 1;
        titleOpp[champ] = lo; titleOpp[lo] = champ; titleHome[champ] = titleHome[lo] = home;
      }
    }

    for (let i = 0; i < n; i++) {
      out.sw[i] += W[i]; out.sl[i] += L[i]; out.scw[i] += CW[i]; out.scl[i] += CL[i];
      if (CW[i] < cw1) out.cwins[i * cw1 + CW[i]]++;
    }

    // Committee: score every team, apply head-to-head between close teams,
    // give the auto bids to the top-scoring conference champions, fill the
    // rest of the field by score, then seed it.
    for (let i = 0; i < n; i++) {
      const sor = sorOf(i);
      out.sor[i] += sor;
      sc[i] = committeeBase(i, sor) + (isChamp[i] ? champBonus : 0) + noise[i];
    }
    if (h2hWin > 0) {
      for (let k = 0; k < P.playedW.length; k++) h2h(P.playedW[k], P.playedL[k]);
      for (let j = 0; j < nr; j++) { const g = rem[j]; if (resHome[j]) h2h(g.h, g.a); else h2h(g.a, g.h); }
      for (let c = 0; c < nc; c++) if (tW[c] >= 0) h2h(tW[c], tL[c]);
    }
    order.sort(byScore);
    inField.fill(0);
    let cnt = 0;
    for (let k = 0; k < n && cnt < autoBids; k++) if (isChamp[order[k]]) { inField[order[k]] = 1; out.auto[order[k]]++; cnt++; }
    for (let k = 0; k < n && cnt < F; k++) if (!inField[order[k]]) { inField[order[k]] = 1; cnt++; }
    // Straight seeding by score, except under the 2024 rule, where the
    // top-ranked conference champions take the bye seeds first.
    let q = 0;
    seeded.fill(0);
    if (seeding === "champs") for (let k = 0; k < n && q < B; k++) {
      const i = order[k];
      if (inField[i] && isChamp[i]) { seeds[q++] = i; seeded[i] = 1; }
    }
    for (let k = 0; k < n && q < cnt; k++) if (inField[order[k]] && !seeded[order[k]]) seeds[q++] = order[k];
    bidCount.fill(0);
    for (let k = 0; k < cnt; k++) {
      const i = seeds[k];
      out.cfp[i]++;
      out.seed[i * F + k]++;
      if (k < B) out.bye[i]++;
      else if (k < B + hosts) out.host[i]++;
      bidCount[confOf[i]]++;
    }
    for (let c = 0; c < nc; c++) out.bids[c * (F + 1) + bidCount[c]]++;

    for (let j = 0; j < nr; j++) {
      const g = rem[j], res = resHome[j] ? 0 : 1, base = j * 8;
      out.levH[j] += resHome[j];
      if (g.h >= 0) { out.lev[base + res * 2] += inField[g.h]; out.lev[base + res * 2 + 1] += isChamp[g.h]; }
      if (g.a >= 0) { out.lev[base + 4 + res * 2] += inField[g.a]; out.lev[base + 4 + res * 2 + 1] += isChamp[g.a]; }
    }

    // Bracket: first round at the higher seed, then neutral sites.
    if (cnt === F) {
      for (let k = 0; k < B; k++) slot[k] = seeds[k];
      for (let k = 0; k < (F - B) / 2; k++) slot[B + k] = play(seeds[B + k], seeds[F - 1 - k], hfa, gauss(rng));
      let round = slots.map(k => slot[k - 1]);
      for (let st = 0; ; st++) {
        for (const i of round) out.reach[i * stages + st]++;
        if (round.length === 1) break;
        const next = [];
        for (let k = 0; k < round.length; k += 2) next.push(play(round[k], round[k + 1], 0, gauss(rng)));
        round = next;
      }
      out.natl[round[0]]++;
    }

    if (onProgress && (s + 1) % every === 0) onProgress((s + 1) / N);
  }
  return out;
}
