import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
export default defineConfig({
  resolve: { dedupe: ["react", "react-dom"] },
  plugins: [react()],
  server: { host: "127.0.0.1", fs: { allow: ["../.."] } },
  test: {
    environment: "jsdom",
    setupFiles: ["../web/test-setup.ts"],
    restoreMocks: true,
  },
});
