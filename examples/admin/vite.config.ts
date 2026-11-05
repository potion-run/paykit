import { foldkit } from "@foldkit/vite-plugin";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [foldkit()],
  optimizeDeps: {
    entries: ["src/entry.ts"],
    // The Foldkit plugin excludes foldkit from pre-bundling, so its bare
    // imports of the Effect barrels are never discovered. Pre-bundle them, or
    // dev serves every Effect module as its own request.
    include: ["effect", "effect/Function", "effect/http", "effect/socket"],
  },
});
