"""Turns CFBD play-by-play into one row per run or pass call, with the
situation the call was made in.

A "call" is what the offense tried to do, as far as the play-by-play can tell:
sacks and scrambles count as passes, and kneels, spikes, penalties, special
teams and garbage time are dropped.
"""
import re

import numpy as np
import pandas as pd

RUSH_TYPES = {"Rush", "Rushing Touchdown"}
PASS_TYPES = {
    "Pass", "Pass Reception", "Pass Completion", "Pass Incompletion", "Passing Touchdown",
    "Sack", "Interception", "Pass Interception", "Pass Interception Return",
    "Interception Return Touchdown",
}
# Plays CFBD files by their outcome; the description says what the call was.
BY_TEXT_TYPES = {"Fumble", "Fumble Recovery (Own)", "Fumble Recovery (Opponent)", "Fumble Return Touchdown", "Safety"}

PASS_TEXT = re.compile(r"\bpass\b|\bsacked\b|\bscrambles?\b", re.I)
RUSH_TEXT = re.compile(r"\b(run|rush|rushed)\b", re.I)
SCRAMBLE = re.compile(r"\bscrambles?\b", re.I)
SKIP_TEXT = re.compile(r"\bkneels?\b|\bkneel down\b|\bspikes?\b|\bspiked\b", re.I)

# CFBD's garbage-time rule: the score margin, by quarter, past which a game is
# treated as decided.
GARBAGE_MARGIN = {1: 43, 2: 37, 3: 27, 4: 21}


def _get(p, *names, default=None):
    for n in names:
        if n in p and p[n] is not None:
            return p[n]
    return default


def classify(play_type, text):
    """'pass', 'rush' or None (not a run or pass call, or can't tell)."""
    text = text or ""
    if SKIP_TEXT.search(text):
        return None
    if play_type in RUSH_TYPES:
        return "pass" if SCRAMBLE.search(text) else "rush"
    if play_type in PASS_TYPES:
        return "pass"
    if play_type in BY_TEXT_TYPES:
        if PASS_TEXT.search(text):
            return "pass"
        if RUSH_TEXT.search(text):
            return "rush"
    return None


def is_garbage(period, margin):
    limit = GARBAGE_MARGIN.get(period)
    return limit is not None and abs(margin) > limit


def normalize(raw):
    """CFBD play dicts (camelCase or snake_case) -> a flat DataFrame."""
    rows = []
    for p in raw:
        clock = _get(p, "clock", default={}) or {}
        rows.append({
            "play_id": str(_get(p, "id", default="")),
            "game_id": str(_get(p, "gameId", "game_id", default="")),
            "week": _get(p, "week"),
            "drive_id": str(_get(p, "driveId", "drive_id", default="")),
            "drive_number": _get(p, "driveNumber", "drive_number", default=0),
            "play_number": _get(p, "playNumber", "play_number", default=0),
            "offense": _get(p, "offense"),
            "defense": _get(p, "defense"),
            "home": _get(p, "home"),
            "offense_score": _get(p, "offenseScore", "offense_score", default=0),
            "defense_score": _get(p, "defenseScore", "defense_score", default=0),
            "period": _get(p, "period", default=0),
            "clock_min": _get(clock, "minutes", default=np.nan),
            "clock_sec": _get(clock, "seconds", default=0),
            "off_timeouts": _get(p, "offenseTimeouts", "offense_timeouts", default=np.nan),
            "def_timeouts": _get(p, "defenseTimeouts", "defense_timeouts", default=np.nan),
            "yards_to_goal": _get(p, "yardsToGoal", "yards_to_goal", default=np.nan),
            "down": _get(p, "down", default=0),
            "distance": _get(p, "distance", default=np.nan),
            "yards_gained": _get(p, "yardsGained", "yards_gained", default=0),
            "play_type": _get(p, "playType", "play_type", default=""),
            "text": _get(p, "playText", "play_text", default=""),
            "epa": _get(p, "ppa", default=np.nan),
        })
    return pd.DataFrame(rows)


def prepare(raw, fbs_teams=None):
    """One row per run/pass call by an FBS offense, in game order, with the
    situation and the previous call on the same drive."""
    df = normalize(raw) if not isinstance(raw, pd.DataFrame) else raw.copy()
    df["call"] = [classify(t, x) for t, x in zip(df["play_type"], df["text"])]
    for c in ["week", "drive_number", "play_number", "offense_score", "defense_score", "period", "down",
              "distance", "yards_to_goal", "yards_gained", "clock_min", "clock_sec", "off_timeouts",
              "def_timeouts", "epa"]:
        df[c] = pd.to_numeric(df[c], errors="coerce")
    df = df.sort_values(["game_id", "drive_number", "play_number", "play_id"], kind="stable")

    # The previous run/pass call on the same drive, before any rows are
    # dropped, so a dropped garbage-time play still counts as "previous".
    calls = df[df["call"].notna()].copy()
    g = calls.groupby(["game_id", "drive_id"], sort=False)
    calls["prev_call"] = g["call"].shift(1)
    calls["prev_yards"] = g["yards_gained"].shift(1)
    calls["prev_incomplete"] = g["play_type"].shift(1).eq("Pass Incompletion").astype(float)
    calls["drive_play"] = g.cumcount()

    calls = calls[calls["down"].between(1, 4) & (calls["distance"] > 0)]
    calls["margin"] = calls["offense_score"] - calls["defense_score"]
    calls = calls[~np.array([is_garbage(p, m) for p, m in zip(calls["period"], calls["margin"])], dtype=bool)]
    if fbs_teams is not None:
        calls = calls[calls["offense"].isin(set(fbs_teams))]

    secs = calls["clock_min"] * 60 + calls["clock_sec"]
    reg = calls["period"].between(1, 4)
    calls["secs_half"] = np.where(reg, secs + np.where(calls["period"].isin([1, 3]), 900, 0), 0)
    calls["secs_game"] = np.where(reg, secs + (4 - calls["period"]).clip(lower=0) * 900, 0)
    calls["overtime"] = (calls["period"] > 4).astype(float)
    calls["two_minute"] = (reg & (calls["secs_half"] <= 120)).astype(float)
    calls["is_home"] = (calls["offense"] == calls["home"]).astype(float)
    calls["prev_type"] = calls["prev_call"].map({"rush": 1.0, "pass": 2.0}).fillna(0.0)
    calls["prev_yards"] = calls["prev_yards"].clip(-15, 40)
    calls["pass"] = (calls["call"] == "pass").astype(int)
    keep = ["play_id", "game_id", "week", "drive_id", "offense", "defense", "period", "down", "distance",
            "yards_to_goal", "margin", "secs_half", "secs_game", "overtime", "two_minute", "off_timeouts",
            "def_timeouts", "is_home", "prev_type", "prev_yards", "prev_incomplete", "drive_play",
            "pass", "epa", "play_type", "text"]
    return calls[keep].reset_index(drop=True)


def assign_playcallers(df, callers, season):
    """Adds an 'entity' column: the team, or "Team (Caller)" for teams with a
    listed play-calling change. Each listed row starts a stint at its week and
    period; a team's plays before its first row go to that first row."""
    df = df.copy()
    df["entity"] = df["offense"]
    if callers is None or not len(callers):
        return df
    rows = callers[callers["season"] == season].sort_values(["team", "week", "period"])
    for team, stints in rows.groupby("team"):
        mask = df["offense"] == team
        if not mask.any():
            continue
        key = df.loc[mask, "week"] * 10 + df.loc[mask, "period"].clip(upper=9)
        label = pd.Series(f"{team} ({stints.iloc[0]['caller']})", index=key.index)
        for _, s in stints.iterrows():
            label[key >= s["week"] * 10 + s["period"]] = f"{team} ({s['caller']})"
        df.loc[mask, "entity"] = label
    return df


def diagnostics(raw):
    """Counts by CFBD play type and how each was classified, to check the
    classification against a real season."""
    df = normalize(raw) if not isinstance(raw, pd.DataFrame) else raw
    call = [classify(t, x) for t, x in zip(df["play_type"], df["text"])]
    out = pd.DataFrame({"play_type": df["play_type"], "call": pd.Series(call).fillna("dropped")})
    table = out.groupby(["play_type", "call"]).size().unstack(fill_value=0)
    scrambles = int(sum(1 for t, x in zip(df["play_type"], df["text"]) if t in RUSH_TYPES and SCRAMBLE.search(x or "")))
    return table.sort_values(table.columns.tolist(), ascending=False), scrambles
