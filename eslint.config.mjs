import antfu from '@antfu/eslint-config'

export default antfu({
  typescript: {
    overrides: {
      'no-console': 'off',
    },
  },
  vue: {
    overrides: {
      'vue/max-attributes-per-line': ['error', {
        singleline: 5,
        multiline: 1,
      }],
    },
  },
  unicorn: true,
  imports: true,
  gitignore: true,
  markdown: true,
  pnpm: true,
})
