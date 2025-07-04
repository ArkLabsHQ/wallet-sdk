import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        globals: true,
        environment: "node",
        setupFiles: ["./test/setup-polyfills.js"],
        coverage: {
            provider: "v8",
            reporter: ["text", "html"],
            exclude: [
                "node_modules/**",
                "dist/**",
                "**/*.test.ts",
                "**/*.spec.ts",
                "**/__tests__/**",
            ],
        },
    },
});
