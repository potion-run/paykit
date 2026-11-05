/**
 * The site's mark, drawn once for every place it appears: the header and the
 * docs layout (Logo.astro) and the social cards (src/pages/og/_card.ts).
 * It is a ledger: one spine and three entries. Keep it a single-colour mark;
 * each place fills it with its own text colour.
 */
export const logo = {
  /** The drawing's box; callers size it by height and keep the ratio. */
  width: 32,
  height: 20,
  paths: ["M2 2h4v16H2z", "M9 4h21v3H9z", "M9 8.5h15v3H9z", "M9 13h21v3H9z"],
};
