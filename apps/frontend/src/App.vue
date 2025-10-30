<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3000'

const videoRef = ref<HTMLVideoElement | null>(null)
let currentEpisodePath: string | null = null
let checkInterval: ReturnType<typeof setInterval> | null = null
const hasUserInteracted = ref(false)

async function syncToCurrentPosition() {
  try {
    const response = await fetch(`${BACKEND_URL}/api/current`)
    const data = await response.json()

    if (videoRef.value && data.currentItem) {
      const newEpisodePath = data.currentItem.episode.path

      // Only reload video if the episode changed
      if (currentEpisodePath !== newEpisodePath) {
        console.log('Loading new episode:', data.currentItem.episode.filename)
        currentEpisodePath = newEpisodePath
        // Pass the start position to the backend for transcoded streams
        videoRef.value.src = `${BACKEND_URL}/api/stream?start=${data.position}&t=${Date.now()}`

        // Try to play - if autoplay is blocked, mute and try again
        try {
          await videoRef.value.play()
          hasUserInteracted.value = true
        }
        catch (err) {
          console.warn('Autoplay blocked, playing muted:', err)
          videoRef.value.muted = true
          try {
            await videoRef.value.play()
          }
          catch (mutedErr) {
            console.error('Autoplay failed even when muted:', mutedErr)
          }
        }
      }
      // Don't seek if it's the same episode - the backend already handles the position
    }
  }
  catch (err) {
    console.error('Failed to sync:', err)
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
