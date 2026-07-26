# Claude Limits — Stream Deck plugin

Live Claude usage on your Stream Deck: how much of the 5-hour session window is
gone, how much of the week, the Fable model window, your usage-credit spend, and
what today's token usage would have cost at API list price.

![Five Stream Deck keys showing session, week, Fable, credits and cost](docs/keys.png)

*(Values above are synthetic — the plugin renders your own.)*

## What each key shows

| Key | Source | Meaning |
| --- | --- | --- |
| `SESSION` | `five_hour.utilization` | current 5-hour session window |
| `WEEK` | `seven_day.utilization` | current week, all models |
| `FABLE` | `limits[]` entry scoped to the Fable model | current week, Fable only |
| `CREDITS` | `spend` (falls back to `extra_usage`) | usage-credit spend against the monthly cap |
| `COST TODAY` | local transcripts under `~/.claude/projects` | list-price value of today's token usage |

The first four show the percentage as large as it fits, with a bar underneath
carrying the severity colour — green below 50%, amber below 75%, orange below
90%, red above. The limit keys put the time until reset on the bottom line;
`CREDITS` puts `used/cap` there. `COST TODAY` has no percentage, so it shows the
amount and the token count instead.

Pressing any key forces an immediate refresh. Data older than five minutes is
drawn grey with an amber dot.

Type is sized to the key rather than to a fixed scale: the renderer estimates
width glyph by glyph and picks the largest size that still fits, so a long value
shrinks instead of spilling over the edge. Keys are 72×72 physical pixels, so
the layout deliberately carries very little besides the number.

## Requirements

- Stream Deck 6.5 or newer — the plugin runs on the Node 20 runtime that ships
  with the app, so nothing needs to be on your `PATH` for it to work.
- Claude Code, logged in. The plugin reads the OAuth token Claude Code stores;
  it has no login of its own.
- Node.js, only to install the one dependency and run the dev tools.

## Install

```bash
git clone https://github.com/karolpolikarp/claude-limits-streamdeck.git
cd claude-limits-streamdeck
npm install --prefix com.karolp.claudelimits.sdPlugin
```

**Windows**

```powershell
.\deploy.ps1              # copies the plugin and restarts Stream Deck
.\deploy.ps1 -NoRestart   # copy only
```

**macOS** — copy the folder manually and restart Stream Deck:

```bash
cp -R com.karolp.claudelimits.sdPlugin \
  ~/Library/Application\ Support/com.elgato.StreamDeck/Plugins/
```

Then drag **Session (5h)**, **Week (all models)**, **Fable (weekly)**,
**Usage credits**, and **Cost today** from the **Claude** category onto keys. An
action that is only opened in the action list is not running — it has to sit on
a key.

> Developed and tested on Windows. The plugin code itself is platform-neutral,
> but only the Windows install path is exercised.

## How it works

### The four API-backed keys

`GET https://api.anthropic.com/api/oauth/usage`, authenticated with the OAuth
access token from `~/.claude/.credentials.json` — the same endpoint and the same
file Claude Code's own `/usage` command uses. One request a minute serves all
four keys, and it is only made when at least one of them is on a profile.

When the stored token has expired, or the API answers `401`, the plugin refreshes
it against `https://platform.claude.com/v1/oauth/token` and **writes the new
tokens back** to `.credentials.json`, so Claude Code and the plugin stay on the
same credentials. The previous file is kept as `.credentials.json.sdbak`.

A `429` is honoured rather than retried blindly: the plugin reads `retry-after`,
schedules a single retry, and suppresses its own minute timer for that window so
it does not add traffic while rate limited.

### `COST TODAY`

This one never touches the network. It reads the assistant entries in
`~/.claude/projects/**/*.jsonl` whose `timestamp` falls on the current local day
and prices `message.usage` against the per-model rates in `bin/pricing.js`:

| Model | Input $/MTok | Output $/MTok |
| --- | ---: | ---: |
| `claude-fable-5` | 10 | 50 |
| `claude-opus-5`, `claude-opus-4-8`, `claude-opus-4-7` | 5 | 25 |
| `claude-sonnet-5`, `claude-sonnet-4-6` | 3 | 15 |
| `claude-haiku-4-5` | 1 | 5 |

Cache tokens are priced off the input rate: 5-minute write ×1.25, 1-hour write
×2, read ×0.1. `cache_creation.ephemeral_5m_input_tokens` and
`ephemeral_1h_input_tokens` are counted separately. A model with no rate entry
contributes nothing and is counted in `unpricedRequests`.

**The figure is notional.** On a subscription plan nothing is actually billed —
it is what the same traffic would have cost at API list price, which makes it a
usable proxy for how hard the day has been rather than an invoice.

Two details that matter for correctness:

- Transcripts repeat the same assistant message several times under one
  `requestId` as the response grows, so entries are keyed and overwritten rather
  than summed. Summing inflates the total several-fold.
- Files are read incrementally from the last byte offset. The first scan of a
  day reads every file touched today (~17 MB / 220 ms on the author's machine);
  later polls read only the new bytes (~40 ms). State is in memory, so
  restarting Stream Deck triggers one full rescan.

## Credentials and privacy

- The plugin talks to exactly two hosts: `api.anthropic.com` for usage and
  `platform.claude.com` to refresh an expired token. Nothing is sent anywhere
  else, and no telemetry is collected.
- It reads `~/.claude/.credentials.json` and writes it back only when refreshing
  an expired token, atomically, keeping the previous version as `.sdbak`.
- `COST TODAY` reads your transcripts locally. Only token counts and timestamps
  are used; message content is never parsed or transmitted.
- `plugin.log` inside the installed plugin folder records poll results — your
  own percentages and cost. It stays on your machine and is git-ignored here.

## Layout

```
com.karolp.claudelimits.sdPlugin/
  manifest.json          5 actions, Node 20 runtime
  bin/plugin.js          WebSocket wiring, polling, key updates
  bin/usage.js           credentials, token refresh, /api/oauth/usage
  bin/cost.js            incremental transcript scan
  bin/pricing.js         per-model rates and cache multipliers
  bin/render.js          SVG key images
  bin/log.js             rolling log
  imgs/                  static manifest icons
tools/                   dev helpers, see below
deploy.ps1               install into Stream Deck and restart it
```

## Development

Everything can be exercised without touching the hardware:

```bash
node tools/simulate.js         # fake Stream Deck host: spawns the real plugin end to end
node tools/preview.js          # renders the keys to preview/*.svg with live values
node tools/preview.js --demo   # fixed values including stale and error states
node tools/cost-check.js       # today's cost roll-up per model, with scan timings
node tools/test-writeback.js   # credentials write-back safety check on a throwaway copy
node tools/make-icons.js       # regenerates imgs/actions/*-key.svg from the renderer
node tools/make-docs-image.js  # rebuilds the README banner from synthetic values
```

`tools/simulate.js` is the useful one: it opens a WebSocket server, spawns
`bin/plugin.js` with the same arguments Stream Deck passes, sends `willAppear`
for every action, and writes out whatever the plugin draws.

## Troubleshooting

`plugin.log` in the installed plugin folder
(`%APPDATA%\Elgato\StreamDeck\Plugins\com.karolp.claudelimits.sdPlugin\` on
Windows) records every poll and error.

| Key shows | Meaning |
| --- | --- |
| `!` `no login` | `.credentials.json` is missing or has no OAuth block — run `claude` once and log in |
| `!` `auth` | the refresh token was rejected; log in again |
| `!` `slow down` | the usage endpoint returned `429`; the plugin backs off and retries |
| `!` `offline` | network error reaching the API |
| `--` `no data` | no poll has succeeded yet |
| `0%` `unused` | that window exists but has not been touched this period |

A key that never leaves `--` usually means the action is not actually on a key.
Each placed key logs a `willAppear` line, and the poll line names only the
sources it had a key for (`usage`, `cost`).

## Licence

MIT — see [LICENSE](LICENSE).

Not affiliated with Anthropic or Elgato.
