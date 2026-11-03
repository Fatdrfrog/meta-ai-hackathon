/** @jest-environment node */
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The Products tokens' contrast, read from the CSS itself, so a token edit
// can't quietly drop a chip or a chosen control under WCAG's bar. Colours
// mixed with transparent are laid over their surface in sRGB, as browsers
// paint them.

const css = (file: string) => readFileSync(join(__dirname, file), "utf8");
const theme = css("product-theme.module.css");
const controls = css("product-controls.module.css");
const studio = css("product-ad-studio.module.css");
const globals = readFileSync(
  join(__dirname, "..", "..", "app", "globals.css"),
  "utf8"
);

/** The declarations of the first rule whose selector is exactly `selector`. */
function block(source: string, selector: string): string {
  const start = source.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`No ${selector} rule`);
  return source.slice(start, source.indexOf("\n}", start));
}

const LIGHT = block(theme, ".theme");
const DARK = block(theme, ":global(.dark) .theme");

function token(source: string, name: string): string {
  const found = new RegExp(`${name}:\\s*([^;]+);`).exec(source);
  if (!found) throw new Error(`No ${name}`);
  return found[1]!.trim();
}

type Rgb = [number, number, number];
const hex = (value: string): Rgb => {
  const match = /^#([0-9a-f]{6})$/i.exec(value);
  if (!match) throw new Error(`Not a hex colour: ${value}`);
  return [0, 2, 4].map(at => parseInt(match[1]!.slice(at, at + 2), 16)) as Rgb;
};
/** The percentage of a `color-mix(in oklab, X N%, transparent)`. */
const share = (value: string) => {
  const match = /(\d+(?:\.\d+)?)%,\s*transparent\)/.exec(value);
  if (!match) throw new Error(`Not a mix with transparent: ${value}`);
  return Number(match[1]) / 100;
};
const over = (top: Rgb, alpha: number, under: Rgb): Rgb =>
  top.map((c, i) => Math.round(c * alpha + under[i]! * (1 - alpha))) as Rgb;
const luminance = (rgb: Rgb) =>
  rgb
    .map(c => c / 255)
    .map(c => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
    .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i]!, 0);
const contrast = (a: Rgb, b: Rgb) => {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (high! + 0.05) / (low! + 0.05);
};

const SURFACES = ["--p-paper", "--p-raised", "--p-sunk", "--p-wall"];

/** The surfaces where `ratioOn` falls under `floor`, with the ratio: none, to pass. */
const under = (
  source: string,
  floor: number,
  ratioOn: (surface: Rgb) => number
) =>
  SURFACES.map(name => [name, ratioOn(hex(token(source, name)))] as const)
    .filter(([, ratio]) => ratio < floor)
    .map(([name, ratio]) => `${name} ${ratio.toFixed(2)}`);

test("the ok chip's green text reads at 4.5:1 on its wash, on every light surface", () => {
  // Airi's green on its own 9% wash was 4.46:1 on paper and 4.19 on sunk.
  expect(controls).toMatch(
    /\.chip\[data-tone="ok"\] \{\s*color: var\(--p-ok-chip-ink\);/
  );
  const green = hex(token(globals, "--airi-green-ink"));
  const ink = hex(token(LIGHT, "--p-ok-chip-ink"));
  const wash = share(token(LIGHT, "--p-ok-wash"));
  expect(
    under(LIGHT, 4.5, surface => contrast(ink, over(green, wash, surface)))
  ).toEqual([]);
  // Dark mode keeps its own light green, 7.5:1 on its wash.
  expect(token(DARK, "--p-ok-chip-ink")).toBe("var(--p-ok-ink)");
});

test("a chosen control's outline is 3:1 on every surface, in both themes", () => {
  const line = share(token(LIGHT, "--p-pick-line"));
  for (const source of [LIGHT, DARK]) {
    const ink = hex(token(source, "--p-ink"));
    expect(
      under(source, 3, surface => contrast(over(ink, line, surface), surface))
    ).toEqual([]);
  }
  // The active segment is marked by it, against the sunk track.
  expect(block(controls, '.segmented button[aria-pressed="true"]')).toMatch(
    /inset 0 0 0 1\.5px var\(--p-pick-line\)/
  );
  const ring = over(
    hex(token(LIGHT, "--p-ink")),
    line,
    hex(token(LIGHT, "--p-raised"))
  );
  expect(contrast(ring, hex(token(LIGHT, "--p-sunk")))).toBeGreaterThanOrEqual(
    3
  );
});

test("the open credits' chevron turns with reduced motion too, at once", () => {
  // Its turn is the only sign the credits are open (the marker is hidden):
  // reduced motion drops the transition, not the turn.
  expect(block(studio, ".credits[open] summary svg")).toMatch(
    /transform: rotate\(90deg\)/
  );
  const reduced = studio.slice(
    studio.indexOf("@media (prefers-reduced-motion: reduce)")
  );
  expect(reduced).not.toMatch(
    /\.credits\[open\] summary svg \{\s*transform: none/
  );
  expect(reduced).toMatch(/\.credits summary svg \{\s*transition: none/);
});
