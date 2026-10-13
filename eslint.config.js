import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "**/coverage/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/consistent-type-imports": "error",
      "no-console": ["error", { allow: ["warn", "error"] }],
    },
  },
  {
    // Command-line tools: Node globals, and their output is what they are for.
    files: ["scripts/**/*.mjs"],
    languageOptions: { globals: { console: "readonly", process: "readonly" } },
    rules: { "no-console": "off" },
  },
);
