import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
export default defineConfig({
  resolve: { dedupe: ["react", "react-dom"] },
  plugins: [react()],
  server: { fs: { allow: [".."] } },
  test: {
    environment: "jsdom",
    setupFiles: ["./test-setup.ts"],
    include: ["Product.test.tsx"],
  },
});
