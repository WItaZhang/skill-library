import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  server: { fs: { allow: [".."] } },
  test: {
    environment: "jsdom",
    setupFiles: ["../modules/web/test-setup.ts"],
    include: ["Product.test.tsx"],
  },
});
