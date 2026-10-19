"""Downloads a season's play-by-play and FBS team list from CollegeFootballData."""
import gzip
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request

BASE = os.environ.get("CFBD_BASE_URL", "https://api.collegefootballdata.com").rstrip("/")


def get(path, params, key, tries=4):
    url = f"{BASE}{path}?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {key}", "Accept": "application/json"})
    for attempt in range(1, tries + 1):
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code in (401, 403):
                raise SystemExit(f"CFBD {path}: access denied (HTTP {e.code}). Check CFBD_API_KEY.")
            if (e.code < 500 and e.code != 429) or attempt == tries:
                raise
        except urllib.error.URLError:
            if attempt == tries:
                raise
        time.sleep(2 ** attempt)


def season(year, key, weeks=range(1, 17), log=print):
    """Every regular-season and postseason play, each tagged with its week.
    About 18 API calls."""
    plays = []
    for kind, wks in (("regular", weeks), ("postseason", [1])):
        for w in wks:
            got = get("/plays", {"year": year, "week": w, "seasonType": kind}, key)
            for p in got:
                p["week"] = w if kind == "regular" else 99
            plays.extend(got)
            log(f"  {kind} week {w}: {len(got)} plays")
    teams = [t.get("school") for t in get("/teams/fbs", {"year": year}, key)]
    return {"season": year, "teams": teams, "plays": plays}


def save(data, path):
    with gzip.open(path, "wt", encoding="utf-8") as f:
        json.dump(data, f)


def load(path):
    with gzip.open(path, "rt", encoding="utf-8") as f:
        return json.load(f)
