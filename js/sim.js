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

// Conference standings with tiebreakers, modeled on the SEC's procedure:
//   1. Head-to-head among the tied teams (if all played each other; otherwise
//      a team that beat all the others wins and one that lost to all of them
//      drops out)
//   2. Record against common conference opponents
//   3. Record against the highest-placed common opponent, working down the
//      standings
//   4. Combined conference winning percentage of conference opponents
//   5. A ratings metric (the season's simulated team strength)
// Whenever a step separates some teams but not all, the rest start over at
// step 1, and once a team is placed the remaining teams start over too.
// ctx holds arrays the caller mutates between calls.
export function makeRanker(ctx) {
  const {n, G2, wins, CW, CL, confOpps, r} = ctx;
  const pct = i => { const g = CW[i] + CL[i]; return g ? CW[i] / g : 0; };
  const vsGroup = (t, opps) => {
    let w = 0, g = 0;
    for (const o of opps) { w += wins[t * n + o]; g += G2[t * n + o]; }
    return g ? w / g : 0;
  };

  const h2h = T => {
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
  };
  const common = (T, pool) => {
    const opps = pool.filter(o => !T.includes(o) && T.every(t => G2[t * n + o]));
    return opps.length ? T.map(t => vsGroup(t, opps)) : null;
  };
  const tiers = (T, pool) => {
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
  };
  const oppStrength = T => T.map(t => {
    let w = 0, g = 0;
    for (const o of confOpps[t]) { w += CW[o]; g += CW[o] + CL[o]; }
    return g ? w / g : 0;
  });
  const metric = T => T.map(t => r[t]);
  const STEPS = [h2h, common, tiers, oppStrength, metric];

  function pickTop(T, pool) {
    let cur = T;
    restart: for (;;) {
      if (cur.length === 1) return cur[0];
      for (const step of STEPS) {
        const v = step(cur, pool);
        if (!v) continue;
        const best = Math.max(...v), keep = cur.filter((_, k) => v[k] >= best - EPS);
        if (keep.length === 1) return keep[0];
        if (keep.length < cur.length) { cur = keep; continue restart; }
      }
      return cur[0];
    }
  }

  // Orders `members` by conference record, breaking ties against `pool`
  // (the whole conference, even when ranking one division).
  return function rank(members, pool = members) {
    const arr = members.slice().sort((a, b) => pct(b) - pct(a)), out = [];
    for (let i = 0; i < arr.length;) {
      let j = i + 1;
      while (j < arr.length && pct(arr[i]) - pct(arr[j]) < EPS) j++;
      let rest = arr.slice(i, j);
      while (rest.length > 1) {
        const t = pickTop(rest, pool);
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
// outcome of those games. Returns per-team counts over all seasons.
export function simulate(P, useForce, onProgress) {
  const {n, confs, confOf, R, rem, forced, sos, maxConfSize, maxConfG} = P;
  const {N, seed, hfa, gsd, rsd, fcs, lossPen, champBonus, sosW, indSD, forgive, field: F, byes: B, autoBids} = P.params;
  const nc = confs.length, cw1 = maxConfG + 1;
  // Bracket: M slots after the first round (byes plus first-round winners),
  // then log2(M) more rounds. Stage k of `reach` is the round with M / 2^k
  // teams left, so the last stage is the champion.
  const M = B + (F - B) / 2, stages = Math.round(Math.log2(M)) + 1, hosts = (F - B) / 2;
  const out = {N, n, F, B, M, stages, maxConfSize, maxConfG,
    seed: new Float64Array(n * F), host: new Float64Array(n), auto: new Float64Array(n), reach: new Float64Array(n * stages),
    sw: new Float64Array(n), sl: new Float64Array(n), scw: new Float64Array(n), scl: new Float64Array(n),
    top2: new Float64Array(n), ch: new Float64Array(n), cfp: new Float64Array(n), bye: new Float64Array(n), natl: new Float64Array(n),
    place: new Float64Array(n * maxConfSize), cwins: new Float64Array(n * cw1), bids: new Float64Array(nc * (F + 1))};

  const r = new Float64Array(n), W = new Int16Array(n), L = new Int16Array(n), CW = new Int16Array(n), CL = new Int16Array(n);
  const wins = new Int16Array(n * n), champW = new Int16Array(nc), champL = new Int16Array(nc);
  const isChamp = new Uint8Array(n), lostTitle = new Uint8Array(n), inField = new Uint8Array(n), sc = new Float64Array(n);
  const bidCount = new Int16Array(nc), seeds = new Int16Array(F), slot = new Int16Array(F);
  const order = Array.from({length: n}, (_, i) => i), byScore = (a, b) => sc[b] - sc[a];
  const rank = makeRanker({n, G2: P.G2, wins, CW, CL, confOpps: P.confOpps, r});
  const slots = bracketSlots(M), every = Math.max(1, Math.floor(N / 50));
  const play = (x, y, adv, z) => r[x] - r[y] + adv + gsd * z > 0 ? x : y;

  for (let s = 0; s < N; s++) {
    const rng = makeRng(seed, s);
    for (let i = 0; i < n; i++) r[i] = R[i] + rsd * gauss(rng);
    W.set(P.W0); L.set(P.L0); CW.set(P.CW0); CL.set(P.CL0); wins.set(P.wins0);
    champW.fill(-1); champL.fill(-1); isChamp.fill(0); lostTitle.fill(0);

    for (let j = 0; j < rem.length; j++) {
      const g = rem[j], z = gauss(rng), f = useForce ? forced[j] : 0;
      const hw = f ? f === 2 : (g.h >= 0 ? r[g.h] : fcs) - (g.a >= 0 ? r[g.a] : fcs) + (g.neu ? 0 : hfa) + gsd * z > 0;
      const w = hw ? g.h : g.a, l = hw ? g.a : g.h;
      if (w >= 0) W[w]++;
      if (l >= 0) L[l]++;
      if (g.champ >= 0) { champW[g.champ] = w; champL[g.champ] = l; }
      else if (g.conf) { CW[w]++; CL[l]++; wins[w * n + l]++; }
    }

    for (let c = 0; c < nc; c++) {
      const C = confs[c], z = gauss(rng);
      if (C.format === "none" || !C.members.length) continue;
      const ord = rank(C.members);
      for (let p = 0; p < ord.length; p++) out.place[ord[p] * maxConfSize + p]++;
      let champ = -1, lo = -1;
      if (C.champDone) { champ = C.champDone.w; lo = C.champDone.l; }
      else if (C.champGame >= 0) { champ = champW[c]; lo = champL[c]; }
      else if (C.format === "first" || ord.length < 2) champ = ord[0];
      else {
        let x = ord[0], y = ord[1];
        if (C.divs) {
          const wn = C.divs.map(d => rank(d, C.members)[0]).sort((a, b) => ord.indexOf(a) - ord.indexOf(b));
          [x, y] = wn;
        }
        if (y === undefined) champ = x;
        else {
          champ = play(x, y, C.hosted ? hfa : 0, z);
          lo = champ === x ? y : x;
          W[champ]++; L[lo]++;
        }
      }
      if (champ >= 0) { isChamp[champ] = 1; out.ch[champ]++; }
      if (champ >= 0 && lo >= 0) { out.top2[champ]++; out.top2[lo]++; lostTitle[lo] = 1; }
    }

    for (let i = 0; i < n; i++) {
      out.sw[i] += W[i]; out.sl[i] += L[i]; out.scw[i] += CW[i]; out.scl[i] += CL[i];
      if (CW[i] < cw1) out.cwins[i * cw1 + CW[i]]++;
    }

    // Committee: score every team, give the auto bids to the top-scoring
    // conference champions, fill the rest of the field by score, and seed
    // the field in score order.
    for (let i = 0; i < n; i++) {
      const losses = L[i] - (forgive && lostTitle[i] ? 1 : 0);
      sc[i] = r[i] - lossPen * losses + (isChamp[i] ? champBonus : 0) + sosW * sos[i] + indSD * gauss(rng);
    }
    order.sort(byScore);
    inField.fill(0);
    let cnt = 0;
    for (let k = 0; k < n && cnt < autoBids; k++) if (isChamp[order[k]]) { inField[order[k]] = 1; out.auto[order[k]]++; cnt++; }
    for (let k = 0; k < n && cnt < F; k++) if (!inField[order[k]]) { inField[order[k]] = 1; cnt++; }
    for (let k = 0, q = 0; k < n && q < cnt; k++) if (inField[order[k]]) seeds[q++] = order[k];
    bidCount.fill(0);
    for (let q = 0; q < cnt; q++) {
      const i = seeds[q];
      out.cfp[i]++;
      out.seed[i * F + q]++;
      if (q < B) out.bye[i]++;
      else if (q < B + hosts) out.host[i]++;
      bidCount[confOf[i]]++;
    }
    for (let c = 0; c < nc; c++) out.bids[c * (F + 1) + bidCount[c]]++;

    // Bracket: first round at the higher seed, then neutral sites.
    if (cnt === F) {
      for (let q = 0; q < B; q++) slot[q] = seeds[q];
      for (let q = 0; q < (F - B) / 2; q++) slot[B + q] = play(seeds[B + q], seeds[F - 1 - q], hfa, gauss(rng));
      let round = slots.map(k => slot[k - 1]);
      for (let st = 0; ; st++) {
        for (const i of round) out.reach[i * stages + st]++;
        if (round.length === 1) break;
        const next = [];
        for (let q = 0; q < round.length; q += 2) next.push(play(round[q], round[q + 1], 0, gauss(rng)));
        round = next;
      }
      out.natl[round[0]]++;
    }

    if (onProgress && (s + 1) % every === 0) onProgress((s + 1) / N);
  }
  return out;
}
