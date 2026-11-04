interface Fetcher {
  fetch(request: Request): Promise<Response>;
}

/**
 * The app's Worker: the client build, plus `/admin` and `/console` forwarded
 * to the admin Worker over a service binding. One origin for both, so the
 * session cookie reaches commands and every live read's WebSocket.
 */
export default {
  fetch(request: Request, env: { readonly ASSETS: Fetcher; readonly BILLING: Fetcher }) {
    const { pathname } = new URL(request.url);
    return pathname.startsWith("/admin") || pathname.startsWith("/console")
      ? env.BILLING.fetch(request)
      : env.ASSETS.fetch(request);
  },
};
