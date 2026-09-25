import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  server: { port: 5174, strictPort: true },
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["icon.svg"],
      workbox: {
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [],
      },
      manifest: {
        name: "PrintGo Admin",
        short_name: "PrintGo Admin",
        description: "Operate a PrintGo shop installation.",
        theme_color: "#172554",
        background_color: "#f8fafc",
        display: "standalone",
        start_url: "/admin",
        icons: [
          {
            src: "/icon.svg",
            sizes: "any",
            type: "image/svg+xml",
            purpose: "any maskable",
          },
        ],
      },
    }),
  ],
});
