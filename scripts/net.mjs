// Network helpers shared by the update and backtest scripts.
const sleep = ms => new Promise(r => setTimeout(r, ms));

// fetch with retries on network errors, 429 and 5xx; fails fast on 401/403.
export async function fetchRetry(url, init, what) {
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

// CollegeFootballData.com JSON getter using CFBD_API_KEY.
export function cfbdClient() {
  const key = process.env.CFBD_API_KEY;
  if (!key) throw new Error("Set CFBD_API_KEY (free key from https://collegefootballdata.com/key).");
  const base = (process.env.CFBD_BASE_URL || "https://api.collegefootballdata.com").replace(/\/$/, "");
  return async p => (await fetchRetry(base + p, {headers: {Authorization: `Bearer ${key}`, Accept: "application/json"}}, `CFBD ${p}`)).json();
}
