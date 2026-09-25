import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@printgo/api-contract": fileURLToPath(
        new URL("./packages/api-contract/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    coverage: { reporter: ["text", "html"] },
    include: ["{apps,packages,tests}/**/*.{test,spec}.{ts,tsx}"],
    passWithNoTests: false,
  },
});
