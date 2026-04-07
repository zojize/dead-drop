import process from 'node:process'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  base: process.env.VITE_BASE ?? '/',
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
})
