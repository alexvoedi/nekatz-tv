export interface Episode {
  path: string
  filename: string
  showName: string
  season: number
  episode: number
  part: string // 'a', 'b', 'c', or empty string for no part
  duration: number // in seconds
}

export interface Show {
  name: string
  episodes: Episode[]
}

export interface PlaylistItem {
  episode: Episode
  startTime: number // Unix timestamp when this episode started
  endTime: number // Unix timestamp when this episode ends
}

export interface CurrentState {
  currentItem: PlaylistItem | null
  position: number // Current position in seconds
  playlist: PlaylistItem[]
}
