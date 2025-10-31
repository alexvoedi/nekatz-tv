import type { Request, Response } from 'express'
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import cors from 'cors'
import express from 'express'
import ffmpeg from 'fluent-ffmpeg'
import { PlaylistManager } from './playlist-manager.js'
import { scanShows } from './video-scanner.js'

const app = express()

const PORT = process.env.PORT || 3000
const SHOWS_DIR = process.env.SHOWS_DIR || path.join(process.cwd(), 'shows')

app.use(cors())
app.use(express.json())

let playlistManager: PlaylistManager | null = null

// Check if hardware acceleration is available
let hwaccelAvailable = false
const VAAPI_DEVICE = '/dev/dri/renderD128'

// Check for VAAPI support at startup by testing if vainfo works
if (fs.existsSync(VAAPI_DEVICE)) {
  try {
    // Try to run vainfo to check if VAAPI actually works
    // Use LIBVA_DRIVER_NAME and DISPLAY to force DRM mode (no X server needed)
    execSync('vainfo', {
      stdio: 'pipe',
      timeout: 5000,
      env: { ...process.env, LIBVA_DRIVER_NAME: 'iHD', DISPLAY: '' },
    })
    console.log('✓ Hardware acceleration (VAAPI) available')
    hwaccelAvailable = true
  }
  catch (error) {
    console.log('⚠ VAAPI device exists but vainfo failed, using software encoding')
    if (error instanceof Error && 'stderr' in error) {
      console.log('  Debug:', (error as any).stderr?.toString().split('\n')[0])
    }
  }
}
else {
  console.log('⚠ Hardware acceleration not available, using software encoding')
}

// Initialize the playlist
async function initialize() {
  console.log('Scanning shows directory:', SHOWS_DIR)
  const shows = await scanShows(SHOWS_DIR)
  console.log(`Found ${shows.length} shows`)

  for (const show of shows) {
    console.log(`  - ${show.name}: ${show.episodes.length} episodes`)
  }

  // Pass a rescan callback that rescans the shows directory
  playlistManager = new PlaylistManager(shows, undefined, async () => {
    return await scanShows(SHOWS_DIR)
  })
  console.log('Playlist initialized')
}

// Stream the current video with transcoding
app.get('/api/stream', async (req: Request, res: Response) => {
  if (!playlistManager) {
    return res.status(503).json({ error: 'Playlist not initialized. Please try again in a moment or check server status.' })
  }

  const currentItem = playlistManager.getCurrentItem()
  if (!currentItem) {
    return res.status(404).json({ error: 'No video currently playing' })
  }

  const videoPath = currentItem.episode.path
  const startPosition = req.query.start ? Number.parseInt(req.query.start as string, 10) : 0

  // Log occasionally (every minute or at start)
  const shouldLog = startPosition === 0 || startPosition % 60 === 0
  if (shouldLog) {
    const posMsg = startPosition > 0 ? `, position: ${startPosition}s` : ''
    console.log(`Stream request for ${currentItem.episode.filename}${posMsg}`)
  }

  // Always use FFmpeg for transcoding and seeking
  streamWithFFmpeg(videoPath, startPosition, req, res)
})

// Helper function to stream video with FFmpeg (always transcodes for compatibility)
function streamWithFFmpeg(
  videoPath: string,
  startPosition: number,
  req: Request,
  res: Response,
) {
  const startMsg = startPosition > 0 ? ` starting at ${startPosition}s` : ''
  console.log(`Transcoding video${startMsg}`)

  // Set headers (FFmpeg streams don't support Range requests)
  res.setHeader('Content-Type', 'video/mp4')
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate')
  res.setHeader('Accept-Ranges', 'none')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Transfer-Encoding', 'chunked')
  res.status(200)

  // Remove Range header if present (Firefox sometimes sends it)
  delete req.headers.range

  const command = ffmpeg(videoPath)

  // Seek to start position if specified (must be before input options for VAAPI)
  if (startPosition > 0) {
    command.seekInput(startPosition)
  }

  // Use hardware acceleration if available, otherwise fall back to software
  if (hwaccelAvailable) {
    // VAAPI hardware acceleration (Intel/AMD integrated graphics)
    command
      .inputOptions([
        '-hwaccel vaapi',
        `-hwaccel_device ${VAAPI_DEVICE}`,
      ])
      .outputOptions([
        '-vf',
        'format=nv12,hwupload',
        '-c:v h264_vaapi',
      ])
  }
  else {
    // Software encoding
    command.outputOptions([
      '-c:v libx264',
      '-preset veryfast',
      '-tune zerolatency',
      '-threads 0',
    ])
  }

  // Common output options for both hardware and software
  command.outputOptions([
    '-b:v 3M', // Video bitrate (3 Mbps - good quality for streaming)
    '-maxrate 5M', // Max bitrate 5 Mbps
    '-bufsize 10M', // Buffer size
    '-g 30', // Keyframe every 30 frames (enables better seeking)
    '-c:a aac', // AAC audio codec
    '-b:a 192k', // Audio bitrate
    '-avoid_negative_ts make_zero',
    '-movflags frag_keyframe+empty_moov+default_base_moof',
    '-frag_duration 1000000', // 1 second fragments
    '-f mp4',
  ])

  command
    .on('start', (commandLine) => {
      const accel = hwaccelAvailable ? '(hardware)' : '(software)'
      console.log(`FFmpeg ${accel}:`, commandLine)
    })
    .on('error', (err) => {
      console.error('FFmpeg error:', err.message)
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to stream video' })
      }
    })
    .on('end', () => {
      console.log('Streaming finished')
    })
    .pipe(res, { end: true })
}

// Get current state (for debugging)
app.get('/api/current', (_req: Request, res: Response) => {
  if (!playlistManager) {
    return res.status(503).json({ error: 'Playlist not initialized' })
  }

  const currentItem = playlistManager.getCurrentItem()
  const position = playlistManager.getPosition()

  res.json({
    currentItem,
    position,
    timestamp: Date.now(),
  })
})

// Health check
app.get('/api/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok' })
})

// Start server
app.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`)
  await initialize()
})
