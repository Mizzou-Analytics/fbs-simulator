# FBS season simulator

A Monte Carlo simulator for the college football season, covering every FBS team. For each team it estimates:

- final record and conference record
- conference title game appearance and conference championship
- College Football Playoff selection, first-round bye, and national championship

You can also force the outcome of any remaining game ("what-ifs") and see how the odds shift.

It's a static site (HTML plus JavaScript modules) with no build step. A scheduled GitHub Action keeps `data/season.json` current with schedules, final scores and ratings.

## Running it

Browsers block JavaScript modules on `file://` pages, so serve the folder:

```sh
python3 -m http.server 8000   # then open http://localhost:8000
```

To publish it, enable **GitHub Pages** under *Settings → Pages* and choose *Deploy from a branch*, `main`, root folder. The page reloads data on **Refresh data**. While it's open, it checks for new scores every 10 minutes.

Until `data/season.json` exists, the page falls back to `data/demo.json`. That file has real team names and conferences, but its ratings, schedule and scores are synthetic, and the page shows a banner saying so. Regenerate it with `node scripts/make-demo-data.mjs`.

## Data updates

`scripts/update-data.mjs` pulls everything from **[CollegeFootballData.com](https://collegefootballdata.com)** (CFBD): FBS teams, conferences, divisions, the full regular-season schedule, final scores, and the SP+, FPI, Elo and SRS ratings. **SP+ is the default rating source**; the others can be picked in the page. SP+, FPI and SRS are stored exactly as CFBD publishes them; Elo is converted to points (25 Elo points per point) and centered on the FBS average.

Each run writes `data/season.json`, including a weekly history of ratings that the page uses to show each team's change since last week:

- **Elo** history is rebuilt from the pregame Elo CFBD attaches to every game, so it covers every week from the first run.
- **SP+, FPI and SRS** history builds up from the first run onward: CFBD only serves current values for these, so each daily run saves a snapshot for the current week. The SP+ "Δ wk" column fills in a week after the first run.

### Setup

1. Get a free CFBD API key at <https://collegefootballdata.com/key>.
2. Add it as a repository secret named `CFBD_API_KEY` (*Settings → Secrets and variables → Actions*).
3. Merge to the default branch. Scheduled workflows only run there.
4. Run **Update season data** once from the Actions tab (mode `full`) to publish the first `data/season.json`.

The workflow runs a full refresh (ratings and scores) daily. On game days (Wednesday–Saturday nights and all day Saturday) it runs hourly, refreshing scores only. That totals about 300 CFBD calls a month, within the free tier. It commits only when the data actually changed.

To run it locally:

```sh
CFBD_API_KEY=your-key node scripts/update-data.mjs                 # ratings + scores
CFBD_API_KEY=your-key node scripts/update-data.mjs --scores-only   # scores only
```

### Optional: a ratings spreadsheet

You can add ratings from a spreadsheet you control as an extra source. Set its link as `sheet.url` in `data/sources.json`, or as a repository variable named `RATINGS_SHEET_URL`. For a Google Sheet, share it as "Anyone with the link can view". SP+ stays the default when both are present. The script finds the header row and recognizes three layouts:

| Layout | Example columns |
| --- | --- |
| One rating per team | `Team, Rating` |
| One column per week | `Team, Preseason, Week 1, Week 2, …` |
| One row per team per week | `Week, Team, Rating` |

With weekly columns or rows, the latest week becomes the current rating and every week is saved as history. The script centers ratings on the FBS average. If the values look Elo-like (hundreds of points), it converts them at 25 rating points per point.

When the guesses are wrong, set these fields in `data/sources.json`:

- `teamColumn`, `ratingColumn` and `weekColumn`: column header names.
- `scale`: a multiplier to convert ratings to points.
- `aliases`: maps a sheet's team names to CFBD names, for example `{"Miss St": "Mississippi State"}`.

The workflow log lists any team names it couldn't match.

## The model

**Games.** Each simulated season, every team's rating gets random noise (*rating noise SD*), and the noisy rating is used for all of that team's games. Each remaining game is decided by the rating difference plus home field, plus game noise (*game noise SD*). Non-FBS opponents use the *FCS opp. rating*.

**Ratings sources.** You choose the source in the page: SP+ (the default), FPI, Elo, SRS or an optional ratings sheet (whichever are present), or the **results model**. The results model rebuilds ratings from this season's scores. It starts from the preseason ratings, weighted as *prior weight* games, and caps blowout margins at *margin cap*. You can also override any team's rating in the Teams table.

**Conference standings.** Standings are ordered by conference winning percentage. Ties are broken with a procedure modeled on the SEC's rules, applied to every conference:

1. Head-to-head among the tied teams, counting games already played.
2. Record against common conference opponents.
3. Record against the highest-placed common opponent, working down the standings.
4. Opponents' combined conference winning percentage.
5. A ratings metric.

Multi-team ties start over at step 1 whenever a team is separated. Each conference's real tiebreaker rules differ in the details.

**Conference title games.** By default the top two teams meet. Conferences with divisions (currently the Sun Belt) match the division winners instead. The AAC, Mountain West, Sun Belt, Conference USA and Pac-12 host the game at the higher seed; the rest play at a neutral site. Once the real matchup is on the schedule, the simulator plays that game, and you can force it like any other.

**Playoff.** Every team gets a committee score. By default it's based on **strength of record** (SOR):

> rating + SOR weight × SOR + champion bonus (conference champions) + noise

SOR is a team's wins minus the wins a bubble team would expect against the same schedule, at the same sites, title game included. The bubble team is the team with the field-size-th best rating (the 12th best in a 12-team field). A loss to a top team costs little, because a bubble team would usually lose that game too; a loss to a weak team costs nearly a full win. With the default weight of 6, one win above the bubble team is worth 6 points of committee score.

The older **flat loss penalty** model is still available under Settings:

> rating − loss penalty × losses + SoS weight × average opponent rating + champion bonus + noise

It charges every loss the same regardless of opponent. That's why it undercounts deep conferences such as the SEC, whose contenders take losses from each other: with this season's data it gives the SEC five or more bids in about 6% of seasons, against about 19% with SOR.

The top *auto bids* conference champions by score get in. The highest remaining scores fill the rest of the field, and seeding follows score order. The top *byes* seeds skip the first round, which is played at the higher seed; later rounds are neutral. The field size, byes and auto bids can be changed (for example to 16 teams with no byes). The default is the 12-team, 5 + 7 format.

**National view.** The page projects the full playoff field: the teams most likely to make it, seeded by average finish and laid out as a bracket with byes and first-round hosts. Below it, every contender's odds of making the field, getting an auto bid, a bye or a home first-round game, each seed, and reaching each round.

**What-ifs.** Each simulated season draws its random numbers from its own seeded generator, in a fixed order whether or not a game is forced. So the run with your what-ifs and the baseline run without them see identical luck everywhere else. The colored +/− numbers show only what your what-ifs changed. Games are keyed by their schedule id, so rematches are separate what-ifs.

## Files

| Path | What it is |
| --- | --- |
| `index.html`, `js/app.js` | The page |
| `js/model.js` | Season and settings validation, ratings, simulator input |
| `js/sim.js` | Simulation, tiebreakers, playoff bracket |
| `js/worker.js` | Runs the simulation in a Web Worker so the page stays responsive |
| `scripts/update-data.mjs`, `scripts/sources.mjs` | Data pipeline (CFBD, plus an optional ratings sheet) |
| `scripts/make-demo-data.mjs` | Generates `data/demo.json` |
| `data/sources.json` | Which CFBD ratings to pull, and optional ratings-sheet settings |
| `test/` | `node --test` (Node 20+) |

**Export** saves your settings, overrides and what-ifs. **Import** accepts one of those exports or a full season file in the same format as `data/season.json`. An export from the old SEC-only version brings over its model settings.
