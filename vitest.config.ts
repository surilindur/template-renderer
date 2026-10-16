import { compilerOptions } from "./tsconfig.json" with { type: "json" };
import { defineConfig } from "vitest/config";
import { playwright } from "@vitest/browser-playwright";

const browsers: ("chromium" | "firefox" | "webkit")[] = ["chromium", "firefox", "webkit"];

export default defineConfig({
  build: {
    target: compilerOptions.target,
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
});
