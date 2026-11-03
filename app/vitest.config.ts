import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: { environment: "node", fileParallelism: false, testTimeout: 60_000, hookTimeout: 120_000, include: ["tests/**/*.test.ts"] },
});
