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
    "**/.claude/**",
    "**/.codex/**",
    "**/.continue/**",
    "**/.cursor/**",
    "**/.gemini/**",
    "**/.opencode/**",
    "**/.pi/**",
    "**/.roo/**",
    "**/.windsurf/**",
    "**/.agent_sources/**",
    "**/.agent-sources/**",
    // The vendored anti-slop plugin is upstream source; its provenance record
    // is `tools/oxlint/anti-slop/UPSTREAM.md`.
    "tools/oxlint/anti-slop/**",
    "**/*.md",
    "**/*.mdx",
    // TanStack Router owns this file: it is emitted with single quotes and no
    // semicolons, and reformatting it only makes the next generation a diff.
    "**/routeTree.gen.*",
  ],
} satisfies OxfmtConfig);
