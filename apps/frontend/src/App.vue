<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3000'

const videoRef = ref<HTMLVideoElement | null>(null)
let currentEpisodePath: string | null = null
let checkInterval: ReturnType<typeof setInterval> | null = null
const hasUserInteracted = ref(false)
let isLoadingNewEpisode = false // Prevent concurrent loads
let loadingTimeout: ReturnType<typeof setTimeout> | null = null

async function syncToCurrentPosition() {
  // Prevent concurrent sync calls
  if (isLoadingNewEpisode)
    return

  try {
    const response = await fetch(`${BACKEND_URL}/api/current`)
    const data = await response.json()

    if (videoRef.value && data.currentItem) {
      const newEpisodePath = data.currentItem.episode.path

      // Only reload video if the episode changed
      if (currentEpisodePath !== newEpisodePath) {
        console.log('Loading new episode:', data.currentItem.episode.filename)
        isLoadingNewEpisode = true
        currentEpisodePath = newEpisodePath

        // Clear any existing timeout
        if (loadingTimeout) {
          clearTimeout(loadingTimeout)
          loadingTimeout = null
        }

        // For transcoded streams, we MUST use the start parameter
        // For non-transcoded, browser can handle seeking with Range requests
        const startParam = data.position > 0 ? `?start=${Math.floor(data.position)}` : ''
        videoRef.value.src = `${BACKEND_URL}/api/stream${startParam}`

        console.log(`Loading video with start parameter: ${startParam}`)

        // Wait for metadata to load, then seek to position
        const onLoadedMetadata = async () => {
          console.log('Metadata loaded, readyState:', videoRef.value?.readyState)

          // Clear timeout since we successfully loaded
          if (loadingTimeout) {
            clearTimeout(loadingTimeout)
            loadingTimeout = null
          }

          // Try to play first (for autoplay policy)
          try {
            await videoRef.value!.play()
            hasUserInteracted.value = true
            console.log('Video playing')
          }
          catch (err) {
            console.warn('Autoplay blocked, playing muted:', err)
            videoRef.value!.muted = true
            try {
              await videoRef.value!.play()
              console.log('Video playing muted')
            }
            catch (mutedErr) {
              console.error('Autoplay failed even when muted:', mutedErr)
            }
          }

          // For transcoded streams, the backend already seeked server-side
          // For non-transcoded, we need to seek client-side ASAP
          if (videoRef.value && data.position > 0) {
            // Seek immediately after play starts
            console.log(`Seeking to ${data.position}s`)
            videoRef.value.currentTime = data.position

            // Verify after a short delay
            setTimeout(() => {
              if (videoRef.value && Math.abs(videoRef.value.currentTime - data.position) > 5) {
                console.log(`Position mismatch detected, re-seeking from ${videoRef.value.currentTime}s to ${data.position}s`)
                videoRef.value.currentTime = data.position
              }
              else {
                console.log(`Position correct: ${videoRef.value?.currentTime}s (target: ${data.position}s)`)
              }
            }, 1000)
          }

          isLoadingNewEpisode = false
        }

        videoRef.value.addEventListener('loadedmetadata', onLoadedMetadata, { once: true })

        // Fallback: Reset flag after timeout in case metadata never loads
        loadingTimeout = setTimeout(() => {
          console.warn('Metadata loading timeout - resetting flag')
          isLoadingNewEpisode = false
          loadingTimeout = null
        }, 5000)
      }
    }
  }
  catch (err) {
    console.error('Failed to sync:', err)
    isLoadingNewEpisode = false
    if (loadingTimeout) {
      clearTimeout(loadingTimeout)
      loadingTimeout = null
    }
  }
}

function handleEnded() {
  // Video ended, check for next episode
  syncToCurrentPosition()
}

function handleUserInteraction() {
  // When user interacts with video controls, unmute if needed
  if (videoRef.value?.muted && hasUserInteracted.value === false) {
    hasUserInteracted.value = true
  }
}

onMounted(() => {
  syncToCurrentPosition()

  // Check every 30 seconds if we need to switch episodes
  checkInterval = setInterval(() => {
    syncToCurrentPosition()
  }, 30000)

  // Handle video end
  if (videoRef.value) {
    videoRef.value.addEventListener('ended', handleEnded)
    videoRef.value.addEventListener('click', handleUserInteraction)
    videoRef.value.addEventListener('play', handleUserInteraction)
  }
})

onUnmounted(() => {
  if (checkInterval) {
    clearInterval(checkInterval)
  }
  if (loadingTimeout) {
    clearTimeout(loadingTimeout)
  }
  if (videoRef.value) {
    videoRef.value.removeEventListener('ended', handleEnded)
    videoRef.value.removeEventListener('click', handleUserInteraction)
    videoRef.value.removeEventListener('play', handleUserInteraction)
  }
})
</script>

<template>
  <video
    ref="videoRef"
    controls
    autoplay
    playsinline
  />
</template>

<style>
html, body, #app {
  height: 100dvh;
  margin: 0;
  padding: 0;
  overflow: hidden;
  background: #000;
}

video {
  width: 100%;
  height: 100%;
  object-fit: contain;
}
</style>
