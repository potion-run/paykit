import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Alchemy injects the Cloudflare plugin and points the SSR environment at
// `src/worker.ts`; this file only declares the framework. The same config runs
// under the local dev command and in the deploy build.
export default defineConfig({
  plugins: [tanstackStart(), viteReact()],
});
