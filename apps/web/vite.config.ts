import { defineConfig } from "vite";

const GATEWAY = "http://127.0.0.1:7420";

export default defineConfig({
  oxc: { jsx: { runtime: "automatic", importSource: "preact" } },
  build: { outDir: "dist", emptyOutDir: true, modulePreload: { polyfill: false } },
  server: {
    // Dev only: proxy the API and present the gateway's own origin, so its Host/Origin
    // checks pass. The built UI is served by the gateway itself.
    proxy: {
      "/api": {
        target: GATEWAY,
        changeOrigin: true,
        configure: (proxy) =>
          proxy.on("proxyReq", (req) => {
            if (req.getHeader("origin")) req.setHeader("origin", GATEWAY);
          }),
      },
    },
  },
});
