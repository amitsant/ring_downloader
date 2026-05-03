# ring_downloader

Download Ring cloud recordings to disk with sensible folders, optional QuickTime-friendly transcoding, and logging.

## Requirements

- **Node.js** 18+ (20 LTS recommended; `ring-client-api` may warn on Node 22)
- **ffmpeg** / **ffprobe** — `brew install ffmpeg` (used for validation + H.264 transcoding)
- **Ring refresh token** — see [Refresh Tokens](https://github.com/dgreif/ring/wiki/Refresh-Tokens) (`npx -p ring-client-api ring-auth-cli`)

## Setup

```bash
cd ring-tools/ring-download
npm install
export RING_TOKEN="$(cat ~/.ring-token)"   # or paste token once per shell
```

Default output directory: `/Volumes/LaCie/Ring_Videos` (override with `RING_OUTPUT_DIR`).

**Transcoding:** By default every clip is re-encoded to **H.264 + AAC** for QuickTime (`RING_TRANSCODE` defaults to `always`). Ring often serves streams that **ffprobe** reports as H.264 but QuickTime still plays as audio-only; `auto` skips re-encode in those cases and is faster but less reliable. Use `RING_TRANSCODE=auto` only if you accept that risk.

## Commands

| Command | Purpose |
|--------|---------|
| `npm run download` | Download using env / defaults (see `download.js` header) |
| `npm run download:full` | Fixed range `2026-03-03` … `2026-05-02` (uses default full QuickTime transcode) |
| `npm run reencode` | Re-run ffmpeg on existing `.mp4` only (`RING_REENCODE_ONLY=1`) — no Ring API |

Logs append to `{RING_OUTPUT_DIR}/ring_download.log` unless `RING_NO_LOG=1` or `RING_LOG_FILE` is set.

## Layout

```
{RING_OUTPUT_DIR}/{YYYY-MM-DD}/{device name}/{ding_id}.mp4
```

## Optional: Playwright UI fallback

`ring_automation/` contains a browser-based scraper if API download fails. Install with `npm install` in that folder (includes Playwright).

## Repository layout

- **`ring-tools/ring-download/`** — main CLI (`download.js`)
- **`ring_automation/`** — legacy Playwright workaround

---

Repository: [github.com/amitsant/ring_downloader](https://github.com/amitsant/ring_downloader)
