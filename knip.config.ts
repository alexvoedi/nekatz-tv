import type { KnipConfig } from 'knip'

const config: KnipConfig = {
  workspaces: {
    'apps/backend': {
      entry: ['src/main.ts'],
      project: ['**/*.ts'],
    },
    'apps/frontend': {
      entry: ['src/main.ts'],
      project: ['**/*.{ts,vue}'],
    },
  },
}

export default config
