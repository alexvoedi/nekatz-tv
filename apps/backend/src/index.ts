import type { Request, Response } from 'express'
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

// Helper function to check if audio codec is browser-compatible
async function checkAudioCodec(filePath: string): Promise<{ needsTranscoding: boolean, codec: string }> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) {
        reject(err)
        return
      }

      const audioStream = metadata.streams.find(s => s.codec_type === 'audio')
      if (!audioStream) {
        // No audio stream, no transcoding needed
        resolve({ needsTranscoding: false, codec: 'none' })
        return
      }

      const codec = audioStream.codec_name || ''
      // Browser-compatible codecs: aac, mp3, opus, vorbis
      const compatibleCodecs = ['aac', 'mp3', 'opus', 'vorbis']
      const needsTranscoding = !compatibleCodecs.includes(codec)

      resolve({ needsTranscoding, codec })
    })
  })
}

// Stream the current video with audio transcoding for browser compatibility
// Stream the current video with optional transcoding and seeking
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
  const hasRangeHeader = !!req.headers.range

  // Log occasionally (every minute or at start)
  const shouldLog = startPosition === 0 || startPosition % 60 === 0
  if (shouldLog) {
    const posMsg = startPosition > 0 ? `, position: ${startPosition}s` : ''
    const rangeMsg = hasRangeHeader ? ' (range request)' : ''
    console.log(`Stream request for ${currentItem.episode.filename}${posMsg}${rangeMsg}`)
  }

  try {
    // Check if audio needs transcoding
    const { needsTranscoding, codec } = await checkAudioCodec(videoPath)

    // Use FFmpeg for seeking (with or without transcoding) if start position is specified
    // FFmpeg seeking is much faster than client-side Range requests
    if (startPosition > 0 || needsTranscoding) {
      streamWithFFmpeg(videoPath, startPosition, needsTranscoding, codec, res)
    }
    else {
      // No seeking needed and no transcoding - stream original file with Range support
      if (shouldLog) {
        console.log(`Audio codec ${codec} is browser-compatible, streaming original file`)
      }
      streamOriginalFile(videoPath, req, res)
    }
  }
  catch (error) {
    console.error('Error checking audio codec:', error)
    streamOriginalFile(videoPath, req, res)
  }
})

// Helper function to stream video with FFmpeg (transcoding and/or seeking)
function streamWithFFmpeg(
  videoPath: string,
  startPosition: number,
  needsTranscoding: boolean,
  codec: string,
  res: Response,
) {
  const mode = needsTranscoding ? 'transcode' : 'copy'
  const startMsg = startPosition > 0 ? ` starting at ${startPosition}s` : ''

  if (needsTranscoding) {
    console.log(`Transcoding audio from ${codec} to AAC${startMsg}`)
  }
  else {
    console.log(`Seeking to ${startPosition}s with FFmpeg (copy mode)`)
  }

  // Set headers (FFmpeg streams don't support Range requests)
  res.setHeader('Content-Type', 'video/mp4')
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate')
  res.setHeader('Accept-Ranges', 'none')

  const command = ffmpeg(videoPath)

  // Output options: copy video, transcode or copy audio depending on need
  const outputOptions = [
    '-c:v copy', // Always copy video (no video transcoding)
    needsTranscoding ? '-c:a aac' : '-c:a copy', // Transcode audio only if needed
    ...(needsTranscoding ? ['-b:a 192k'] : []), // Audio bitrate for transcoding
    '-avoid_negative_ts make_zero',
    '-movflags frag_keyframe+empty_moov+faststart',
    '-f mp4',
  ]

  // Seek to start position if specified
  if (startPosition > 0) {
    command.seekInput(startPosition)
  }

  command
    .outputOptions(outputOptions)
    .on('start', (commandLine) => {
      console.log(`FFmpeg ${mode}:`, commandLine)
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

// Helper function to stream original file with range support
function streamOriginalFile(videoPath: string, req: Request, res: Response) {
  const range = req.headers.range

  try {
    const stat = fs.statSync(videoPath)
    const fileSize = stat.size

    if (range) {
      // Parse range header (e.g., "bytes=0-1023")
      const parts = range.replace(/bytes=/, '').split('-')
      const start = Number.parseInt(parts[0], 10)
      let end = parts[1] ? Number.parseInt(parts[1], 10) : fileSize - 1

      // If browser requests open-ended range (e.g., "bytes=22708224-"),
      // send a large chunk to reduce round-trips
      if (!parts[1]) {
        // Send at least 10MB or rest of file, whichever is smaller
        const INITIAL_CHUNK = 10 * 1024 * 1024 // 10MB
        end = Math.min(start + INITIAL_CHUNK - 1, fileSize - 1)
      }

      // Validate range
      if (start >= fileSize || end >= fileSize || start > end) {
        res.status(416).send('Requested range not satisfiable')
        return
      }

      const chunksize = (end - start) + 1

      // Use 2MB buffer for reading (faster disk I/O)
      const highWaterMark = 2 * 1024 * 1024

      const file = fs.createReadStream(videoPath, { start, end, highWaterMark })

      const head = {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunksize,
        'Content-Type': 'video/mp4',
        'Cache-Control': 'public, max-age=3600',
        'Vary': 'Range', // Tell browser that responses vary by Range header
      }

      res.writeHead(206, head)

      // Flush headers immediately to prevent browser from cancelling
      if (typeof res.flushHeaders === 'function') {
        res.flushHeaders()
      }

      file.pipe(res)

      // Handle stream errors
      file.on('error', (error) => {
        console.error('Stream error:', error)
        if (!res.headersSent) {
          res.status(500).json({ error: 'Failed to stream video' })
        }
      })
    }
    else {
      const head = {
        'Content-Length': fileSize,
        'Content-Type': 'video/mp4',
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'public, max-age=3600', // Cache for 1 hour
      }
      res.writeHead(200, head)

      const stream = fs.createReadStream(videoPath, {
        highWaterMark: 1024 * 1024, // 1MB chunks for better performance
      })

      stream.pipe(res)

      // Handle stream errors
      stream.on('error', (error) => {
        console.error('Stream error:', error)
        if (!res.headersSent) {
          res.status(500).json({ error: 'Failed to stream video' })
        }
      })
    }
  }
  catch (error) {
    console.error('Error streaming video:', error)
    res.status(500).json({ error: 'Failed to stream video' })
  }
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

// Check if current video needs transcoding
app.get('/api/needs-transcoding', async (_req: Request, res: Response) => {
  if (!playlistManager) {
    return res.status(503).json({ error: 'Playlist not initialized' })
  }

  const currentItem = playlistManager.getCurrentItem()
  if (!currentItem) {
    return res.status(404).json({ error: 'No video currently playing' })
  }

  try {
    const { needsTranscoding, codec } = await checkAudioCodec(currentItem.episode.path)
    res.json({ needsTranscoding, codec })
  }
  catch (error) {
    console.error('Error checking audio codec:', error)
    res.status(500).json({ error: 'Failed to check audio codec' })
  }
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
