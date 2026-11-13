// ═══════════════════════════════════════════════════════════════════════════
// ROUND 198 — THE DASHBOARD'S FONT, IN ONE PLACE.
//
// Changing the font is this one line. app/layout.tsx loads the family from
// Google Fonts and sets it as `--font` on <html>, which every rule already
// reads (globals.css: body{font-family:var(--font)}). The system fonts after it
// are the fallback while it loads, or if Google Fonts is blocked.
//
// Candidates compared in the round 198 notes: "Inter" (rounds 1–197),
// "DM Sans", "Instrument Sans", "Geist", "Figtree".
// ═══════════════════════════════════════════════════════════════════════════
export const UI_FONT = "DM Sans";

/** Weights the dashboard uses: 400 text, 500 labels, 600 names and titles, 700 counts. */
export const UI_FONT_WEIGHTS = [400, 500, 600, 700];

export const uiFontHref = (family = UI_FONT) =>
  `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family).replace(/%20/g, "+")}:wght@${UI_FONT_WEIGHTS.join(";")}&display=swap`;

export const uiFontStack = (family = UI_FONT) =>
  `"${family}",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif`;
