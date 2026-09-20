# Termify

**Your music. Your terminal.**

A keyboard-driven terminal music player that actually streams audio. Search the
Internet Archive's music collections, play what you find, build playlists that
survive restarts — all without leaving the shell, and without an API key.

```
 ♪ termify  ·  search: django reinhardt                          Internet Archive  online  ffplay
──────────────────────────────────────────────────────────────────────────────────────────────────
 DISCOVER              6 tracks · 543 matching items · page 1                      page 1  [ ] page
   Home              1  ℹ Scoped to the Internet Archive music collections.
█  Search            2 ─────────────────────────────────────────────────────────────────────────
   Discover          3  ❯   De Nulle Part (Out Of Nowhere)     Andre Ekyan                    3:03
                            Les Baisers Prisonniers            Micro de la Redoute radio      2:50
 LIBRARY                    I Can't Give You Anything But      Quintette du Hot Club de Fr    3:24
   Queue          12 4      Daphne                             Eddie South/Django Reinhardt   3:02
   Playlists       2 5      Bolero (take 2)                    Quintette du Hot Club de Fra   4:00
   Favorites       2 6
   History         1 7
   Stats             8
──────────────────────────────────────────────────────────────────────────────────────────────────
▀▀▀▀▀▀▀▀▀▀▀▀▀▀  ▶ De Nulle Part (Out Of Nowhere)  ·  Andre Ekyan
▀▀▀▀▀▀▀▀▀▀▀▀▀▀   ⏮  ⏸  ⏭   1:12 ━━━━━━━━━━━━●──────────────────────────────────────────── 3:03
▀▀▀▀▀▀▀▀▀▀▀▀▀▀   ⇄ shuffle  ↻ repeat all  ◉ ━━━━━━──  70%        ▁▂▃▄▄▅▅▅▅▆▆▆▅▃▂▁▁▂▂▂▂▁ decorative
▀▀▀▀▀▀▀▀▀▀▀▀▀▀     next Les Baisers Prisonniers · Micro de la Redoute radio programme
enter play  ·  a queue  ·  A playlist  ·  [ ] page  ·  space play/pause  ·  / search  ·  ? help
```

---

## Contents

- [Quick start](#quick-start)
- [Requirements](#requirements)
- [Music providers](#music-providers)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [Features](#features)
- [Configuration](#configuration)
- [Architecture](#architecture)
- [Development](#development)
- [Troubleshooting](#troubleshooting)
- [Limitations and honesty notes](#limitations-and-honesty-notes)

---

## Quick start

```bash
npm install
npm run doctor     # check your environment (no TTY needed)
npm start          # launch
```

That is the whole setup. The default provider is the Internet Archive, which
needs no credentials, so a fresh clone can search and stream real audio
immediately.

To explore the interface without any network access:

```bash
npm run demo       # built-in sample catalogue, clearly labelled SAMPLE
```

Demo tracks are still genuinely played: each is synthesised into a short tone
file with FFmpeg, so the full audio path (spawn, position tracking,
auto-advance, error handling) is exercised for real rather than simulated.

---

## Requirements

|             |                                                                             |
| ----------- | --------------------------------------------------------------------------- |
| **Node.js** | 22.0 or newer                                                               |
| **OS**      | macOS (primary target); Linux and Windows work where the audio backend does |
| **Audio**   | one of `mpv`, `ffmpeg`/`ffplay`, or `afplay` (macOS built-in)               |

Termify starts without any audio backend, but says so plainly in the header
rather than pretending to play. Install one:

```bash
brew install mpv      # best: true pause, live volume, no re-buffer on seek
brew install ffmpeg   # streams anything FFmpeg can open; also enables artwork
```

`npm run doctor` tells you exactly what is present and what is missing.

---

## Music providers

Termify talks to providers through one interface, so sources can be added
without touching the UI or the playback engine.

### Internet Archive — default, no credentials

Uses the public [`advancedsearch.php` and `metadata`
endpoints](https://archive.org/developers/). Searches are scoped to the
Archive's music collections (`audio_music`, `etree`, `netlabels`, `78rpm`,
`audio_foreign`) so a search for "blues" returns music rather than podcasts.

Search returns _items_ — a concert, an album — and Termify expands each into
its individual tracks, preferring the streamable MP3 derivative over the
lossless original. Because of this, the result count is labelled "matching
items", not "tracks".

Optional tuning in `.env`:

```bash
ARCHIVE_CONTACT=you@example.com   # added to the User-Agent, per archive.org etiquette
ARCHIVE_COLLECTION=etree          # restrict all searches to one collection
```

### Jamendo — free API key

Jamendo publishes Creative Commons music and its v3.0 API returns direct,
full-length audio URLs, so unlike most commercial catalogues it can legitimately
be streamed by a third-party client.

1. Register an application at <https://devportal.jamendo.com/>
2. Copy the **Client ID** into `.env`:

```bash
JAMENDO_CLIENT_ID=your_client_id_here
```

Without it, the provider reports itself unconfigured and Termify hides it
rather than failing at request time.

Two quirks of the live v3.0 API are handled inside the adapter:

- **`fullcount=true` is required** before a response carries
  `results_fullcount`. Without it there is no total to paginate against.
- **Roughly one request in five returns a truncated page** —
  `{"status":"success","results_count":0}` with no results and no
  `results_fullcount` — for a query with thousands of matches. Termify
  retries those (twice, with backoff) and never caches them. A genuine
  no-match is distinguishable because it reports `results_fullcount: 0`, so
  a real empty result is never papered over. If a page is still truncated
  after retries, Termify says "incomplete response" rather than lying about
  having found nothing.

### Local files — optional

Point Termify at a folder and it scans it, reads tags with `music-metadata`,
and plays through the same pipeline as anything else. Set it in Settings, or:

```bash
TERMIFY_MUSIC_DIR=/Users/you/Music
```

Termify never _requires_ a local folder to start.

### Demo — sample data

Deterministic built-in fixtures for demo mode and the test suite. Every row is
flagged `SAMPLE` in the UI and the header shows a `DEMO` badge, so simulated
data can never be mistaken for a live catalogue.

### Not supported, and why

Spotify, Apple Music and SoundCloud are **not** implemented. Their APIs do not
grant full-track audio to a third-party terminal client — Spotify's Web API
returns 30-second previews and requires its own SDK plus a Premium account for
full playback. Rather than ship a broken or policy-violating integration,
Termify omits them. The provider interface has an `externalUrl` field and a
`metadata-only` availability state precisely so such a source could be added
later as metadata discovery with a handoff to the official app.

Termify does not scrape websites, bypass DRM, or download copyrighted music.

---

## Keyboard shortcuts

Press `?` at any time for this list in-app.

### Navigate

| Key                 | Action                                             |
| ------------------- | -------------------------------------------------- |
| `1` – `0`           | jump straight to a section                         |
| `tab` / `shift+tab` | move focus between panes                           |
| `↑` `↓` or `j` `k`  | move the selection                                 |
| `pgup` / `pgdn`     | move a page                                        |
| `g` / `G`           | first / last item                                  |
| `esc`               | close a dialog, clear a filter, leave a text field |
| `q`                 | back, then quit from Home                          |
| `ctrl+c`            | quit immediately                                   |

### Play

| Key       | Action                        |
| --------- | ----------------------------- |
| `enter`   | play the selected track       |
| `space`   | play / pause                  |
| `n` / `b` | next / previous track         |
| `←` / `→` | seek back / forward           |
| `+` / `-` | volume up / down              |
| `s`       | shuffle on / off              |
| `r`       | cycle repeat: off → one → all |
| `.`       | stop                          |
| `T`       | sleep timer                   |

### Organise

| Key       | Action                             |
| --------- | ---------------------------------- |
| `/`       | search (or filter, in a list)      |
| `a`       | add to the end of the queue        |
| `p`       | play next                          |
| `f`       | toggle favourite                   |
| `A`       | add to a playlist                  |
| `n`       | new playlist (Playlists screen)    |
| `R`       | rename playlist / retry a search   |
| `d`       | remove the selected item           |
| `m`       | reorder mode (queue and playlists) |
| `X`       | clear the whole list               |
| `i`       | track details                      |
| `[` / `]` | previous / next page of results    |

While a text field has focus it consumes every printable key, so shortcuts can
never fire mid-word. `esc` or `tab` leaves the field and the shortcuts return.

**Search syntax:** free text, plus optional field prefixes —
`artist: bonobo black sands`, `album:"kind of blue" remaster`.

---

## Features

**Playback** — real audio via mpv/ffplay/afplay. Play, pause, resume, stop,
next, previous, seek, volume, accurate position, automatic advance, buffering
indication, and error recovery that skips a dead stream but stops rather than
spinning if the whole queue is failing.

**Queue** — add, play-next, remove, reorder, clear (with confirmation), skip.
Duplicates are allowed and individually removable. Shuffle reorders only what
has not played yet and avoids replaying the current track; turning it off
restores the original order exactly.

**Playlists** — create, rename, delete, add, remove, reorder, filter, play, and
play a specific track within one. Stored as ordered references to stable
provider ids, never stream URLs, so they survive URL expiry and restarts.
Tracks that stop resolving stay visible, marked `GONE`.

**Favourites and history** — favourites are a set, so duplicates are
structurally impossible. History records one row per _listening session_,
updated in place as the track plays; progress ticks never create new rows, and
a track skipped after a second is not recorded at all.

**Statistics** — total listening time, most-played tracks, top artists and
genres, and a 14-day activity sparkline. Every figure comes from the history
table; when there is no data the screen says so rather than showing zeros.

**Discovery** — provider-published sections (labelled with the provider's own
ordering, e.g. "most downloaded", never an invented "trending"), genre browsing
where the provider supports it, and smart playlists built from your own
library, history and favourites.

**Extras** — sleep timer, synchronised lyrics from local `.lrc` files or
lrclib.net, album artwork as terminal colour blocks, four themes, full ASCII
fallback, and a resume-your-queue-on-restart snapshot.

---

## Configuration

Copy `.env.example` to `.env`. Every value is optional.

| Variable                   | Default          | Purpose                                      |
| -------------------------- | ---------------- | -------------------------------------------- |
| `JAMENDO_CLIENT_ID`        | –                | enables the Jamendo provider                 |
| `ARCHIVE_CONTACT`          | –                | contact string in the archive.org User-Agent |
| `ARCHIVE_COLLECTION`       | –                | restrict archive searches to one collection  |
| `TERMIFY_DEFAULT_PROVIDER` | `archive`        | `archive`, `jamendo`, `local`, `mock`        |
| `TERMIFY_MUSIC_DIR`        | –                | folder for the local provider                |
| `TERMIFY_DATA_DIR`         | platform default | where the database and log live              |
| `TERMIFY_LOG_LEVEL`        | `warn`           | `error`, `warn`, `info`, `debug`             |
| `TERMIFY_AUDIO_BACKEND`    | auto             | force `mpv`, `ffplay`, `afplay` or `null`    |
| `TERMIFY_HTTP_TIMEOUT_MS`  | `12000`          | provider request timeout                     |

Environment variables win over stored settings but are never written back, so
unsetting one restores your saved preference.

Everything else lives in the in-app **Settings** screen (`0`): provider,
results per page, search debounce, default volume, shuffle/repeat, seek step,
audio backend, theme, Unicode, animations, visualiser, artwork, compact layout,
start view, lyrics source, local folder, history recording, cache management
and a full reset.

**Where your data lives**

|         |                                                        |
| ------- | ------------------------------------------------------ |
| macOS   | `~/Library/Application Support/termify`                |
| Linux   | `$XDG_DATA_HOME/termify` (or `~/.local/share/termify`) |
| Windows | `%APPDATA%\termify`                                    |

Credentials are read from the environment only — they are never written to the
database, and the logger redacts them before anything reaches the log file.

---

## Architecture

```
src/
  index.js            entry point, CLI flags, signal handling, single shutdown path
  container.js        composition root: builds and wires every service
  doctor.js           `--doctor` environment report
  config/
    env.js            typed environment projection
    paths.js          platform data/cache directories
    defaults.js       the settings schema — one table drives storage, UI and validation
  core/
    track.js          the internal Track shape every provider normalises into
    errors.js         error taxonomy + the single user-message translation point
    events.js         tiny emitter (a throwing listener cannot stop playback)
    logger.js         file-only logger with secret redaction
    util.js           debounce, seeded shuffle, formatting, small helpers
  db/
    database.js       open, integrity-check, quarantine-and-recover
    migrate.js        transactional migration runner
    migrations/       ordered, append-only schema versions
  providers/
    base.js           the MusicProvider contract
    http.js           timeouts, bounded retry, rate limits, error translation
    archiveProvider.js  jamendoProvider.js  localProvider.js  mockProvider.js
    registry.js       provider selection and graceful fallback
  playback/
    engine.js         state machine: queue + provider + adapter
    queue.js          ordering, shuffle, repeat, snapshot/restore
    levelAnalyser.js  real RMS levels via ffmpeg (opt-in)
    adapters/         mpv, ffplay, afplay, null — one interface
  services/           settings, playlists, favourites, history, stats,
                      search, cache, lyrics, artwork, smart playlists, session
  ui/
    App.js            layout, focus, command dispatch
    keymap.js         per-view key dispatch — a pure function, so it is testable
    actions.js        every user command, in one place
    render.js         view id → component
    theme.js          colours, glyphs, ASCII fallback, capability detection
    components/       Panel, ListView, TrackRow, ProgressBar, Modal, Toast, …
    views/            Home, Search, Discover, Queue, Playlists, Favorites,
                      History, Stats, Lyrics, Settings, Help
```

**The rules this layout enforces**

- Views are pure renderers. They receive data and cursors; they never touch a
  service. That is why every screen can be rendered in a test.
- The playback engine knows nothing about React. It exposes an immutable state
  object and a `change` event.
- Nothing reaches for a singleton. `container.js` constructs everything and
  injects it downward, which is how the tests substitute an in-memory database
  and a silent audio adapter.
- Keyboard dispatch is a pure function of `(key, view, state)`, tested without
  a terminal.

**A note on the UI layer:** it is React (rendered by Ink) written with
`createElement` helpers rather than JSX. That keeps the package runnable
directly from source — `node src/index.js`, no build step, no transpiler —
which matters for a CLI people install and run.

### Audio backends

|            | streams URLs    | seek | live volume | true pause    | real position |
| ---------- | --------------- | ---- | ----------- | ------------- | ------------- |
| **mpv**    | yes             | yes  | yes         | yes           | yes           |
| **ffplay** | yes             | yes  | yes         | restart-based | yes           |
| **afplay** | no (local only) | no   | yes         | restart-based | estimated     |
| **null**   | —               | —    | —           | —             | —             |

mpv is preferred because its JSON IPC socket gives exact control. ffplay has no
runtime control channel, so pause/seek/volume are implemented by stopping the
process and respawning it at the exact position with `-ss`. That is
deterministic and resumes precisely; the cost is a short re-buffer, which is
surfaced as a buffering state rather than hidden.

(`SIGSTOP`/`SIGCONT` was measured first and rejected: ffplay resyncs to its
external clock on resume and skips forward by the paused duration.)

External programs are always launched with an argument array — never a shell
string — so a track title or path can never be interpreted as a command.

---

## Development

```bash
npm start           # run
npm run dev         # run with debug logging
npm run demo        # run against sample data
npm run doctor      # environment report, no TTY needed

npm test            # 228 tests (node:test, no live credentials needed)
npm run test:watch  # re-run on change
npm run lint        # eslint
npm run format      # prettier
npm run verify      # boot the app, render every screen, assert the frames
npm run check       # lint + test + verify
```

The test suite is offline and deterministic: providers are exercised through an
injected `fetch`, audio through a silent adapter with a manual clock, and the
database in memory. Coverage includes queue ordering and shuffle/repeat,
playback state transitions, playlist/favourite/history CRUD, provider response
normalisation from recorded fixtures, search and pagination, HTTP error
handling, migrations and corruption recovery, keyboard navigation, and
rendering every screen at five terminal widths.

### Manual test checklist

Automated tests cannot hear audio. Before releasing, run through this list with
real speakers:

1. `npm run doctor` — reports your backend and providers correctly.
2. `npm start`, press `/`, search for something. Results arrive; typing does
   not fire one request per keystroke.
3. `enter` on a result — audio plays and the progress bar advances in real time.
4. `space` pauses; the position holds. `space` resumes from the same point.
5. `→` `→` seeks forward; audio jumps and the elapsed time matches.
6. `+` `-` changes volume audibly.
7. `n` skips; the next track starts. `b` within 4s goes back a track, after 4s
   restarts the current one.
8. `s` shuffles — the queue preview reorders, the current track keeps playing.
9. `r` three times cycles repeat off → one → all; let a short track finish in
   each mode and confirm the behaviour.
10. `f` favourites; check screen `6`. `A` adds to a playlist; check screen `5`.
11. Quit with `q`, relaunch — playlists, favourites, history and the queue are
    all still there.
12. Resize the terminal narrow and wide while playing — no visual corruption.
13. Turn off Wi-Fi mid-track — a friendly error appears and it skips on.
14. `ctrl+c` — the shell prompt returns clean, with no leftover audio process
    (`pgrep ffplay` finds nothing).

---

## Troubleshooting

**Run `npm run doctor` first.** It reports your Node version, terminal
capabilities, which audio backends exist, which providers are configured, and
whether the database opens.

| Symptom                                              | Cause and fix                                                                                                                                        |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Header says `no audio backend`                       | Nothing playable is installed. `brew install mpv` or `brew install ffmpeg`.                                                                          |
| "This is a full-screen terminal app and needs a TTY" | You piped or redirected output. Run it directly in a terminal, or use `--doctor`.                                                                    |
| Playback starts then stops immediately               | The source is offline or the link expired. Termify skips on automatically; try another track.                                                        |
| Long pause before audio starts                       | Network buffering — the spinner and `buffering` state show this. Large Archive files can take a few seconds.                                         |
| Seeking or pausing re-buffers                        | Expected on the ffplay backend (see [Audio backends](#audio-backends)). Install mpv for instant pause.                                               |
| Boxes and symbols look wrong                         | Your terminal or locale is not UTF-8. Settings → Unicode symbols → off, or set `TERMIFY_ASCII=1`.                                                    |
| Colours look flat                                    | Termify honours `NO_COLOR` and falls back to 16 colours on limited terminals.                                                                        |
| "Terminal too small"                                 | Termify needs about 54×16. Resize; the interface returns on its own.                                                                                 |
| Jamendo missing from Settings                        | `JAMENDO_CLIENT_ID` is not set. Settings shows the reason and the hint.                                                                              |
| Local folder is empty                                | Check the path in Settings, then run Settings → _Rescan local music folder_.                                                                         |
| Search returns nothing useful                        | The Archive is scoped to its music collections. Widen with `ARCHIVE_COLLECTION`, or switch provider.                                                 |
| Database problems                                    | Termify quarantines a corrupt file and starts fresh, keeping a `.corrupt-<timestamp>` backup. To start over deliberately, delete the data directory. |
| Need more detail                                     | `TERMIFY_LOG_LEVEL=debug npm start`, then read `termify.log` in your data directory. Secrets are redacted.                                           |

---

## Limitations and honesty notes

This section exists because it is more useful than a feature list.

- **The visualiser is decorative by default, and labelled as such.** The bars
  react to play/pause and nothing else. Setting _Visualizer_ to `levels` gives
  genuine RMS measurements from ffmpeg's `astats` filter — but only for local
  files, because analysing a network stream would mean a second download that
  drifts out of sync. The label on screen always says which one you are seeing.

- **Lyrics timings are never invented.** Synchronised display requires real
  timestamps, from a local `.lrc` file or from lrclib.net's `syncedLyrics`. When
  only plain text is available it is shown unsynchronised and labelled
  `NOT SYNCHRONISED`.

- **There is no "trending" that the provider did not supply.** Discover shows
  archive.org's own "most downloaded" ordering and Jamendo's own popularity
  ordering, each named after what it actually is.

- **Both online providers are verified end to end against their live
  services** — search, pagination, artist/genre queries, provider-published
  sections, track re-resolution and actual audio playback. Running Jamendo
  against a real key surfaced three adapter bugs (a missing `fullcount`
  parameter, and an intermittent truncated response that wrongly showed "no
  results" and could mark a working track dead); all three are fixed and
  covered by regression tests.

- **archive.org result counts are item counts.** The UI says "matching items"
  rather than implying a track count.

- **Album artwork is colour blocks, not an inline image.** ffmpeg downscales the
  real cover to a tiny bitmap which is painted with half-block characters —
  real pixels, in any 256-colour terminal. Inline-image protocols (iTerm2,
  kitty) are not universal and interact badly with a full-screen redraw. With no
  ffmpeg or no cover, you get a generated monogram card instead of a blank hole.

- **afplay cannot seek.** When it is the only backend available, a seek request
  says so rather than silently doing nothing.

- **Demo tracks are synthesised tones, not music.** That is the point: they
  exercise the real audio path without shipping licensed audio, and they are
  labelled `SAMPLE` everywhere they appear.

- **Connection status is inferred, not probed.** The header's online/offline
  indicator reflects whether the last provider call succeeded. There is no
  reliable connectivity check that does not cost a request.

---

## Licence

MIT. Termify is a client; the music it plays is licensed by whoever published
it. The Internet Archive and Jamendo material reached through the default
providers is openly licensed or public domain, and each track's licence is shown
in its details (`i`).
# music-player-terminal
