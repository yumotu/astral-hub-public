import { defineConfig } from 'vite';
export default defineConfig({
  root: 'web',
  base: './',
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        // Android's asset server reliably recognizes .js as a module script.
        assetFileNames: (asset) =>
          asset.names.some((name) => name.endsWith('pdf.worker.min.mjs'))
            ? 'assets/pdf.worker-[hash].js'
            : 'assets/[name]-[hash][extname]',
      },
    },
  },
  server: {
    port: 5188,
    strictPort: true,
    proxy: { '/api': 'http://127.0.0.1:8787' },
    fs: { allow: ['..'] },
  },
});
