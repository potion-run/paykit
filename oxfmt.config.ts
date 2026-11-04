import { defineConfig, type OxfmtConfig } from "oxfmt";

export default defineConfig({
  semi: true,
  singleQuote: false,
  tabWidth: 2,
  useTabs: false,
  printWidth: 100,
  endOfLine: "lf",
  trailingComma: "all",
  ternaries: true,
  sortPackageJson: true,
  insertFinalNewline: true,
  embeddedLanguageFormatting: "auto",
  sortImports: {
    newlinesBetween: false,
  },
  ignorePatterns: [
    "dist/**",
    "**/lib/**",
    "**/node_modules/**",
    "**/.agents/**",
    "**/*.md",
    "**/*.mdx",
  ],
} satisfies OxfmtConfig);
