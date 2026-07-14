import { defineConfig } from "vite";

const kvsPackageVersion = JSON.stringify("2.8.1");

export default defineConfig({
  define: {
    // The KVS WebRTC SDK exposes its version through this Node.js-style value.
    // Vite does not provide a global `process` object in the browser.
    "process.env.PACKAGE_VERSION": kvsPackageVersion,
  },
  optimizeDeps: {
    rolldownOptions: {
      transform: {
        define: {
          "process.env.PACKAGE_VERSION": kvsPackageVersion,
        },
      },
    },
  },
  resolve: {
    alias: {
      events: "events/",
    },
  },
  server: {
    host: "localhost",
    port: 5173,
    strictPort: true,
  },
});
