/**
 * Bulk-download Ring cloud recordings via ring-client-api.
 *
 * Requires: RING_TOKEN (refresh token from Ring; update when it expires.)
 *
 * Optional env:
 *   RING_OUTPUT_DIR  — output folder (default: /Volumes/LaCie/Ring_Videos)
 *   RING_START       — YYYY-MM-DD (default: 2026-02-15)
 *   RING_END         — YYYY-MM-DD inclusive (default: 2026-05-02)
 *   RING_SKIP_DOORBELL — if "1" or "true", skip devices whose name contains "doorbell"
 *   RING_FORCE         — if "1" or "true", re-download even when the .mp4 already exists
 *   RING_ALLOW_SHARE_PLAY — if "1", allow share/play fallback (often audio-only; default off)
 *   RING_TRANSCODE      — always (default): re-encode every clip for QuickTime (H.264/AAC); slower but reliable
 *                         set to "auto" to skip when already H.264+yuv420p (faster; QuickTime may still fail on some Ring files)
 *                         "0" disables transcoding
 *   RING_FFMPEG / RING_FFPROBE — paths if not on PATH (default: ffmpeg, ffprobe)
 *   RING_ALLOW_AUDIO_ONLY — if "1", keep clips that have no video track (default: discard & try next URL)
 *
 * Files are stored as: {RING_OUTPUT_DIR}/{YYYY-MM-DD}/{Device name}/{ding_id}.mp4
 * Flow: for each calendar day in range, each device is processed for that day only (then next day).
 *
 * Run: cd ring-tools/ring-download && RING_TOKEN=... node download.js
 *
 * Alternative (browser scraping): ../../ring_automation/ring_automation.js — use only if API download fails.
 *
 *   RING_LOG_FILE — optional explicit log path. If unset, logs append to {RING_OUTPUT_DIR}/ring_download.log
 *   RING_NO_LOG       — if "1", disable file logging entirely
 *
 *   RING_REENCODE_ONLY — if "1": no Ring download; run ffmpeg QuickTime pass on existing MP4s under RING_OUTPUT_DIR.
 *                         Optional RING_REENCODE_SUBDIR=2026-03-04 — single day folder only (overrides range).
 *                         Optional RING_REENCODE_START / RING_REENCODE_END (YYYY-MM-DD, inclusive) — only first-level
 *                         date folders under RING_OUTPUT_DIR in that range (omit START for “from earliest”, omit END for “through latest”).
 *                         If none of these are set, the entire tree under RING_OUTPUT_DIR is processed (no token needed).
 */

import { RingApi } from 'ring-client-api'
import { execFile } from 'node:child_process'
import fs from 'fs'
import path from 'path'
import { once } from 'node:events'
import { pipeline } from 'stream/promises'
import util, { promisify } from 'node:util'
import got from 'got'

const execFileAsync = promisify(execFile)

let warnedNoFfprobe = false

/** When set, full console output + JSON summary are appended here for troubleshooting. */
let ringLogStream = null

const reencodeOnly = /^1|true|yes$/i.test(process.env.RING_REENCODE_ONLY ?? '')

const refreshToken = process.env.RING_TOKEN ?? ''
if (!reencodeOnly && !refreshToken) {
  console.error('Missing RING_TOKEN. Export your Ring refresh token and retry.')
  process.exit(1)
}

const outputDir =
  process.env.RING_OUTPUT_DIR ?? '/Volumes/LaCie/Ring_Videos'
const skipDoorbell = /^1|true|yes$/i.test(process.env.RING_SKIP_DOORBELL ?? 'true')
const forceRedownload = /^1|true|yes$/i.test(process.env.RING_FORCE ?? '')
const allowSharePlay = /^1|true|yes$/i.test(
  process.env.RING_ALLOW_SHARE_PLAY ?? '',
)
const allowAudioOnly = /^1|true|yes$/i.test(
  process.env.RING_ALLOW_AUDIO_ONLY ?? '',
)

const ffmpegBin = process.env.RING_FFMPEG ?? 'ffmpeg'
const ffprobeBin = process.env.RING_FFPROBE ?? 'ffprobe'

/** auto | always | off — Default always: Ring often labels files as H.264 but QuickTime still needs a full remux. */
function transcodeMode() {
  const raw = (process.env.RING_TRANSCODE ?? 'always').trim().toLowerCase()
  if (/^0|false|no|off$/.test(raw)) return 'off'
  if (/^1|true|yes|always|force$/.test(raw)) return 'always'
  return 'auto'
}

/** Safe folder name from Ring device name (e.g. "Hallway", "Front Door"). */
function sanitizeDeviceFolder(name) {
  const cleaned = String(name)
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned || 'Unknown_device'
}

/** YYYY-MM-DD in local timezone (Ring timestamps are UTC ms; folders match your calendar day). */
function formatLocalDateFolder(ms) {
  const d = new Date(ms)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function parseLocalDay(iso, endOfDay) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso).trim())
  if (!m) return new Date(iso)
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  const dt = new Date(y, mo - 1, d)
  if (endOfDay) dt.setHours(23, 59, 59, 999)
  return dt
}

const startDate = parseLocalDay(process.env.RING_START ?? '2026-02-15', false)
const endDate = parseLocalDay(process.env.RING_END ?? '2026-05-02', true)

const startMs = startDate.getTime()
const endMs = endDate.getTime()

if (
  !reencodeOnly &&
  (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs > endMs)
) {
  console.error('Invalid date range.')
  process.exit(1)
}

const ringApi = reencodeOnly ? null : new RingApi({ refreshToken })
fs.mkdirSync(outputDir, { recursive: true })

/** Default: {outputDir}/ring_download.log unless RING_NO_LOG=1 or RING_LOG_FILE overrides. */
function resolveRingLogPath() {
  if (/^1|true|yes$/i.test(process.env.RING_NO_LOG ?? '')) {
    return ''
  }
  const explicit = process.env.RING_LOG_FILE
  if (typeof explicit === 'string' && explicit.trim() !== '') {
    return path.resolve(explicit.trim())
  }
  return path.join(outputDir, 'ring_download.log')
}

function attachRingLogFile(absPath) {
  fs.mkdirSync(path.dirname(absPath), { recursive: true })
  ringLogStream = fs.createWriteStream(absPath, { flags: 'a' })
  const sep = `${'\n'}${'='.repeat(72)}\n`
  ringLogStream.write(sep)
  ringLogStream.write(`ring-download — ${new Date().toISOString()}\n`)
  ringLogStream.write(`platform: ${process.platform}  node ${process.version}\n`)
  ringLogStream.write(`cwd: ${process.cwd()}\n`)
  ringLogStream.write(`RING_OUTPUT_DIR: ${outputDir}\n`)
  ringLogStream.write(
    `RING_START … RING_END: ${process.env.RING_START ?? '(default)'} … ${process.env.RING_END ?? '(default)'}\n`,
  )
  ringLogStream.write(
    `RING_FORCE=${process.env.RING_FORCE ?? ''} RING_TRANSCODE=${process.env.RING_TRANSCODE ?? ''} RING_SKIP_DOORBELL=${process.env.RING_SKIP_DOORBELL ?? ''}\n`,
  )
  ringLogStream.write(
    `RING_ALLOW_SHARE_PLAY=${process.env.RING_ALLOW_SHARE_PLAY ?? ''} RING_ALLOW_AUDIO_ONLY=${process.env.RING_ALLOW_AUDIO_ONLY ?? ''}\n`,
  )
  ringLogStream.write(
    `RING_REENCODE_ONLY=${process.env.RING_REENCODE_ONLY ?? ''} RING_REENCODE_SUBDIR=${process.env.RING_REENCODE_SUBDIR ?? ''}\n`,
  )
  ringLogStream.write(`RING_TOKEN: ${refreshToken ? '(set — value not logged)' : '(missing)'}\n`)
  ringLogStream.write(`${sep}\n`)

  const origLog = console.log.bind(console)
  const origWarn = console.warn.bind(console)
  const origErr = console.error.bind(console)
  const stamp = () => new Date().toISOString()
  const fmt = (args) =>
    args
      .map((a) =>
        typeof a === 'object' && a !== null && !(a instanceof Error)
          ? util.inspect(a, { depth: 8 })
          : a instanceof Error
            ? `${a.stack ?? a.message}`
            : String(a),
      )
      .join(' ')

  console.log = (...args) => {
    origLog(...args)
    ringLogStream.write(`[${stamp()}] ${fmt(args)}\n`)
  }
  console.warn = (...args) => {
    origWarn(...args)
    ringLogStream.write(`[${stamp()}] WARN ${fmt(args)}\n`)
  }
  console.error = (...args) => {
    origErr(...args)
    ringLogStream.write(`[${stamp()}] ERR ${fmt(args)}\n`)
  }

  process.once('exit', () => {
    try {
      ringLogStream?.end()
    } catch {
      /* ignore */
    }
  })

  console.log(`📝 Log file: ${absPath}`)
}

const ringLogPath = resolveRingLogPath()
if (ringLogPath) {
  attachRingLogFile(ringLogPath)
}

/**
 * Ring does not serve the MP4 as a stream from /dings/{id}/recording (that returns 404
 * "Url not found"). The mobile client uses dings/{id}/recording?disable_redirect=true
 * to get JSON { url } — exposed as camera.getRecordingUrl() — then downloads that URL.
 *
 * Rejects audio/* Content-Type (AAC/M4A "share/play" and similar) so we try another source.
 */
async function streamUrlToFile(url, filePath) {
  if (!url || typeof url !== 'string') {
    throw new Error('No download URL from Ring')
  }

  const stream = got.stream(url, {
    followRedirect: true,
    timeout: { request: 300_000 },
    http2: false,
    headers: {
      Accept: 'video/mp4, video/*, application/octet-stream, */*',
      'User-Agent': 'android:com.ringapp',
    },
  })

  let res
  try {
    ;[res] = await once(stream, 'response')
  } catch (e) {
    throw new Error(`Download failed: ${e.message ?? e}`)
  }

  const ct = String(res.headers['content-type'] || '').toLowerCase()
  if (ct.startsWith('audio/')) {
    stream.destroy()
    throw new Error(`skipped audio (${ct})`)
  }

  try {
    await pipeline(stream, fs.createWriteStream(filePath))
  } catch (e) {
    try {
      fs.unlinkSync(filePath)
    } catch {
      /* ignore */
    }
    throw e
  }
}

async function ffprobeStreams(filePath) {
  const { stdout } = await execFileAsync(ffprobeBin, [
    '-v',
    'error',
    '-show_streams',
    '-print_format',
    'json',
    filePath,
  ])
  return JSON.parse(stdout)
}

/**
 * True “video” for Ring: not cover art, not a 1×1 placeholder, has real resolution.
 * (ffprobe often reports album-art / thumbnail as codec_type video.)
 */
function isRealPlayableVideoStream(s) {
  if (!s || s.codec_type !== 'video') return false
  const disp = s.disposition || {}
  if (disp.attached_pic === 1) return false
  const w = Number(s.width) || 0
  const h = Number(s.height) || 0
  if (w < 64 || h < 64) return false

  const dur = parseFloat(s.duration)
  if (Number.isFinite(dur) && dur > 0 && dur < 0.1) return false

  const codec = String(s.codec_name ?? '').toLowerCase()
  if (
    (codec === 'png' || codec === 'mjpeg' || codec === 'gif') &&
    (w < 160 || h < 160)
  ) {
    return false
  }

  return true
}

/** Ring sometimes returns audio-only MP4s with non-audio Content-Type — probe real streams. */
async function assertHasVideoTrack(filePath) {
  if (allowAudioOnly) return

  try {
    await execFileAsync(ffprobeBin, ['-version'], { timeout: 3000 })
  } catch {
    if (!warnedNoFfprobe) {
      warnedNoFfprobe = true
      console.warn(
        '⚠️ ffprobe not found — cannot verify video vs audio-only. Install: brew install ffmpeg',
      )
    }
    return
  }

  let probe
  try {
    probe = await ffprobeStreams(filePath)
  } catch (e) {
    try {
      fs.unlinkSync(filePath)
    } catch {
      /* ignore */
    }
    throw new Error(`ffprobe failed: ${e.message ?? e}`)
  }

  const hasRealVideo = (probe.streams ?? []).some(isRealPlayableVideoStream)
  if (hasRealVideo) return

  try {
    fs.unlinkSync(filePath)
  } catch {
    /* ignore */
  }
  throw new Error(
    'no usable video track (audio-only or thumbnail-only); trying next source',
  )
}

/** Re-encode to H.264/AAC MP4 that QuickTime Player accepts (Ring often serves HEVC or fragmented MP4). */
async function transcodeClipForQuickTime(inputPath) {
  const probe = await ffprobeStreams(inputPath)
  const streams = probe.streams ?? []
  const videoStream = streams.find(isRealPlayableVideoStream)
  const audioStream = streams.find((s) => s.codec_type === 'audio')

  if (!videoStream) {
    throw new Error('transcode: no real video stream to map')
  }

  const vi =
    videoStream.index ?? videoStream.stream_index ?? streams.indexOf(videoStream)
  if (typeof vi !== 'number' || vi < 0) {
    throw new Error('transcode: invalid video stream index')
  }
  const ai = audioStream
    ? (audioStream.index ??
      audioStream.stream_index ??
      streams.indexOf(audioStream))
    : undefined
  const tmp = `${inputPath}.qt.tmp.mp4`

  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-i',
    inputPath,
    '-map',
    `0:${vi}`,
  ]
  if (typeof ai === 'number' && ai >= 0) {
    args.push('-map', `0:${ai}`)
  }
  args.push(
    '-c:v',
    'libx264',
    '-profile:v',
    'high',
    '-level',
    '4.1',
    '-pix_fmt',
    'yuv420p',
    '-crf',
    '20',
    '-preset',
    'fast',
    '-c:a',
    'aac',
    '-b:a',
    '160k',
    '-movflags',
    '+faststart',
    '-brand',
    'isom',
    tmp,
  )

  await execFileAsync(ffmpegBin, args, { maxBuffer: 20 * 1024 * 1024 })
  fs.unlinkSync(inputPath)
  fs.renameSync(tmp, inputPath)
}

async function ensureQuickTimeMp4(filePath) {
  const mode = transcodeMode()
  if (mode === 'off') return

  try {
    await execFileAsync(ffmpegBin, ['-hide_banner', '-version'], {
      timeout: 5000,
    })
  } catch {
    return
  }

  let probe
  try {
    probe = await ffprobeStreams(filePath)
  } catch {
    return
  }

  const streams = probe.streams ?? []
  const video = streams.find(isRealPlayableVideoStream)
  const audio = streams.find((s) => s.codec_type === 'audio')

  if (!video) {
    if (audio) {
      console.warn(
        `⚠️ ${path.basename(filePath)}: no real video track (audio-only or thumbnail-only).`,
      )
    }
    return
  }

  const codec = String(video.codec_name ?? '').toLowerCase()
  const pix = String(video.pix_fmt ?? '').toLowerCase()
  const looksQuickTimeFriendly =
    codec === 'h264' &&
    (pix === 'yuv420p' || pix === 'yuvj420p')

  if (mode === 'auto' && looksQuickTimeFriendly) {
    return
  }

  try {
    await transcodeClipForQuickTime(filePath)
  } catch (e) {
    console.warn(
      `⚠️ ffmpeg transcode failed (${path.basename(filePath)}):`,
      e.message ?? e,
    )
  }
}

async function downloadRecordingClip(cam, dingIdStr, filePath, row) {
  const errors = []

  const done = async () => {
    await ensureQuickTimeMp4(filePath)
  }

  // 1) Full MP4 from Ring's transcoded "recording" endpoint (primary video clip)
  try {
    const url = await cam.getRecordingUrl(dingIdStr, { transcoded: true })
    await streamUrlToFile(url, filePath)
    await assertHasVideoTrack(filePath)
    await done()
    return
  } catch (e) {
    errors.push(`recording(mp4): ${e.message ?? e}`)
  }

  // 2) video_search CDN — hq first (reliable video), then camera-original, then LQ
  const directUrls = [row?.hq_url, row?.untranscoded_url, row?.lq_url].filter(
    Boolean,
  )

  for (const url of directUrls) {
    try {
      await streamUrlToFile(url, filePath)
      await assertHasVideoTrack(filePath)
      await done()
      return
    } catch (e) {
      errors.push(`cdn: ${e.message ?? e}`)
    }
  }

  // 3) share/play is frequently audio-only; off unless RING_ALLOW_SHARE_PLAY=1
  if (allowSharePlay) {
    try {
      const url = await cam.getRecordingUrl(dingIdStr, { transcoded: false })
      await streamUrlToFile(url, filePath)
      await assertHasVideoTrack(filePath)
      console.warn(
        `⚠️ ${dingIdStr}: used share/play — may be audio-only; set RING_ALLOW_SHARE_PLAY=0 to skip`,
      )
      await done()
      return
    } catch (e) {
      errors.push(`share/play: ${e.message ?? e}`)
    }
  } else {
    errors.push(
      'share/play skipped (often audio); set RING_ALLOW_SHARE_PLAY=1 to allow',
    )
  }

  throw new Error(errors.join(' | '))
}

async function videoSearchChunk(cam, dateFrom, dateTo) {
  const res = await cam.videoSearch({
    dateFrom,
    dateTo,
    order: 'desc',
  })
  return res.video_search ?? []
}

function parseEventTime(ev) {
  const ca = ev.created_at
  return typeof ca === 'number' ? ca : new Date(ca).getTime()
}

/** Iterate each local calendar day from `fromDate` through `toDate` (inclusive). */
function* eachLocalCalendarDay(fromDate, toDate) {
  const cur = new Date(
    fromDate.getFullYear(),
    fromDate.getMonth(),
    fromDate.getDate(),
  )
  const end = new Date(
    toDate.getFullYear(),
    toDate.getMonth(),
    toDate.getDate(),
  )
  while (cur.getTime() <= end.getTime()) {
    yield new Date(cur)
    cur.setDate(cur.getDate() + 1)
  }
}

function localDayBounds(d) {
  const lo = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0)
  const hi = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999)
  return { startMs: lo.getTime(), endMs: hi.getTime() }
}

/**
 * Fallback when video_search is empty: paginate getEvents (newest first), stop when
 * events are entirely before `dayStartMs`.
 */
async function collectEventsForDay(cam, dayStartMs, dayEndMs, maxPages = 500) {
  const collected = []
  let paginationKey

  for (let page = 1; page <= maxPages; page++) {
    let raw
    try {
      raw = await cam.getEvents({
        limit: 50,
        ...(paginationKey ? { olderThanId: paginationKey } : {}),
      })
    } catch (e) {
      console.warn(`⚠️ getEvents page ${page} failed:`, e.message ?? e)
      break
    }

    const events = raw?.events ?? (Array.isArray(raw) ? raw : [])
    const meta = raw?.meta

    if (!events.length) break

    const firstT = parseEventTime(events[0])
    if (firstT < dayStartMs) {
      break
    }

    for (const ev of events) {
      const t = parseEventTime(ev)
      if (t >= dayStartMs && t <= dayEndMs) {
        collected.push(ev)
      }
    }

    paginationKey = meta?.pagination_key
    if (!paginationKey) break
  }

  return collected
}

async function processCameraForDay(cam, dayFolderLabel, dayStartMs, dayEndMs, globalSeen) {
  const deviceFolder = sanitizeDeviceFolder(cam.name)
  let downloaded = 0
  let skipped = 0

  let results = []
  try {
    results = await videoSearchChunk(cam, dayStartMs, dayEndMs)
  } catch (e) {
    console.warn(`⚠️ videoSearch failed for ${cam.name}:`, e.message ?? e)
  }

  const rowsToFetch = []

  for (const row of results) {
    const created = row.created_at
    if (created < dayStartMs || created > dayEndMs) continue
    rowsToFetch.push({ type: 'search', row })
  }

  if (rowsToFetch.length === 0) {
    const events = await collectEventsForDay(cam, dayStartMs, dayEndMs)
    for (const ev of events) {
      rowsToFetch.push({ type: 'event', event: ev })
    }
  }

  for (const item of rowsToFetch) {
    let dingIdStr
    let created
    let row

    if (item.type === 'search') {
      row = item.row
      dingIdStr = row.ding_id
      created = row.created_at
    } else {
      dingIdStr = item.event.ding_id_str ?? String(item.event.ding_id)
      created = parseEventTime(item.event)
      if (created < dayStartMs || created > dayEndMs) continue
      row = null
    }

    if (!dingIdStr || globalSeen.has(dingIdStr)) continue
    globalSeen.add(dingIdStr)

    const folder = path.join(outputDir, dayFolderLabel, deviceFolder)
    fs.mkdirSync(folder, { recursive: true })

    const filePath = path.join(folder, `${dingIdStr}.mp4`)
    if (fs.existsSync(filePath) && !forceRedownload) {
      skipped++
      continue
    }

    console.log(`⬇️ ${dingIdStr} → ${filePath}`)

    try {
      await downloadRecordingClip(cam, dingIdStr, filePath, row)
      downloaded++
      console.log('✅ Downloaded')
    } catch (e) {
      console.log('❌ Failed:', e.message ?? e)
    }

    await new Promise((r) => setTimeout(r, 300))
  }

  return { downloaded, skipped }
}

function* walkMp4Files(dir) {
  if (!fs.existsSync(dir)) {
    return
  }
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  for (const ent of entries) {
    const p = path.join(dir, ent.name)
    if (ent.isDirectory()) {
      yield* walkMp4Files(p)
    } else if (
      ent.isFile() &&
      ent.name.toLowerCase().endsWith('.mp4') &&
      !ent.name.startsWith('._')
    ) {
      yield p
    }
  }
}

const ISO_TOPLEVEL_DAY = /^\d{4}-\d{2}-\d{2}$/

function assertOptionalReencodeDay(val, label) {
  const s = String(val ?? '').trim()
  if (!s) return ''
  if (!ISO_TOPLEVEL_DAY.test(s)) {
    console.error(`${label} must be YYYY-MM-DD (got: ${val})`)
    process.exit(1)
  }
  return s
}

async function assertFfmpegForReencode() {
  try {
    await execFileAsync(ffmpegBin, ['-hide_banner', '-version'], {
      timeout: 5000,
    })
  } catch {
    console.error('ffmpeg is required. Install: brew install ffmpeg')
    process.exit(1)
  }
}

/**
 * Offline: re-run ffmpeg QuickTime pass on files already on disk (HEVC → H.264, etc.).
 * Does not call Ring. Use VLC/IINA for originals; this fixes QuickTime broadly.
 */
async function reencodeExistingLibrary(rootDir) {
  console.log(`🔧 Re-encoding existing .mp4 files under:\n   ${rootDir}`)
  console.log(
    `   RING_TRANSCODE=${process.env.RING_TRANSCODE ?? 'always'} (set auto for faster, less reliable QuickTime)`,
  )

  await assertFfmpegForReencode()

  let n = 0
  for (const fp of walkMp4Files(rootDir)) {
    n++
    console.log(`▶ ${fp}`)
    await ensureQuickTimeMp4(fp)
  }

  console.log(`\n📊 Re-encode pass finished — ${n} .mp4 file(s) processed`)
}

/**
 * Like reencodeExistingLibrary, but only first-level folders named YYYY-MM-DD within [startStr, endStr] (string order).
 */
async function reencodeExistingLibraryByDateRange(rootDir, startStr, endStr) {
  console.log(`🔧 Re-encoding .mp4 files in date folders under:\n   ${rootDir}`)
  console.log(
    `   Range (inclusive): ${startStr || '…'} … ${endStr || '…'}  |  RING_TRANSCODE=${process.env.RING_TRANSCODE ?? 'always'}`,
  )

  await assertFfmpegForReencode()

  if (!fs.existsSync(rootDir)) {
    console.error(`Output folder does not exist: ${rootDir}`)
    process.exit(1)
  }

  const days = fs
    .readdirSync(rootDir)
    .filter((name) => ISO_TOPLEVEL_DAY.test(name))
    .filter((name) => (!startStr || name >= startStr) && (!endStr || name <= endStr))
    .sort()

  if (days.length === 0) {
    console.log('\n📊 No date folders in range — 0 .mp4 file(s) processed')
    return
  }

  let n = 0
  for (const d of days) {
    const folder = path.join(rootDir, d)
    if (!fs.statSync(folder).isDirectory()) continue
    console.log(`\n📅 ${d}`)
    for (const fp of walkMp4Files(folder)) {
      n++
      console.log(`▶ ${fp}`)
      await ensureQuickTimeMp4(fp)
    }
  }

  console.log(`\n📊 Re-encode pass finished — ${n} .mp4 file(s) processed`)
}

async function main() {
  if (reencodeOnly) {
    const sub = process.env.RING_REENCODE_SUBDIR?.trim()
    const startRe = assertOptionalReencodeDay(
      process.env.RING_REENCODE_START,
      'RING_REENCODE_START',
    )
    const endRe = assertOptionalReencodeDay(
      process.env.RING_REENCODE_END,
      'RING_REENCODE_END',
    )
    if (startRe && endRe && startRe > endRe) {
      console.error('RING_REENCODE_START must be <= RING_REENCODE_END')
      process.exit(1)
    }

    console.log(`📁 Output: ${outputDir}  (re-encode only — no download)`)
    if (sub) {
      const root = path.join(outputDir, sub)
      console.log(`📂 Limiting to subfolder: ${sub}`)
      await reencodeExistingLibrary(root)
    } else if (startRe || endRe) {
      console.log(
        `📂 Date folders: ${startRe || '(earliest)'} … ${endRe || '(latest)'} (inclusive)`,
      )
      await reencodeExistingLibraryByDateRange(outputDir, startRe, endRe)
    } else {
      await reencodeExistingLibrary(outputDir)
    }
    console.log('\n🎉 DONE')
    return
  }

  console.log(`📁 Output: ${outputDir}  (date → device folders)`)
  console.log(
    `📅 Range: ${process.env.RING_START ?? '2026-02-15'} … ${process.env.RING_END ?? '2026-05-02'} (inclusive local days); order: each day → all devices`,
  )

  try {
    await execFileAsync(ffmpegBin, ['-hide_banner', '-version'], {
      timeout: 4000,
    })
    const tm = transcodeMode()
    if (tm === 'off') {
      console.log('🎞 ffmpeg found; transcode disabled (RING_TRANSCODE=0)')
    } else {
      console.log(
        `🎞 ffmpeg: QuickTime pass (${tm}) — HEVC / incompatible MP4 → H.264 + AAC`,
      )
    }
  } catch {
    if (transcodeMode() !== 'off') {
      console.log(
        '⚠️ ffmpeg not found — QuickTime may refuse some Ring clips. Install: brew install ffmpeg',
      )
    }
  }

  const cameras = await ringApi.getCameras()
  const eligible = cameras.filter(
    (cam) =>
      !(skipDoorbell && cam.name.toLowerCase().includes('doorbell')),
  )

  const globalSeen = new Set()
  let totalDownloaded = 0
  let totalSkipped = 0

  for (const day of eachLocalCalendarDay(startDate, endDate)) {
    const { startMs: dayLo, endMs: dayHi } = localDayBounds(day)
    const clipLo = Math.max(dayLo, startMs)
    const clipHi = Math.min(dayHi, endMs)
    if (clipLo > clipHi) continue

    const dayFolderLabel = formatLocalDateFolder(clipLo)

    console.log(`\n📅 ${dayFolderLabel}`)

    for (const cam of eligible) {
      console.log(`   📷 ${cam.name}`)
      const { downloaded, skipped } = await processCameraForDay(
        cam,
        dayFolderLabel,
        clipLo,
        clipHi,
        globalSeen,
      )
      totalDownloaded += downloaded
      totalSkipped += skipped
      if (downloaded || skipped) {
        console.log(`      📊 ${downloaded} downloaded, ${skipped} skipped`)
      } else {
        console.log(`      — no clips this day`)
      }
    }
  }

  console.log(
    `\n📊 Total: ${totalDownloaded} downloaded, ${totalSkipped} skipped (existing)`,
  )

  if (totalDownloaded === 0 && totalSkipped > 0) {
    console.log(
      '\n💡 Tip: “skipped” means the .mp4 already exists on disk. Use RING_FORCE=1 to re-download. To transcode existing files for QuickTime without hitting Ring: RING_REENCODE_ONLY=1 npm run reencode',
    )
  }

  if (ringLogStream) {
    const summary = {
      endedAt: new Date().toISOString(),
      outputDir,
      dateRange: {
        start: process.env.RING_START ?? '2026-02-15',
        end: process.env.RING_END ?? '2026-05-02',
      },
      totals: {
        downloaded: totalDownloaded,
        skippedExisting: totalSkipped,
      },
      devices: eligible.map((c) => ({
        name: c.name,
        id: c.id,
        kind: c.data?.kind ?? c.data?.device_type ?? null,
      })),
    }
    ringLogStream.write('\n--- summary_json (for analysis) ---\n')
    ringLogStream.write(`${JSON.stringify(summary, null, 2)}\n`)
  }

  console.log('\n🎉 DONE')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
