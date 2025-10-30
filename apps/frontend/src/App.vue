<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3000'

const videoRef = ref<HTMLVideoElement | null>(null)
let currentEpisodePath: string | null = null
let checkInterval: ReturnType<typeof setInterval> | null = null

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
        videoRef.value.play().catch(err => console.error('Autoplay failed:', err))
      }
      else {
        // Same episode, just seek to the current position
        videoRef.value.currentTime = data.position
        videoRef.value.play().catch(err => console.error('Autoplay failed:', err))
      }
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

onMounted(() => {
  syncToCurrentPosition()

  // Check every 30 seconds if we need to switch episodes
  checkInterval = setInterval(() => {
    syncToCurrentPosition()
  }, 30000)

  // Handle video end
  if (videoRef.value) {
    videoRef.value.addEventListener('ended', handleEnded)
  }
})

onUnmounted(() => {
  if (checkInterval) {
    clearInterval(checkInterval)
  }
  if (videoRef.value) {
    videoRef.value.removeEventListener('ended', handleEnded)
  }
})
</script>

<template>
  <video
    ref="videoRef"
    controls
    autoplay
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
