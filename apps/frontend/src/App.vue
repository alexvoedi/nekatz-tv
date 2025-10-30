<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3000'

const videoRef = ref<HTMLVideoElement | null>(null)
let currentEpisodePath: string | null = null
let checkInterval: ReturnType<typeof setInterval> | null = null
const hasUserInteracted = ref(false)
let isLoadingNewEpisode = false
let loadingTimeout: ReturnType<typeof setTimeout> | null = null

async function syncToCurrentPosition() {
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

        // Build stream URL with start position (backend handles seeking server-side)
        let videoUrl = `${BACKEND_URL}/api/stream`
        if (data.position > 0) {
          videoUrl += `?start=${Math.floor(data.position)}`
        }

        videoRef.value.src = videoUrl
        console.log(`Loading video: ${videoUrl}`)

        // Wait for metadata, then play
        const onLoadedMetadata = async () => {
          console.log('Metadata loaded, playing video')

          if (loadingTimeout) {
            clearTimeout(loadingTimeout)
            loadingTimeout = null
          }

          // Try to play (handle autoplay policy)
          try {
            await videoRef.value!.play()
            hasUserInteracted.value = true
          }
          catch (err) {
            console.warn('Autoplay blocked, playing muted:', err)
            videoRef.value!.muted = true
            await videoRef.value!.play().catch(e => console.error('Autoplay failed:', e))
          }

          isLoadingNewEpisode = false
        }

        videoRef.value.addEventListener('loadedmetadata', onLoadedMetadata, { once: true })

        // Fallback timeout
        loadingTimeout = setTimeout(() => {
          console.warn('Metadata loading timeout')
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
    preload="metadata"
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
