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
    // Tailscale Serve proxies to IPv4 loopback, so avoid localhost resolving to ::1.
    host: "127.0.0.1",
    // Tailscale Serve terminates HTTPS and proxies a private *.ts.net URL here.
    allowedHosts: [".ts.net"],
    port: 5173,
    strictPort: true,
  },
});
