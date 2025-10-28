import { createHead } from '@vueuse/head'
import { createApp } from 'vue'
import App from './App.vue'

const app = createApp(App)

app.use(createHead())

app.mount('#app')
