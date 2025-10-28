import type { Request, Response } from 'express'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import cors from 'cors'
import express from 'express'
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

// Stream the current video
app.get('/api/stream', (req: Request, res: Response) => {
  if (!playlistManager) {
    return res.status(503).json({ error: 'Playlist not initialized' })
  }

  const currentItem = playlistManager.getCurrentItem()
  if (!currentItem) {
    return res.status(404).json({ error: 'No video currently playing' })
  }

  const videoPath = currentItem.episode.path
  const range = req.headers.range

  try {
    const stat = fs.statSync(videoPath)
    const fileSize = stat.size

    if (range) {
      const parts = range.replace(/bytes=/, '').split('-')
      const start = Number.parseInt(parts[0], 10)
      const end = parts[1] ? Number.parseInt(parts[1], 10) : fileSize - 1
      const chunksize = (end - start) + 1
      const file = fs.createReadStream(videoPath, { start, end })
      const head = {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunksize,
        'Content-Type': 'video/mp4',
      }
      res.writeHead(206, head)
      file.pipe(res)
    }
    else {
      const head = {
        'Content-Length': fileSize,
        'Content-Type': 'video/mp4',
        'Accept-Ranges': 'bytes',
      }
      res.writeHead(200, head)
      fs.createReadStream(videoPath).pipe(res)
    }
  }
  catch (error) {
    console.error('Error streaming video:', error)
    res.status(500).json({ error: 'Failed to stream video' })
  }
})

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
