import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: process.env.VITE_BASE ?? '/',
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
})
