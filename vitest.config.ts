import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@printgo/api-contract": fileURLToPath(
        new URL("./packages/api-contract/src/index.ts", import.meta.url),
      ),
      "@printgo/domain": fileURLToPath(
        new URL("./packages/domain/src/index.ts", import.meta.url),
      ),
      "@printgo/pricing": fileURLToPath(
        new URL("./packages/pricing/src/index.ts", import.meta.url),
      ),
      "@printgo/auth": fileURLToPath(
        new URL("./packages/auth/src/index.ts", import.meta.url),
      ),
      "@printgo/validation": fileURLToPath(
        new URL("./packages/validation/src/index.ts", import.meta.url),
      ),
      "@printgo/shared": fileURLToPath(
        new URL("./packages/shared/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    coverage: { reporter: ["text", "html"] },
    include: ["{apps,packages,tests}/**/*.{test,spec}.{ts,tsx}"],
    passWithNoTests: false,
  },
});
