export const UI_FONT = "DM Sans";

export const UI_FONT_WEIGHTS = [400, 500, 600, 700];

export const uiFontHref = (family = UI_FONT) =>
  `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family).replace(/%20/g, "+")}:wght@${UI_FONT_WEIGHTS.join(";")}&display=swap`;

export const uiFontStack = (family = UI_FONT) =>
  `"${family}",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif`;
