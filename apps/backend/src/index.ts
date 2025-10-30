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

  try {
    // Check if audio needs transcoding
    const { needsTranscoding, codec } = await checkAudioCodec(videoPath)

    if (needsTranscoding) {
      const startMsg = startPosition > 0 ? ` starting at ${startPosition}s` : ''
      console.log(`Transcoding audio from ${codec} to AAC for browser compatibility${startMsg}`)

      // Set headers for streaming
      res.setHeader('Content-Type', 'video/mp4')
      res.setHeader('Cache-Control', 'public, max-age=3600')

      // Transcode audio on-the-fly
      const command = ffmpeg(videoPath)

      const outputOptions = [
        '-c:v copy', // Copy video stream as-is (no transcoding)
        '-c:a aac', // Transcode audio to AAC (browser-compatible)
        '-b:a 192k', // Audio bitrate
        '-movflags frag_keyframe+empty_moov+faststart', // Enable streaming
        '-f mp4', // Output format
      ]

      // If start position is specified, seek to that position
      if (startPosition > 0) {
        // Seek after input for accuracy, but add accurate flag
        command
          .inputOptions(['-accurate_seek'])
          .seekInput(startPosition)
      }

      command
        .outputOptions(outputOptions)
        .on('start', (commandLine) => {
          console.log('FFmpeg command:', commandLine)
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

      // Pipe the output to the response
      command.pipe(res, { end: true })
    }
    else {
      // Audio is already compatible, stream original file with range support
      console.log(`Audio codec ${codec} is browser-compatible, streaming original file`)
      streamOriginalFile(videoPath, req, res)
    }
  }
  catch (error) {
    console.error('Error checking audio codec:', error)
    // Fallback to original streaming
    streamOriginalFile(videoPath, req, res)
  }
})

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
      const end = parts[1] ? Number.parseInt(parts[1], 10) : fileSize - 1

      // Validate range
      if (start >= fileSize || end >= fileSize) {
        res.status(416).send('Requested range not satisfiable')
        return
      }

      const chunksize = (end - start) + 1

      // Optimized chunk size for video streaming (use larger chunks for better performance)
      const OPTIMAL_CHUNK_SIZE = 1024 * 1024 // 1MB chunks
      const highWaterMark = Math.min(chunksize, OPTIMAL_CHUNK_SIZE)

      const file = fs.createReadStream(videoPath, { start, end, highWaterMark })

      const head = {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunksize,
        'Content-Type': 'video/mp4',
        'Cache-Control': 'public, max-age=3600', // Cache for 1 hour
      }

      res.writeHead(206, head)
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

// Health check
app.get('/api/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok' })
})

// Start server
app.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`)
  await initialize()
})
