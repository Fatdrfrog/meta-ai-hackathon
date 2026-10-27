import fs from "fs";
import path from "path";

const globalsCss = fs.readFileSync(
  path.resolve(__dirname, "../globals.css"),
  "utf8"
);
const productTrainingStatus = fs.readFileSync(
  path.resolve(__dirname, "product-training-status.tsx"),
  "utf8"
);

function declarations(name: string): string[] {
  return [
    ...globalsCss.matchAll(new RegExp(`^\\s+--${name}:\\s*([^;]+);`, "gm")),
  ].map(match => match[1].trim());
}

function relativeLuminance([red, green, blue]: readonly number[]): number {
  const [r, g, b] = [red, green, blue].map(channel => {
    const srgb = channel / 255;
    return srgb <= 0.04045
      ? srgb / 12.92
      : Math.pow((srgb + 0.055) / 1.055, 2.4);
  });

  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(
  first: readonly number[],
  second: readonly number[]
): number {
  const lighter = Math.max(relativeLuminance(first), relativeLuminance(second));
  const darker = Math.min(relativeLuminance(first), relativeLuminance(second));
  return (lighter + 0.05) / (darker + 0.05);
}

describe("setup contrast", () => {
  it("keeps both brand primaries paired with the accessible near-white foreground", () => {
    expect(declarations("primary")).toEqual([
      "oklch(0.57 0.225 16.439)",
      "oklch(0.57 0.225 16.439)",
    ]);
    expect(declarations("primary-foreground")).toEqual([
      "oklch(0.969 0.015 12.422)",
      "oklch(0.969 0.015 12.422)",
    ]);

    // Both themes declare the same brand primary, which converts to this sRGB
    // triplet, and the foreground converts to the near-white triplet. The
    // brand primary is deliberately darker than the original rgb(255, 32, 86)
    // so white button labels clear the 4.5:1 body-text threshold.
    const brandPrimary = [220, 9, 70] as const;
    const nearWhite = [255, 241, 242] as const;
    expect(contrastRatio(brandPrimary, nearWhite)).toBeGreaterThanOrEqual(4.5);
  });

  it("keeps failed source badges legible in light and dark themes", () => {
    expect(productTrainingStatus).toContain("text-rose-950 dark:text-rose-100");
  });

  it("uses native status semantics and mount focus without an event-mirroring effect", () => {
    expect(productTrainingStatus).toContain("<output");
    expect(productTrainingStatus).toContain(
      "ref={isStartFailure ? focusStartFailureAlert : undefined}"
    );
    expect(productTrainingStatus).not.toContain("useEffect");
  });
});
