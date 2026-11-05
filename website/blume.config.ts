import { defineConfig } from "blume";

export default defineConfig({
  title: "Paykit",
  description: "Billing and entitlement for Alchemy, on Effect.",
  logo: "/logo.svg",
  github: {
    owner: "potion-run",
    repo: "paykit",
    dir: "website",
  },
  deployment: {
    // CHANGE_ME: the production origin, with no trailing slash. Blume uses it
    // for canonical URLs, the sitemap, Open Graph images, and llms.txt.
    site: "https://example.com",
  },
});
