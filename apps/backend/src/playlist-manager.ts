import type { Episode, PlaylistItem, Show } from './types.js'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { cleanupMetadataCache } from './video-scanner.js'

interface SavedState {
  currentEpisode: {
    showName: string
    season: number
    episode: number
    part: string
    startTime: number // When this episode started playing
  } | null
}

export class PlaylistManager {
  private shows: Show[] = []
  private playlist: PlaylistItem[] = []
  private readonly showIndices: Map<string, number> = new Map() // Track current episode index for each show
  private currentShowIndex = 0
  private readonly playlistStartTime: number
  private readonly stateFile: string
  private saveInterval: NodeJS.Timeout | null = null
  private readonly rescanCallback: (() => Promise<Show[]>) | null = null
  private rescanInterval: NodeJS.Timeout | null = null

  constructor(shows: Show[], stateFile?: string, rescanCallback?: () => Promise<Show[]>) {
    this.shows = shows.filter(show => show.episodes.length > 0)
    this.stateFile = stateFile || path.join(process.cwd(), 'cache', 'playlist-state.json')
    this.rescanCallback = rescanCallback || null

    // Ensure cache directory exists
    const cacheDir = path.dirname(this.stateFile)
    if (!fs.existsSync(cacheDir)) {
      fs.mkdirSync(cacheDir, { recursive: true })
    }

    // Try to restore previous state
    const restored = this.restoreState()

    if (restored?.currentEpisode) {
      // Restore from the saved episode
      console.log(`Restoring from ${restored.currentEpisode.showName} S${restored.currentEpisode.season}E${restored.currentEpisode.episode}${restored.currentEpisode.part}`)
      this.playlistStartTime = restored.currentEpisode.startTime
      this.restoreFromEpisode(restored.currentEpisode)
    }
    else {
      // Start fresh
      this.playlistStartTime = Date.now()
      this.initializeIndices()
    }

    this.generateInitialPlaylist()
    this.saveState()

    // Save state every 10 seconds
    this.saveInterval = setInterval(() => {
      this.saveState()
    }, 10000)

    // Rescan for new episodes every 5 minutes
    if (this.rescanCallback) {
      this.rescanInterval = setInterval(() => {
        this.rescanForNewEpisodes()
      }, 5 * 60 * 1000)
    }
  }

  private restoreFromEpisode(savedEpisode: SavedState['currentEpisode']) {
    if (!savedEpisode)
      return

    // Find the episode in our shows
    for (let showIdx = 0; showIdx < this.shows.length; showIdx++) {
      const show = this.shows[showIdx]
      const episodeIdx = show.episodes.findIndex(ep =>
        ep.season === savedEpisode.season
        && ep.episode === savedEpisode.episode
        && ep.part === savedEpisode.part
        && ep.showName === savedEpisode.showName,
      )

      if (episodeIdx !== -1) {
        // Found the episode! Set indices to continue from this episode (not the next one)
        this.currentShowIndex = showIdx // Current show in rotation
        this.showIndices.set(show.name, episodeIdx) // This episode from this show

        // Initialize other shows to start from beginning
        for (const otherShow of this.shows) {
          if (otherShow.name !== show.name && !this.showIndices.has(otherShow.name)) {
            this.showIndices.set(otherShow.name, 0)
          }
        }
        return
      }
    }

    // Episode not found, start fresh
    console.warn('Could not find saved episode, starting fresh')
    this.initializeIndices()
  }

  public destroy() {
    if (this.saveInterval) {
      clearInterval(this.saveInterval)
      this.saveInterval = null
    }
    if (this.rescanInterval) {
      clearInterval(this.rescanInterval)
      this.rescanInterval = null
    }
    // Final save on destroy
    this.saveState()
  }

  private async rescanForNewEpisodes() {
    if (!this.rescanCallback)
      return

    try {
      const newShows = await this.rescanCallback()
      const filteredShows = newShows.filter(show => show.episodes.length > 0)

      // Update shows list
      this.shows = filteredShows

      // Initialize indices for any new shows
      for (const show of this.shows) {
        if (!this.showIndices.has(show.name)) {
          this.showIndices.set(show.name, 0)
          console.log(`New show detected: ${show.name}`)
        }
      }

      // Clean up metadata cache for files that no longer exist
      const validPaths = new Set<string>()
      for (const show of this.shows) {
        for (const episode of show.episodes) {
          validPaths.add(episode.path)
        }
      }
      await cleanupMetadataCache(validPaths)

      console.log(`Rescanned shows: ${this.shows.length} shows, ${this.shows.reduce((sum, s) => sum + s.episodes.length, 0)} episodes`)
    }
    catch (error) {
      console.error('Failed to rescan for new episodes:', error)
    }
  }

  private initializeIndices() {
    for (const show of this.shows) {
      if (!this.showIndices.has(show.name)) {
        this.showIndices.set(show.name, 0)
      }
    }
  }

  private saveState() {
    const currentItem = this.getCurrentItem()

    const state: SavedState = {
      currentEpisode: currentItem
        ? {
            showName: currentItem.episode.showName,
            season: currentItem.episode.season,
            episode: currentItem.episode.episode,
            part: currentItem.episode.part,
            startTime: currentItem.startTime,
          }
        : null,
    }

    try {
      fs.writeFileSync(this.stateFile, JSON.stringify(state, null, 2))
    }
    catch (error) {
      console.error('Failed to save playlist state:', error)
    }
  }

  private restoreState(): SavedState | null {
    try {
      if (fs.existsSync(this.stateFile)) {
        const data = fs.readFileSync(this.stateFile, 'utf-8')
        const state = JSON.parse(data) as SavedState
        if (state.currentEpisode) {
          console.log(`Restored playlist state from ${state.currentEpisode.showName} S${state.currentEpisode.season}E${state.currentEpisode.episode}${state.currentEpisode.part}`)
        }
        return state
      }
    }
    catch (error) {
      console.error('Failed to restore playlist state:', error)
    }
    return null
  }

  private getNextEpisode(): Episode | null {
    if (this.shows.length === 0)
      return null

    // Round-robin through shows
    const show = this.shows[this.currentShowIndex]
    const episodeIndex = this.showIndices.get(show.name) || 0

    if (episodeIndex >= show.episodes.length) {
      // Restart this show from the beginning
      this.showIndices.set(show.name, 0)
    }

    const episode = show.episodes[this.showIndices.get(show.name) || 0]

    // Increment episode index for this show
    this.showIndices.set(show.name, (this.showIndices.get(show.name) || 0) + 1)

    // Move to next show
    this.currentShowIndex = (this.currentShowIndex + 1) % this.shows.length

    return episode
  }

  private generateInitialPlaylist() {
    let currentTime = this.playlistStartTime

    // Generate playlist for the next 2 hours only (reduced from 24 hours)
    // We'll extend as needed with lazy evaluation
    const INITIAL_LOOKAHEAD_HOURS = 2
    const endTime = currentTime + (INITIAL_LOOKAHEAD_HOURS * 60 * 60 * 1000)

    while (currentTime < endTime) {
      const episode = this.getNextEpisode()
      if (!episode)
        break

      const item: PlaylistItem = {
        episode,
        startTime: currentTime,
        endTime: currentTime + (episode.duration * 1000),
      }

      this.playlist.push(item)
      currentTime = item.endTime
    }
  }

  public getCurrentItem(): PlaylistItem | null {
    const now = Date.now()

    // Find the current playing item
    const currentItem = this.playlist.find(item =>
      item.startTime <= now && item.endTime > now,
    )

    if (!currentItem) {
      // We've run out of playlist, generate more
      this.extendPlaylist()
      // Try one more time after extending
      return this.playlist.find(item =>
        item.startTime <= now && item.endTime > now,
      ) || null
    }

    // Extend playlist if we're getting close to the end (30 minutes instead of 1 hour)
    // This reduces the lookahead window for better memory efficiency
    const lastItem = this.playlist[this.playlist.length - 1]
    const EXTEND_THRESHOLD_MINUTES = 30
    if (lastItem && lastItem.endTime - now < EXTEND_THRESHOLD_MINUTES * 60 * 1000) {
      this.extendPlaylist()
    }

    return currentItem
  }

  public getPosition(): number {
    const currentItem = this.getCurrentItem()
    if (!currentItem)
      return 0

    const now = Date.now()
    const elapsed = now - currentItem.startTime
    return Math.floor(elapsed / 1000) // Return position in seconds
  }

  public getPlaylist(): PlaylistItem[] {
    return this.playlist
  }

  public getUpcomingItems(count: number = 10): PlaylistItem[] {
    const now = Date.now()
    return this.playlist
      .filter(item => item.startTime >= now)
      .slice(0, count)
  }

  private extendPlaylist() {
    const lastItem = this.playlist[this.playlist.length - 1]
    let currentTime = lastItem ? lastItem.endTime : Date.now()

    // Generate playlist for the next 2 hours only (reduced from 24 hours)
    // This is more memory efficient and adapts better to changes
    const EXTEND_LOOKAHEAD_HOURS = 2
    const endTime = currentTime + (EXTEND_LOOKAHEAD_HOURS * 60 * 60 * 1000)

    while (currentTime < endTime) {
      const episode = this.getNextEpisode()
      if (!episode)
        break

      const item: PlaylistItem = {
        episode,
        startTime: currentTime,
        endTime: currentTime + (episode.duration * 1000),
      }

      this.playlist.push(item)
      currentTime = item.endTime
    }

    // Clean up old items (keep only last 30 minutes of history instead of 1 hour)
    // This reduces memory footprint
    const HISTORY_KEEP_MINUTES = 30
    const cutoffTime = Date.now() - (HISTORY_KEEP_MINUTES * 60 * 1000)
    this.playlist = this.playlist.filter(item => item.endTime > cutoffTime)
  }

  public reloadShows(shows: Show[]) {
    this.shows = shows.filter(show => show.episodes.length > 0)
    this.showIndices.clear()
    this.currentShowIndex = 0
    this.initializeIndices()
  }
}
