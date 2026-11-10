import { pro } from "./catalog.ts";

/**
 * A one-page client for the example. It uses Better Auth's own HTTP routes for
 * sign-up and sign-in, then shows the session and the checkout path the paykit
 * Api sees. The tenant Api itself is RPC, not REST: use the
 * `BillingApi.clientInProcess` / `layerClientHttp` client from an app, or the
 * test's calls, rather than hand-writing JSON frames.
 *
 * The checkout link names the plan the catalog declares, so the page cannot
 * advertise a tier this deployment does not sell.
 */
export const Page = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>paykit + Better Auth</title>
  <style>
    :root { color-scheme: light dark; font: 15px/1.5 ui-sans-serif, system-ui, sans-serif; }
    body { max-width: 44rem; margin: 3rem auto; padding: 0 1rem; }
    fieldset { border: 1px solid color-mix(in srgb, currentColor 20%, transparent); border-radius: .5rem; padding: 1rem; margin: 1rem 0; }
    label { display: block; margin: .5rem 0 .25rem; }
    input { width: 100%; padding: .5rem; box-sizing: border-box; }
    button { margin-top: .75rem; padding: .5rem .9rem; cursor: pointer; }
    pre { background: color-mix(in srgb, currentColor 8%, transparent); padding: .75rem; border-radius: .4rem; overflow: auto; }
    code { font-size: .9em; }
  </style>
</head>
<body>
  <h1>paykit + Better Auth</h1>
  <p>
    Better Auth answers <code>/api/auth/*</code>. The paykit Api answers
    <code>/api/*</code> and <code>/admin/*</code>, and both read the Better
    Auth session cookie.
  </p>

  <fieldset>
    <legend>Create an account</legend>
    <form id="signup">
      <label>Name <input name="name" value="Example User" required /></label>
      <label>Email <input name="email" type="email" required /></label>
      <label>Password <input name="password" type="password" minlength="8" required /></label>
      <button>Sign up</button>
    </form>
  </fieldset>

  <fieldset>
    <legend>Sign in</legend>
    <form id="signin">
      <label>Email <input name="email" type="email" required /></label>
      <label>Password <input name="password" type="password" required /></label>
      <button>Sign in</button>
    </form>
  </fieldset>

  <fieldset>
    <legend>Try the gated routes</legend>
    <button id="session">GET /api/auth/get-session</button>
    <button id="checkout">GET /checkout?tier=${pro.id}</button>
    <button id="signout">POST /api/auth/sign-out</button>
    <pre id="out">Not called yet.</pre>
  </fieldset>

  <script>
    const out = document.querySelector("#out");
    const show = (value) => {
      out.textContent = typeof value === "string" ? value : JSON.stringify(value, null, 2);
    };
    const postForm = async (path, form) => {
      const response = await fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(Object.fromEntries(new FormData(form))),
      });
      show({ status: response.status, body: await response.json().catch(() => null) });
    };
    const call = async (path, init) => {
      const response = await fetch(path, init);
      const text = await response.text();
      try { show({ status: response.status, body: JSON.parse(text) }); }
      catch { show({ status: response.status, body: text }); }
    };

    document.querySelector("#signup").addEventListener("submit", (event) => {
      event.preventDefault();
      postForm("/api/auth/sign-up/email", event.currentTarget).catch((error) => show(String(error)));
    });
    document.querySelector("#signin").addEventListener("submit", (event) => {
      event.preventDefault();
      postForm("/api/auth/sign-in/email", event.currentTarget).catch((error) => show(String(error)));
    });
    document.querySelector("#session").addEventListener("click", () => call("/api/auth/get-session"));
    document.querySelector("#checkout").addEventListener("click", () => call("/checkout?tier=${pro.id}"));
    document.querySelector("#signout").addEventListener("click", () =>
      call("/api/auth/sign-out", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }),
    );
  </script>
</body>
</html>`;
