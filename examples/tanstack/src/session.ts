/** The cookie the demo calls a session. A real deployment sets it after its own sign-in. */
export const ACCOUNT_COOKIE = "paykit_account";

/** The header the Billing Worker's development guard reads. */
export const ACTOR_HEADER = "x-paykit-actor";

/** One cookie's value, without a dependency on a browser or a runtime. */
export const cookieValue = (cookie: string | null, name: string): string | null => {
  if (cookie === null) return null;
  for (const part of cookie.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return null;
};

/** The account the browser's demo cookie names, or `null` before `/bootstrap`. */
export const accountFromCookie = (cookie: string | null): string | null =>
  cookieValue(cookie, ACCOUNT_COOKIE);
