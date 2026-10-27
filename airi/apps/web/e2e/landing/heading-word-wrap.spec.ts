import { expect, test, type Page } from "@playwright/test";

const LOCALES = ["en", "ru", "kz"] as const;
const WIDTHS = [320, 360, 390, 768, 1024, 1280, 1440, 1920];

// Heading words the browser wrapped inside, marked at the break
// ("подключени|ем."). A compound may wrap after its hyphen unless that leaves a
// short ending alone on the next line ("WhatsApp-|та").
function findSplitHeadingWords(root: string) {
  const split: string[] = [];
  const headings = document.querySelectorAll(`${root} :is(h1, h2, h3, h4)`);
  for (const heading of headings) {
    const walker = document.createTreeWalker(heading, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node as Text;
      for (const match of text.data.matchAll(/\S+/g)) {
        const word = match[0];
        const start = match.index ?? 0;
        let previousCenter: number | null = null;
        for (let i = 0; i < word.length; i++) {
          const range = document.createRange();
          range.setStart(text, start + i);
          range.setEnd(text, start + i + 1);
          const rect = range.getBoundingClientRect();
          if (!rect.height) continue;
          const center = rect.top + rect.height / 2;
          const wrapped =
            previousCenter !== null &&
            Math.abs(center - previousCenter) > rect.height / 2;
          const ending = word.slice(i).replace(/[^\p{L}\p{N}]/gu, "");
          if (wrapped && (!/[-‐]/.test(word[i - 1]) || ending.length <= 4)) {
            split.push(`${word.slice(0, i)}|${word.slice(i)}`);
          }
          previousCenter = center;
        }
      }
    }
  }
  return split;
}

async function openLanding(
  page: Page,
  baseURL: string | undefined,
  locale: string,
  width: number
) {
  await page.context().addCookies([
    {
      name: "NEXT_LOCALE",
      value: locale,
      url: baseURL ?? "http://localhost:3000",
    },
  ]);
  await page.setViewportSize({ width, height: 900 });
  await page.goto("/", { waitUntil: "networkidle" });
  await expect(page.locator("html")).toHaveAttribute("lang", locale);
  await page.evaluate(() => document.fonts.ready);
}

for (const locale of LOCALES) {
  test(`${locale} landing headings keep every word on one line`, async ({
    page,
    baseURL,
  }) => {
    await openLanding(page, baseURL, locale, WIDTHS[0]);
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 900 });
      await expect
        .poll(() => page.evaluate(findSplitHeadingWords, "main"), {
          message: `${locale} headings at ${width}px`,
        })
        .toEqual([]);
    }
  });

  test(`${locale} workflow explorer headings keep every word on one line`, async ({
    page,
    baseURL,
  }) => {
    for (const width of [320, 360, 1440]) {
      await openLanding(page, baseURL, locale, width);
      await page.locator('main button[aria-haspopup="dialog"]').first().click();
      const explorer = page.locator("[data-landing-workflow-explorer]");
      await expect(explorer).toBeVisible();
      // Phones pick a workflow from a select, wider screens from a list.
      const select = explorer.getByRole("combobox");
      const buttons = explorer.getByRole("navigation").getByRole("button");
      const count =
        width < 768
          ? await select.locator("option").count()
          : await buttons.count();
      expect(count).toBe(9);
      for (let index = 0; index < count; index++) {
        if (width < 768) await select.selectOption({ index });
        else await buttons.nth(index).click();
        await expect
          .poll(
            () =>
              page.evaluate(
                findSplitHeadingWords,
                "[data-landing-workflow-explorer]"
              ),
            { message: `${locale} explorer workflow ${index} at ${width}px` }
          )
          .toEqual([]);
      }
    }
  });
}
