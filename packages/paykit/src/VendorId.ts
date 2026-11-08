/**
 * Escape one part of a vendor identity — a stage, a tier, a feature — so it
 * cannot forge the `:` separator another part uses, and stays inside the
 * vendor's name/lookup-key alphabet. Alphanumerics and dashes survive;
 * everything else (including `_`) becomes a `_<hex>_` escape.
 *
 * The vendor packages in this repo share one implementation, so a Stripe
 * lookup key and a Polar product name cannot disagree about an account's
 * identity.
 */
export const encodeVendorPart = (value: string): string => {
  let encoded = "";

  for (const char of value) {
    encoded += /[A-Za-z0-9-]/.test(char) ? char : `_${char.codePointAt(0)!.toString(16)}_`;
  }

  return encoded;
};
