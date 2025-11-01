import type { Episode, Show } from './types.js'
import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import ffmpeg from 'fluent-ffmpeg'

const VIDEO_EXTENSIONS = ['.mp4', '.mkv', '.avi', '.webm', '.mov']

// Files to skip during scanning (macOS metadata, thumbnails, etc.)
const SKIP_FILES = [
  /^\./, // Hidden files (including .DS_Store)
  /^\._/, // macOS resource forks
  /Thumbs\.db$/i, // Windows thumbnails
  /desktop\.ini$/i, // Windows folder config
  /\.Zone\.Identifier$/i, // Windows downloaded file markers
]

// Cache for video metadata to avoid repeated ffprobe calls
interface MetadataCache {
  duration: number
  mtime: number // File modification time
}

const metadataCache = new Map<string, MetadataCache>()
const CACHE_DIR = path.join(process.cwd(), 'cache')
const METADATA_CACHE_FILE = path.join(CACHE_DIR, 'video-metadata.json')
const SCAN_LOG_FILE = path.join(CACHE_DIR, 'scan.log')

// Ensure cache directory exists
function ensureCacheDir() {
  if (!fsSync.existsSync(CACHE_DIR)) {
    fsSync.mkdirSync(CACHE_DIR, { recursive: true })
  }
}

// Log to both console and file
function log(message: string) {
  console.log(message)
  try {
    ensureCacheDir()
    const timestamp = new Date().toISOString()
    fsSync.appendFileSync(SCAN_LOG_FILE, `[${timestamp}] ${message}\n`)
  }
  catch (error) {
    console.error('Failed to write to log file:', error)
  }
}

// Load metadata cache from disk
async function loadMetadataCache() {
  try {
    ensureCacheDir()
    const data = await fs.readFile(METADATA_CACHE_FILE, 'utf-8')
    const parsed = JSON.parse(data) as Record<string, MetadataCache>

    // Populate the Map from the loaded data
    for (const [filePath, cache] of Object.entries(parsed)) {
      metadataCache.set(filePath, cache)
    }

    console.log(`Loaded ${metadataCache.size} cached video metadata entries`)
  }
  catch (error) {
    // Cache file doesn't exist or is invalid, start fresh
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn('Failed to load metadata cache:', error)
    }
  }
}

// Save metadata cache to disk
async function saveMetadataCache() {
  try {
    ensureCacheDir()
    const cacheObject = Object.fromEntries(metadataCache)
    await fs.writeFile(METADATA_CACHE_FILE, JSON.stringify(cacheObject, null, 2))
  }
  catch (error) {
    console.error('Failed to save metadata cache:', error)
  }
}

// Parse filename like "Show Name - S01E01.mp4" or "Show Name - S01E01a.mp4" or "Show Name - S01E01 - Episode Title.mp4"
// Also supports standalone episodes/movies like "Show Name - Episode Title.mp4"
function parseEpisodeFilename(filename: string): { showName: string, season: number, episode: number, part: string } | null {
  // Remove extension
  const nameWithoutExt = filename.replace(/\.[^.]+$/, '')

  // Match pattern: "Show Name - S##E##[part]" where part is optional (a, b, c, etc.)
  const episodeRegex = /^(.+)-\s*S(\d+)E(\d+)([a-z])?/i
  const episodeMatch = episodeRegex.exec(nameWithoutExt)

  if (episodeMatch) {
    return {
      showName: episodeMatch[1].trim(),
      season: Number.parseInt(episodeMatch[2], 10),
      episode: Number.parseInt(episodeMatch[3], 10),
      part: episodeMatch[4] || '', // Empty string if no part
    }
  }

  // Fallback: "Show Name - Episode Title.mp4" (treat as S01E01, S01E02, etc. in order)
  // Match any filename with a dash separator
  const dashIndex = nameWithoutExt.indexOf(' - ')
  if (dashIndex !== -1) {
    // Use the part before the dash as show name
    // Episode number will be assigned sequentially later
    return {
      showName: nameWithoutExt.substring(0, dashIndex).trim(),
      season: 1,
      episode: 0, // Will be assigned sequentially
      part: '',
    }
  }

  // No match - might be a single file like "Movie Name.mp4"
  // Treat the whole filename as show name
  return {
    showName: nameWithoutExt.trim(),
    season: 1,
    episode: 0,
    part: '',
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

// Get video duration with caching based on file modification time
async function getCachedVideoDuration(filePath: string): Promise<number> {
  try {
    const stats = await fs.stat(filePath)
    const mtime = stats.mtimeMs

    const cached = metadataCache.get(filePath)
    if (cached?.mtime === mtime) {
      // File hasn't changed, use cached duration
      return cached.duration
    }

    // File is new or has changed, get fresh duration
    const duration = await getVideoDuration(filePath)

    // Cache the result
    metadataCache.set(filePath, { duration, mtime })

    return duration
  }
  catch (error) {
    // If we can't stat the file, just try to get the duration normally
    console.warn(`Failed to stat file ${filePath}, skipping cache:`, error)
    return getVideoDuration(filePath)
  }
}

export async function scanShows(showsDir: string): Promise<Show[]> {
  log(`📁 Scanning shows directory: ${showsDir}`)

  // Load cached metadata on first scan
  if (metadataCache.size === 0) {
    await loadMetadataCache()
  }

  const failedFiles: Array<{ file: string, reason: string }> = []

  try {
    const entries = await fs.readdir(showsDir, { withFileTypes: true })
    const showFolders = entries.filter(entry => entry.isDirectory())

    log(`📂 Found ${showFolders.length} show folders`)

    const shows: Show[] = []

    for (const folder of showFolders) {
      log(`  📺 Scanning show: ${folder.name}`)
      const folderPath = path.join(showsDir, folder.name)
      const files = await fs.readdir(folderPath)

      const episodes: Episode[] = []
      let skippedFiles = 0

      for (const file of files) {
        // Skip macOS metadata files, hidden files, and other system files
        if (SKIP_FILES.some(pattern => pattern.test(file))) {
          skippedFiles++
          continue
        }

        const ext = path.extname(file).toLowerCase()
        if (!VIDEO_EXTENSIONS.includes(ext)) {
          skippedFiles++
          continue
        }

        const parsed = parseEpisodeFilename(file)
        if (!parsed) {
          const reason = 'Could not parse filename (expected format: "Show Name - S01E01.mp4")'
          log(`    ❌ Failed: ${file}`)
          log(`       Reason: ${reason}`)
          failedFiles.push({ file: path.join(folder.name, file), reason })
          continue
        }

        const filePath = path.join(folderPath, file)

        try {
          const duration = await getCachedVideoDuration(filePath)

          episodes.push({
            path: filePath,
            filename: file,
            showName: parsed.showName,
            season: parsed.season,
            episode: parsed.episode,
            part: parsed.part,
            duration,
          })

          // Show warning symbol for files without explicit season/episode numbers
          if (parsed.episode === 0) {
            log(`    ⚠️  ${file} (auto-assigned episode number)`)
          }
          else {
            log(`    ✓ ${file}`)
          }
        }
        catch (error) {
          // Skip files that can't be processed (corrupted, unsupported format, etc.)
          const reason = error instanceof Error ? error.message : 'Unknown error'
          log(`    ❌ Failed: ${file}`)
          log(`       Reason: ${reason}`)
          failedFiles.push({ file: path.join(folder.name, file), reason })
          continue
        }
      }

      const skippedInfo = skippedFiles > 0 ? ` (skipped ${skippedFiles} non-video files)` : ''
      log(`    ✅ Found ${episodes.length} episodes${skippedInfo}`)

      // Assign sequential episode numbers to episodes with episode = 0
      let nextEpisodeNum = 1
      for (const episode of episodes) {
        if (episode.episode === 0) {
          episode.episode = nextEpisodeNum++
        }
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

    log(`\n✨ Scan complete: Found ${shows.length} shows with a total of ${shows.reduce((sum, show) => sum + show.episodes.length, 0)} episodes\n`)

    // Log failed files summary
    if (failedFiles.length > 0) {
      log(`\n⚠️  Failed to process ${failedFiles.length} file(s):\n`)
      for (const { file, reason } of failedFiles) {
        log(`   - ${file}`)
        log(`     Reason: ${reason}`)
      }
      log('')
    }

    // Save cache after scanning
    await saveMetadataCache()

    return shows
  }
  catch (error) {
    console.error('❌ Error scanning shows:', error)
    return []
  }
}

// Clean up cache entries for files that no longer exist
// This should be called periodically to prevent memory leaks
export async function cleanupMetadataCache(validPaths: Set<string>) {
  const keysToDelete: string[] = []

  for (const [filePath] of metadataCache) {
    if (!validPaths.has(filePath)) {
      keysToDelete.push(filePath)
    }
  }

  for (const key of keysToDelete) {
    metadataCache.delete(key)
  }

  if (keysToDelete.length > 0) {
    console.log(`Cleaned up ${keysToDelete.length} stale cache entries`)
    // Save cache after cleanup
    await saveMetadataCache()
  }
}
