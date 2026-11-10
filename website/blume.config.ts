import { defineConfig } from "blume";

export default defineConfig({
  title: "Paykit",
  description:
    "Billing and entitlements for your product, declared in TypeScript and deployed with your stack.",
  logo: "/logo.svg",
  github: {
    owner: "potion-run",
    repo: "paykit",
    dir: "website",
  },
  markdown: {
    code: {
      wrap: true,
    },
  },
  theme: {
    // A serif display face over Inter and JetBrains Mono, the way the Alchemy
    // docs pair them: headings carry the point, code carries the detail.
    accent: "#4e6b34",
    mode: "system",
    fonts: {
      display: "source-serif-4",
      body: "inter",
      mono: "jetbrains-mono",
    },
  },
  deployment: {
    // CHANGE_ME: the production origin, with no trailing slash. Blume uses it
    // for canonical URLs, the sitemap, Open Graph images, and llms.txt.
    site: "https://example.com",
  },
  redirects: [
    { from: "/quickstart", to: "/getting-started" },
    { from: "/auth", to: "/hosting/auth" },
    { from: "/database", to: "/hosting/database" },
    { from: "/packages", to: "/reference/packages" },
    { from: "/catalog/pricing-models", to: "/concepts/pricing-models" },
    { from: "/catalog/features", to: "/concepts/features" },
    { from: "/catalog/plans", to: "/concepts/plans" },
    { from: "/catalog/credits", to: "/concepts/credits" },
    { from: "/entitlement/check", to: "/runtime/check" },
    { from: "/entitlement/balances", to: "/concepts/balances" },
    { from: "/usage/commands", to: "/runtime/commands" },
    { from: "/usage/track-usage", to: "/runtime/track-usage" },
    { from: "/usage/holds", to: "/runtime/holds" },
  ],
});
