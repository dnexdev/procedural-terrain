import { defineConfig } from 'vite'

export default defineConfig({
  // Relative asset paths, so the build works from any sub path (GitHub Pages).
  base: './',
  build: { target: 'es2022', chunkSizeWarningLimit: 800 },
  test: { environment: 'node' },
})
