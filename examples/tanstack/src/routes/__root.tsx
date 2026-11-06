import { RegistryProvider } from "@effect/atom-react";
import { createRootRoute, HeadContent, Outlet, Scripts } from "@tanstack/react-router";
import type { ReactNode } from "react";
import appCss from "../app.css?url";

/**
 * The document, and the one Atom registry the page shares. Every paykit atom —
 * the entitlement query and every command — reads and writes through it, which
 * is what makes a command's reactivity key refresh the view.
 */
export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "paykit on TanStack Start" },
    ],
    links: [{ rel: "stylesheet", href: appCss }],
  }),
  component: Root,
});

function Root() {
  return (
    <RegistryProvider>
      <Document>
        <Outlet />
        <Scripts />
      </Document>
    </RegistryProvider>
  );
}

function Document({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>{children}</body>
    </html>
  );
}
