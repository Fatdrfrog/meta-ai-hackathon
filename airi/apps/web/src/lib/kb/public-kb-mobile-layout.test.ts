import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("public KB mobile layout CSS", () => {
  it("overrides saved table widths on narrow screens so published pages do not overflow horizontally", () => {
    const css = readFileSync(
      join(process.cwd(), "src/app/globals.css"),
      "utf8"
    );

    expect(css).toContain("@media (max-width: 640px)");
    expect(css).toContain(".public-kb-article-content table");
    expect(css).toContain("width: 100% !important");
    expect(css).toContain(".public-kb-article-content col");
    expect(css).toContain("overflow-wrap: anywhere");
  });

  it("wraps preformatted article text on mobile instead of clipping it off-screen", () => {
    const css = readFileSync(
      join(process.cwd(), "src/app/globals.css"),
      "utf8"
    );

    expect(css).toContain(".public-kb-article-content pre");
    expect(css).toContain(".public-kb-article-content pre code");
    expect(css).toContain("white-space: pre-wrap");
    expect(css).toContain("word-break: break-word");
  });

  it("keeps the public article readable on mobile with grid and long inline content wrapping", () => {
    const css = readFileSync(
      join(process.cwd(), "src/app/globals.css"),
      "utf8"
    );

    expect(css).toContain(".public-kb-article-content .kb-editor-grid");
    expect(css).toContain("display: grid");
    expect(css).toContain(
      '.public-kb-article-content .kb-editor-grid[data-columns="4"]'
    );
    expect(css).toContain(".public-kb-article-content h1");
    expect(css).toContain(".public-kb-article-content img");
    expect(css).toContain("overflow-wrap: anywhere");
    expect(css).toContain("max-width: 100%");
  });

  it("lets the public KB navbar scroll away while the desktop sidebar fills the top on scroll", () => {
    const page = readFileSync(
      join(process.cwd(), "src/app/[companySlug]/kb/[article]/page.tsx"),
      "utf8"
    );

    expect(page).toContain(
      'className="min-h-screen overflow-x-clip bg-background"'
    );
    expect(page).toContain(
      'SidebarProvider className="min-h-screen min-w-0 flex-col overflow-x-clip"'
    );
    expect(page).toContain("sticky={false}");
    expect(page).toContain('desktopMode="sticky"');
    expect(page).toContain('className="md:hidden"');
    expect(page).not.toContain("md:top-14");
    expect(page).not.toContain("overflow-x-hidden bg-background");
  });
});
