import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/*
// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
})
*/

// Config for Nginx:
export default defineConfig({
	  plugins: [react()],
	  server: {
		host: '127.0.0.1',
		port: 5173,
		strictPort: true,
	
		proxy: {
		  '/api': {
			target: 'http://127.0.0.1:3000',
			changeOrigin: true,
		  },
		},
	  },
	})
