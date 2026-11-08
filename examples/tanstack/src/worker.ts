import serverEntry from "@tanstack/react-start/server-entry";
import { ACCOUNT_COOKIE, accountFromCookie, ACTOR_HEADER } from "./session.ts";

interface Fetcher {
  fetch(request: Request): Promise<Response>;
}

interface Env {
  readonly BILLING: Fetcher;
}

/** A fresh development account. A deployment takes this from its identity provider. */
const newAccount = (): string => `acct_${crypto.randomUUID()}`;

/**
 * Forward a billing request to the Billing Worker with the visitor's actor
 * header. The cookie is the browser's; the header is the deployment's, and the
 * Billing Worker never trusts a header that did not come over the binding.
 *
 * The atom client only needs cookies to be same-origin. This entry is what
 * makes them sufficient: no CORS, no public billing URL, and the atom client
 * never sends an actor header of its own.
 */
const forward = async (request: Request, env: Env): Promise<Response> => {
  const cookie = request.headers.get("cookie");
  const existing = accountFromCookie(cookie);
  const account = existing ?? newAccount();

  const headers = new Headers(request.headers);
  headers.set(ACTOR_HEADER, account);
  const response = await env.BILLING.fetch(new Request(request, { headers }));

  if (existing !== null) return response;

  // The first response mints the demo session. Only this entry reads it, so it
  // is `HttpOnly`; a real deployment sets it after its own sign-in.
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  const headersOut = new Headers(response.headers);
  headersOut.append(
    "set-cookie",
    `${ACCOUNT_COOKIE}=${account}; Path=/; SameSite=Lax; HttpOnly${secure}`,
  );

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: headersOut,
  });
};

/**
 * The Website's Worker. TanStack Start owns every rendered route; the Billing
 * Worker owns `/api/billing` and `/bootstrap`, reached over the service
 * binding. `assets.runWorkerFirst` in `alchemy.run.ts` is what sends those
 * paths here instead of to the asset router.
 */
export default {
  fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);

    if (
      pathname === "/bootstrap" ||
      pathname === "/api/billing" ||
      pathname.startsWith("/api/billing/")
    ) {
      return forward(request, env);
    }

    return Promise.resolve(serverEntry.fetch(request));
  },
};
