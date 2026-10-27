import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";

const webRoot = path.resolve(__dirname, "../..");
// PostCSS is a dependency of the installed Tailwind plugin. Resolve it through
// that owner without adding a direct app dependency solely for this regression.
const requireFromWeb = createRequire(path.join(webRoot, "package.json"));
const requireFromTailwind = createRequire(
  requireFromWeb.resolve("@tailwindcss/postcss")
);
const postcss = requireFromTailwind("postcss") as (plugins: unknown[]) => {
  process(source: string, options: { from: string }): Promise<{ css: string }>;
};
let styles: string;
let toolbars: Record<"en" | "ru" | "kz", string>;
let brandColors: Record<"light" | "dark", number[][]>;

// Playwright serializes this callback into the browser. Canvas converts rendered
// OKLCH or RGB tokens into sRGB for both text and graph contrast measurements.
function renderedCardColor(node: Element, property: "color" | "fill") {
  const card = node.closest('[data-slot="card"]');
  if (!card) throw new Error("Canonical card surface missing");
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas color conversion unavailable");
  const rgb = (color: string) => {
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = color;
    context.fillRect(0, 0, 1, 1);
    const rgba = context.getImageData(0, 0, 1, 1).data;
    if (rgba[3] !== 255) throw new Error("Expected opaque card colors");
    return Array.from(rgba.slice(0, 3));
  };
  const luminance = (color: number[]) => {
    const [red, green, blue] = color.map(channel => {
      const value = channel / 255;
      return value <= 0.04045
        ? value / 12.92
        : ((value + 0.055) / 1.055) ** 2.4;
    });
    return red * 0.2126 + green * 0.7152 + blue * 0.0722;
  };
  const fill = rgb(getComputedStyle(node)[property]);
  const foreground = luminance(fill);
  const background = luminance(rgb(getComputedStyle(card).backgroundColor));
  return {
    fill,
    contrast:
      (Math.max(foreground, background) + 0.05) /
      (Math.min(foreground, background) + 0.05),
  };
}

test.beforeAll(async () => {
  // Render in Node via the installed TSX loader. Playwright transforms imported
  // components for component testing, which cannot be server-rendered by React.
  toolbars = JSON.parse(
    execFileSync(
      process.execPath,
      [
        "--import",
        "tsx",
        path.join(webRoot, "e2e/analytics/render-comparison-toolbar.tsx"),
      ],
      { cwd: webRoot, encoding: "utf8", timeout: 45_000 }
    )
  );
  const source = path.join(webRoot, "src/app/globals.css");
  const themeSource = readFileSync(source, "utf8");
  const landingSource = readFileSync(
    path.join(
      webRoot,
      "src/components/landing/landing-workflow-studio.module.css"
    ),
    "utf8"
  );
  const logoSource = readFileSync(
    path.join(webRoot, "public/logo_short_black.svg"),
    "utf8"
  );
  const rgb = (hex: string | undefined) => {
    if (!hex) throw new Error("Canonical airi.chat brand color missing");
    const value = hex.slice(1);
    const normalized =
      value.length === 3
        ? Array.from(value, digit => digit + digit).join("")
        : value;
    return [0, 2, 4].map(offset =>
      parseInt(normalized.slice(offset, offset + 2), 16)
    );
  };
  // Bright colors come from the actual logo. Contrast variants come from the
  // landing's canonical palette, whether declared there or aliased to globals.
  brandColors = {
    dark: ["2", "3", "1"].map(classId =>
      rgb(
        logoSource.match(
          new RegExp(`\\.cls-${classId}\\s*\\{\\s*fill:\\s*(#[\\da-f]+)`, "i")
        )?.[1]
      )
    ),
    light: ["rose", "green", "sky"].map(name =>
      rgb(
        landingSource.match(
          new RegExp(`--${name}-ink:\\s*(#[\\da-f]+)`, "i")
        )?.[1] ??
          themeSource.match(
            new RegExp(`--airi-${name}-ink:\\s*(#[\\da-f]+)`, "i")
          )?.[1]
      )
    ),
  };
  styles = (
    await postcss([tailwindcss({ base: webRoot })]).process(themeSource, {
      from: source,
    })
  ).css;
});

for (const theme of ["light", "dark"] as const) {
  test(`analytics chart palette uses airi.chat colors with graph contrast in ${theme} theme`, async ({
    page,
  }) => {
    await page.setContent(
      `<html class="font-sans ${theme === "dark" ? "dark" : ""}" style="--font-inter:Arial,sans-serif"><head><style>${styles}</style></head><body><main style="padding:12px">${toolbars.en}</main></body></html>`
    );
    const marks = page.locator("[data-brand-chart]");
    await expect(marks).toHaveCount(3);
    const measurements = [];
    for (const [index, mark] of (await marks.all()).entries()) {
      await expect(mark).toBeVisible();
      const rendered = await mark.evaluate(renderedCardColor, "fill" as const);
      expect(
        rendered.fill,
        `${theme} chart-${index + 1} canonical color`
      ).toEqual(brandColors[theme][index]);
      expect(
        rendered.contrast,
        `${theme} chart-${index + 1} graph contrast`
      ).toBeGreaterThanOrEqual(3);
      measurements.push({ token: index + 1, ...rendered });
    }
    await test.info().attach(`${theme}-airi-chart-palette`, {
      body: JSON.stringify(measurements, null, 2),
      contentType: "application/json",
    });
  });
}

for (const locale of ["en", "ru", "kz"] as const) {
  test(`${locale} comparison labels stay inside their buttons on mobile`, async ({
    page,
  }) => {
    await page.setContent(
      `<html class="font-sans" style="--font-inter:Arial,sans-serif"><head><style>${styles}</style></head><body><main style="padding:12px">${toolbars[locale]}</main></body></html>`
    );
    for (const width of [320, 360, 390, 640, 768]) {
      await page.setViewportSize({ width, height: 900 });
      const radios = page.getByRole("radio");
      await expect(radios).toHaveCount(2);
      for (const radio of await radios.all()) {
        const clipped = await radio.evaluate(button => {
          const bounds = button.getBoundingClientRect();
          const range = document.createRange();
          range.selectNodeContents(button);
          return Array.from(range.getClientRects()).some(
            rect =>
              rect.left < bounds.left - 1 ||
              rect.right > bounds.right + 1 ||
              rect.top < bounds.top - 1 ||
              rect.bottom > bounds.bottom + 1
          );
        });
        expect(clipped, `${locale} comparison label at ${width}px`).toBe(false);
      }
    }
  });

  for (const theme of ["light", "dark"] as const) {
    test(`${locale} request queue link meets text contrast in ${theme} theme`, async ({
      page,
    }) => {
      await page.setContent(
        `<html class="font-sans ${theme === "dark" ? "dark" : ""}" style="--font-inter:Arial,sans-serif"><head><style>${styles}</style></head><body><main style="padding:12px">${toolbars[locale]}</main></body></html>`
      );
      const queueLink = page
        .locator('[data-metric-id="new"]')
        .getByRole("link");
      await expect(queueLink).toBeVisible();
      await expect(queueLink).toHaveAttribute(
        "href",
        "/panel/w/contrast-workspace/requests?status=open"
      );
      const { contrast } = await queueLink.evaluate(
        renderedCardColor,
        "color" as const
      );
      expect(
        contrast,
        `${locale} ${theme} request queue text contrast`
      ).toBeGreaterThanOrEqual(4.5);
    });
  }
}
