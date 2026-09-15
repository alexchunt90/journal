# Journal

[![CI](https://github.com/alexchunt90/journal/actions/workflows/ci.yml/badge.svg)](https://github.com/alexchunt90/journal/actions/workflows/ci.yml)

A local, single-user journal. Its first view, Habits, keeps count of the days
since I last drank or smoked: two streak figures at the top, and under them
a month of days, each split in two, one half per substance. A half is green
until it is clicked, and a click on it says that day broke the streak. More
views will follow; the shell is built for them.

Same shape as `tracker` and `finances` — no dependencies, no build step, all
the logic in the browser — so the three read as one set of tools and can merge
later.

```bash
node server.js
```

Then open http://127.0.0.1:4176. A fresh checkout carries no data at all —
the first run seeds `config.json` and `data/` from [`example/`](example/),
which is made up. It also listens on every interface, so it is reachable from
a phone on the same network — the startup banner prints the addresses.

**There is no authentication.** Anyone who can reach the port can read and
rewrite everything in the app. That is fine on a trusted home network or a
private mesh; it is not fine on shared wifi, and the app should never be
exposed directly to the internet. Set `HOST=127.0.0.1` in `.env` to restrict
it to this machine.

## The idea the app is built on

**A day is clean unless a record says otherwise.** The store holds one record
per day that broke a streak — `{ id: "2026-09-12", alcohol: true,
cannabis: true }` — and nothing for any other day. Clicking the last marked
half of a day back to green deletes the record rather than saving a row of
falses, so `data/days.json` only ever lists the slips. A year of sobriety is
an empty file.

That one rule gives the rest for free:

| Question | Answer |
|---|---|
| Is this half green or red? | Red if a record for the day has that habit `true`; green otherwise, including when there is no record at all |
| What is the streak? | The number of days from the most recent record with that habit marked, up to today. Zero on the day itself, one the day after |
| What if nothing has ever been marked? | The tile shows a dash. "Days without" has no start to count from, and a number the app invented would be a lie either way |
| Do the two habits interact? | No. Each streak counts from its own last mark; a day with only alcohol marked leaves the cannabis streak alone |
| What about a mark in the future? | Ignored by the streak, so it can never go negative. The calendar refuses to make one, but a record can still arrive from a device whose clock is ahead |

The rejected alternative was a record per day holding the day's state, kept
whether or not anything happened. That makes "clean" a value to be stored and
means the calendar has to write a record for every day it shows, or treat a
missing day as clean anyway — at which point the stored falses are noise.

Every date is a `YYYY-MM-DD` string in *local* time, and every comparison is
string comparison. `Date.toISOString()` is never used for a day: it is UTC,
which after 5pm on the Pacific coast is already tomorrow, and a streak
counted from it would gain a day every evening and lose it every morning.
The one place dates become arithmetic — days between two of them — is done in
UTC so a clock change cannot turn a day into 23 or 25 hours.

## The Habits view

Two rows of chrome on a desktop (masthead, tabs) and two blocks.

**The streak tiles** lead because they are why the app is opened. One tile
per habit: the count, its unit, and the date it counts from. They sit in the
view rather than in the masthead's chip slots because the masthead chips are
hidden on a phone, and a phone is where the streak gets checked.

**The calendar** shows one month, Sunday first, with the month's controls
and the key to the halves on one row above it. Each day is two buttons, so
the keyboard reaches them and a screen reader hears "Alcohol, 12 Sep 2026,
pressed". The left half is always the first habit and the right the second,
the same order as the tiles above and the key beside the month. A day after
today is drawn neutral and disabled; a day outside the month is blank, not
the neighbouring month's tail, because a clickable 31 at the top left of
September is exactly the kind of slip a streak tracker should not invite.

The month lives in the URL (`?view=habits&month=2026-08`) so a reload keeps
it, but it is written with `replaceState`: the back button should leave the
page, not walk through every month that was looked at. The next-month button
stops at the current month, since every day past it would be inert.

A click saves and then re-renders the whole grid. The half that had the focus
is found again by day and habit, not by position, and given the focus back.
While a save is in flight the same half refuses a second click: it would
compute its toggle from a list the first save has not yet updated, send a
stale version, and be refused with a 409 that is nobody's fault.

Green is deliberately quiet and red is solid. The mark sits on the exception;
a month of clean days should read as calm, not as a wall of colour.

## Where the state lives

`config.json` and `data/days.json`. Neither is in this repository —
that is what lets it be public.

By default they are files under `STATE_DIR`, which is the project directory.
Set `S3_BUCKET` and they move to a bucket instead, which is what lets the
laptop and the phone be the same app:

```bash
S3_BUCKET=alexchunt-journal
S3_PREFIX=journal
AWS_REGION=us-west-2
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
```

[`deploy/iam-policy.json`](deploy/iam-policy.json) is the whole of what the
credentials need. The `s3:ListBucket` in there looks redundant beside GET and
PUT and is not: without it S3 answers a GET for an absent object with 403,
not 404, so an empty bucket reads as bad credentials and the seed never runs.

Every record carries a `version` that increments on every write, and a client
echoes back the version it loaded. A mismatch is refused with a 409 — another
tab or another device wrote first, and silently discarding their edit is the
one outcome worth refusing. The browser reloads and says so. Underneath, every
write is also conditional on the stored copy not having moved since it was
read (a conditional PUT against the ETag on S3, a hash check under a lock on
files), so two *servers* on one bucket cannot lose each other's edits either.

**Keep the bucket private.** It holds everything in the app and there is no
authentication in front of it, or in front of the app.

## Running on a server

```bash
mkdir -p state
sudo chown -R 1000:1000 state
docker compose up -d --build
sudo tailscale serve --bg 4176
```

The compose file publishes on `127.0.0.1` only and expects `tailscale serve`
or a reverse proxy in front of it. Never `tailscale funnel` — that is the
public internet, and the app has no login. `STATE_DIR` must be a mounted
**directory**: saves write a temp file and rename over the target, and rename
fails against a bind-mounted file.

## Tests

```bash
npm test
```

No install step — the suite runs on `node:test`, which ships with Node. Every
test builds its own state in a temporary directory from `example/`, and the
server tests spawn the server with `S3_BUCKET` explicitly emptied, so running
them can never read or write real state on a machine that is configured
against a bucket.

| | |
|---|---|
| `test/model.test.js` | The rules, with `today` passed in so they are properties over fixed dates: a local day is the local day at 00:30 and 23:30; a streak is zero on the day and one more each day after, for forty days; each habit counts from its own mark; a mark after today is ignored; two toggles of a half are where it started; a toggle never mutates the list; every day of a month appears once in a grid of whole weeks that starts on the right column; a month stepped forward and back is itself, for every month |
| `test/store.test.js` | SigV4 against AWS's published vectors, and the conditional writes: create-once, refuse a stale token, sixteen concurrent writers with nothing clobbered |
| `test/server.test.js` | Seeding an empty store, the 409 on a stale client, twelve simultaneous writes all surviving, and that a request cannot climb out of `public/` |
| `test/env.test.js` | The `.env` reader: the real environment wins, even when set to nothing |

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs it on Node 18, 20
and 22, checks that `config.json` and `data/` are still untracked and that
nothing resembling a credential has been committed, and builds the Docker
image and makes it answer `/api/state` from an empty volume.

## Files

| | |
|---|---|
| `server.js` | The only server: static files, JSON state, the version check |
| `lib/store.js` | State on disk or in a bucket, and the conditional writes |
| `lib/env.js` | The `.env` reader |
| `public/model.js` | The rules: the habit list, local days, streaks, the month grid, what a click produces. No DOM |
| `public/app.js` | Views and wiring: the tiles, the calendar, month routing, save and delete |
| `public/styles.css` | Black grounds, one configurable accent; the tiles and the calendar at the bottom, above the phone rules |
| `config.json` | Title, emoji, accent |
| `data/days.json` | The days that broke a streak |
| `example/` | Stub data, seeded into an empty store on first run |
| `deploy/iam-policy.json` | The least the app's S3 credentials can get away with |

## Adding the next view

`VIEWS` in `public/app.js`, an `<a class="tab">` and a `<main class="frame">`
in `index.html`, a branch in `render()`, and — if it has its own data — a key
in `KEYS` in `lib/store.js`, a file under `example/data/`, and a route in
`server.js`. The tab routing, the save plumbing, the sheet overlay and the
whole stylesheet are already general; the Habits view edits in place and
leaves the sheet for a view that needs a form.

Adding a habit is one line in `HABITS` in `public/model.js`: a third tile and
a third slice of every day follow from it. The key beside the month is the
one place that names the habits by hand.

## Known gaps

- Days before the first record are green, though nothing was being tracked
  then. The calendar has no notion of a start date.
- A slip is two booleans. There is nowhere to say what happened.
- Weeks start on Sunday and the habits are a constant in `model.js`; neither
  is in `config.json`.
- The month cannot be stepped past the current one, so a day cannot be marked
  ahead of time — by design, but it also means a trip across the date line
  has to wait.
