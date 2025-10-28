export interface Episode {
  path: string
  filename: string
  showName: string
  season: number
  episode: number
  part: string
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
