/**
 * Pure-JS WCAG contrast unit test.
 * Hard-coded OKLCH→sRGB approximations for the neutral ramp.
 * These values document the n-300 token choice for WCAG AA on dark surfaces.
 */

// sRGB hex approximations derived from the OKLCH definitions in index.css
const COLORS = {
  "n-300": "#B3B6C8", // oklch(0.732 0.009 260) — raised muted-foreground
  "n-400": "#808497", // oklch(0.612 0.011 260) — old muted-foreground (below AA)
  "n-950": "#141419", // oklch(0.142 0.009 260) — background
  "n-850": "#222530", // oklch(0.215 0.011 260) — card
  "n-800": "#29293A", // oklch(0.252 0.012 260) — popover
};

function hexToLinear(hex: string): [number, number, number] {
  const r = Number.parseInt(hex.slice(1, 3), 16) / 255;
  const g = Number.parseInt(hex.slice(3, 5), 16) / 255;
  const b = Number.parseInt(hex.slice(5, 7), 16) / 255;
  const linearize = (c: number) =>
    c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  return [linearize(r), linearize(g), linearize(b)];
}

function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToLinear(hex);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(hex1: string, hex2: string): number {
  const l1 = relativeLuminance(hex1);
  const l2 = relativeLuminance(hex2);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

describe("WCAG AA contrast — muted-foreground token", () => {
  test("n-300 vs background (n-950) >= 4.5:1", () => {
    expect(
      contrastRatio(COLORS["n-300"], COLORS["n-950"]),
    ).toBeGreaterThanOrEqual(4.5);
  });

  test("n-300 vs card (n-850) >= 4.5:1", () => {
    expect(
      contrastRatio(COLORS["n-300"], COLORS["n-850"]),
    ).toBeGreaterThanOrEqual(4.5);
  });

  test("n-300 vs popover (n-800) >= 4.5:1", () => {
    expect(
      contrastRatio(COLORS["n-300"], COLORS["n-800"]),
    ).toBeGreaterThanOrEqual(4.5);
  });

  test("n-400 vs card (n-850) < 4.5:1 — documents the regression fixed by raising to n-300", () => {
    expect(contrastRatio(COLORS["n-400"], COLORS["n-850"])).toBeLessThan(4.5);
  });
});
