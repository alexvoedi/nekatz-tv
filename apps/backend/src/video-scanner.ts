import type { Episode, Show } from './types.js'
import fs from 'node:fs/promises'
import path from 'node:path'
import ffmpeg from 'fluent-ffmpeg'

const VIDEO_EXTENSIONS = ['.mp4', '.mkv', '.avi', '.webm', '.mov']

// Parse filename like "Show Name - S01E01.mp4" or "Show Name - S01E01a.mp4" or "Show Name - S01E01 - Episode Title.mp4"
function parseEpisodeFilename(filename: string): { showName: string, season: number, episode: number, part: string } | null {
  // Remove extension
  const nameWithoutExt = filename.replace(/\.[^.]+$/, '')

  // Match pattern: "Show Name - S##E##[part]" where part is optional (a, b, c, etc.)
  const regex = /^(.+)-\s*S(\d+)E(\d+)([a-z])?/i
  const match = regex.exec(nameWithoutExt)

  if (!match)
    return null

  return {
    showName: match[1].trim(),
    season: Number.parseInt(match[2], 10),
    episode: Number.parseInt(match[3], 10),
    part: match[4] || '', // Empty string if no part
  }
}

// Get actual video duration using ffprobe
async function getVideoDuration(filePath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) {
        reject(new Error(`Failed to get duration for ${filePath}: ${err.message}`))
        return
      }

      const duration = metadata.format.duration
      if (!duration) {
        reject(new Error(`No duration found in metadata for ${filePath}`))
        return
      }

      resolve(Math.floor(duration))
    })
  })
}

export async function scanShows(showsDir: string): Promise<Show[]> {
  try {
    const entries = await fs.readdir(showsDir, { withFileTypes: true })
    const showFolders = entries.filter(entry => entry.isDirectory())

    const shows: Show[] = []

    for (const folder of showFolders) {
      const folderPath = path.join(showsDir, folder.name)
      const files = await fs.readdir(folderPath)

      const episodes: Episode[] = []

      for (const file of files) {
        const ext = path.extname(file).toLowerCase()
        if (!VIDEO_EXTENSIONS.includes(ext))
          continue

        const parsed = parseEpisodeFilename(file)
        if (!parsed)
          continue

        const filePath = path.join(folderPath, file)
        const duration = await getVideoDuration(filePath)

        episodes.push({
          path: filePath,
          filename: file,
          showName: parsed.showName,
          season: parsed.season,
          episode: parsed.episode,
          part: parsed.part,
          duration,
        })
      }

      // Sort episodes by season, episode number, and part
      episodes.sort((a, b) => {
        if (a.season !== b.season)
          return a.season - b.season
        if (a.episode !== b.episode)
          return a.episode - b.episode
        // Sort parts alphabetically (empty string comes first)
        return a.part.localeCompare(b.part)
      })

      if (episodes.length > 0) {
        shows.push({
          name: episodes[0].showName,
          episodes,
        })
      }
    }

    return shows
  }
  catch (error) {
    console.error('Error scanning shows:', error)
    return []
  }
}
