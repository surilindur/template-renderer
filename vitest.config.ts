import { defineConfig } from "vitest/config";
import { nodePolyfills } from "vite-plugin-node-polyfills";
import { playwright } from "@vitest/browser-playwright";
import tsconfig from "./tsconfig.json" with { type: "json" };

const browsers: ("chromium" | "firefox" | "webkit")[] = ["chromium", "firefox", "webkit"];

export default defineConfig({
  build: {
    target: tsconfig.compilerOptions.target,
  },
  test: {
    coverage: {
      enabled: true,
      provider: "istanbul",
      thresholds: {
        autoUpdate: true,
        branches: 100,
        functions: 100,
        lines: 100,
        perFile: true,
        statements: 100,
      },
    },
    projects: [
      ...browsers.map((browser) => ({
        test: {
          browser: {
            enabled: true,
            headless: true,
            instances: [{ browser }],
            provider: playwright(),
            screenshotFailures: false,
          },
          name: browser,
        },
      })),
      {
        test: {
          environment: "node",
          name: "node",
        },
      },
    ],
    include: ["test/**/*.test.ts"],
  },
  plugins: [
    nodePolyfills({
      include: ["events"],
    }),
  ],
});
