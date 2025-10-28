import path from 'node:path'
import Vue from '@vitejs/plugin-vue'
import AutoImport from 'unplugin-auto-import/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  base: '/',
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  plugins: [
    Vue(),

    // https://github.com/antfu/unplugin-auto-import
    AutoImport({
      imports: [
        'vue',
      ],
      dts: 'src/types/auto-import.d.ts',

      vueTemplate: true,
      eslintrc: {
        enabled: true,
        filepath: path.resolve(__dirname, '.eslintrc-auto-import.json'),
      },
    }),
  ],

  server: {
    host: true,
  },

  clearScreen: false,
})
