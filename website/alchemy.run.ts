import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";

/**
 * The docs site as an Alchemy stack: one static Blume build, deployed as a
 * Cloudflare Worker whose assets are the output. The Blume build writes
 * `dist/`, so `StaticSite` runs it and hashes the result; there is no separate
 * Wrangler config to keep in step.
 */
export default Alchemy.Stack(
  "PaykitDocs",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const docs = yield* Cloudflare.Website.StaticSite("Docs", {
      command: "pnpm build",
      outdir: "dist",
      assets: {
        notFoundHandling: "404-page",
      },
      dev: {
        command: "pnpm dev",
      },
    });

    return {
      url: docs.url.as<string>(),
    };
  }),
);
