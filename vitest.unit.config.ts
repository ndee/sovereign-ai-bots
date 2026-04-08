import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "bots/*/src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      enabled: true,
      all: true,
      reportsDirectory: "coverage/unit",
      reporter: ["text-summary", "json-summary", "lcov"],
      include: ["src/catalog/validate.ts", "src/probe/mail-sentinel-chat-model.ts"],
      thresholds: {
        statements: 100,
        branches: 100,
        functions: 100,
        lines: 100
      }
    }
  }
});
