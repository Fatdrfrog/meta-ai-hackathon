import {
  buildChunkEmbeddingText,
  buildChunkedSections,
  chunkCuratedSnippet,
  chunkKbArticleByHeadings,
  extractKbArticleSections,
  extractKbArticleSectionsFromHtml,
} from "@/lib/airi/rag/knowledge/knowledge-chunkers";

describe("extractKbArticleSectionsFromHtml", () => {
  it("splits on h2 and keeps intro", () => {
    const html = `<p>Intro line.</p><h2 style="text-align:left">Alpha</h2><p>Body A</p><h2>Beta</h2><p>Body B</p>`;
    const secs = extractKbArticleSectionsFromHtml(html, "Doc");
    expect(secs).toHaveLength(3);
    expect(secs[0].heading).toBe("Doc");
    expect(secs[0].text).toContain("Intro");
    expect(secs[1].heading).toBe("Alpha");
    expect(secs[1].text).toContain("Body A");
    expect(secs[2].heading).toBe("Beta");
    expect(secs[2].text).toContain("Body B");
  });

  it("handles h1 and h3", () => {
    const html = `<h1>Title</h1><p>x</p><h3>Sub</h3><p>y</p>`;
    const secs = extractKbArticleSectionsFromHtml(html, "Outer");
    expect(secs.length).toBeGreaterThanOrEqual(2);
    expect(secs[0].heading).toBe("Title");
  });
});

describe("extractKbArticleSections (unified)", () => {
  it("prefers HTML when h-tags present", () => {
    const body = `<p>i</p><h2>Sec</h2><p>t</p>`;
    const secs = extractKbArticleSections(body, "T");
    expect(secs).toHaveLength(2);
    expect(secs[1].heading).toBe("Sec");
  });

  it("uses markdown when no HTML headings", () => {
    const body = `Intro\n\n## Two\n\ncontent here`;
    const secs = extractKbArticleSections(body, "T");
    expect(secs.some(s => s.heading === "Two")).toBe(true);
  });
});

describe("chunkKbArticleByHeadings", () => {
  it("assigns chunk indices", () => {
    const chunks = chunkKbArticleByHeadings({
      articleId: "a1",
      title: "T",
      bodyText: `<h2>One</h2><p>Body 1 with enough text to survive min length filter.</p><h2>Two</h2><p>Body 2 with enough text to survive min length filter.</p>`,
    });
    expect(chunks.length).toBe(2);
    expect(chunks[0].metadata?.chunkIndex).toBe(0);
    expect(chunks[1].metadata?.chunkIndex).toBe(1);
    expect(chunks[0].title).toBe("One");
  });

  it("strips HTML tags from chunk text before embedding", () => {
    const chunks = chunkKbArticleByHeadings({
      articleId: "a2",
      title: "T",
      bodyText: `<h2>Alpha</h2><p>Plain <strong>bold</strong> and <em>italic</em> text that should survive the min-length filter.</p>`,
    });
    expect(chunks.length).toBe(1);
    expect(chunks[0].text).not.toMatch(/<\/?[a-z]+>/i);
    expect(chunks[0].text).toContain("Plain");
    expect(chunks[0].text).toContain("bold");
  });

  it("preserves full heading path (H1 > H2 > H3) in metadata", () => {
    const chunks = chunkKbArticleByHeadings({
      articleId: "a3",
      title: "Doc",
      bodyText: `<h1>Plans</h1><p>Plans intro with enough text to survive the min length filter easily.</p><h2>Pricing</h2><p>Pricing body long enough to pass the minimum length filter easily.</p><h3>Enterprise</h3><p>Enterprise tier unlimited seats, custom SLA and long explanation that definitely passes min length.</p>`,
    });
    const enterprise = chunks.find(c => c.title === "Enterprise");
    expect(enterprise).toBeDefined();
    expect(enterprise?.metadata?.headingPath).toEqual([
      "Plans",
      "Pricing",
      "Enterprise",
    ]);
  });

  it("adds tail-sentence overlap between adjacent sections", () => {
    const chunks = chunkKbArticleByHeadings({
      articleId: "a4",
      title: "Doc",
      bodyText: `<h2>First</h2><p>Sentence one. Sentence two. The magic tail token is pineapple.</p><h2>Second</h2><p>This is the second section body which must survive.</p>`,
    });
    expect(chunks.length).toBe(2);
    expect(chunks[0].text).not.toContain("second section body");
    expect(chunks[1].text.toLowerCase()).toContain("pineapple");
  });

  it("splits FAQ sections into per-Q/A chunks with full heading path", () => {
    const body = `
<h2>Часто задаваемые вопросы</h2>
<p>Вопрос: Как отменить подписку?</p>
<p>Ответ: Зайдите в настройки и нажмите «Отменить подписку». Это займёт пару минут.</p>
<p>Вопрос: Есть ли бесплатный период?</p>
<p>Ответ: Да, бесплатный период длится 7 дней для всех новых пользователей.</p>
`;
    const chunks = chunkKbArticleByHeadings({
      articleId: "faq1",
      title: "Руководство",
      bodyText: body,
    });
    const qaChunks = chunks.filter(c => {
      const path = c.metadata?.headingPath as string[] | undefined;
      return path?.some(entry => /часто/iu.test(entry)) ?? false;
    });
    expect(qaChunks.length).toBeGreaterThanOrEqual(2);
    const cancel = qaChunks.find(
      c => c.text.includes("отменить") || c.text.includes("Отменить")
    );
    expect(cancel).toBeDefined();
    expect(cancel?.metadata?.headingPath).toEqual([
      "Часто задаваемые вопросы",
      expect.stringContaining("Как отменить подписку"),
    ]);
  });

  it("structurally detects FAQ when the parent heading has question-like children (no body under parent)", () => {
    // Real-world shape: the FAQ heading has zero direct body — all content
    // lives under question-like H3 siblings. This would not be caught by a
    // body-level Q/A regex alone, so we must rely on the section tree.
    const body = `
<h1 style="text-align: left;"><strong>Часто задаваемые вопросы</strong></h1>
<h3 style="text-align: left;">1. Что вообще такое грант БесТірек?</h3>
<p style="text-align: left;">Это образовательная программа Фонда имени Ержана Татишева для обучения на бакалавриате в AlmaU, покрывающая от 70% до 90% стоимости обучения.</p>
<h3 style="text-align: left;">2. Для кого эта программа?</h3>
<p style="text-align: left;">Программа рассчитана только на тех, кто в текущем году завершает школу или колледж и поступает на бакалавриат.</p>
<h3 style="text-align: left;">3. Можно ли участвовать, если я сейчас учусь в 10 классе?</h3>
<p style="text-align: left;">Нет, подавать заявку можно только в тот год, когда вы оканчиваете учебу и выходите на поступление.</p>
`;

    const chunks = chunkKbArticleByHeadings({
      articleId: "faq-tree-1",
      title: "Часто задаваемые вопросы",
      bodyText: body,
    });

    expect(chunks.length).toBe(3);

    for (const chunk of chunks) {
      expect(chunk.text).not.toMatch(/<\/?[a-z][^>]*>/i);
      expect(chunk.text.startsWith("Q:")).toBe(true);
      expect(chunk.text).toMatch(/\nA:/);
      const path = chunk.metadata?.headingPath as string[] | undefined;
      expect(path?.[0]).toBe("Часто задаваемые вопросы");
      expect(path?.length).toBe(2);
    }

    const tenthGrade = chunks.find(c => c.text.includes("10 классе"));
    expect(tenthGrade?.text).toContain("Нет, подавать заявку");
  });

  it("does not misclassify a numbered how-to guide as FAQ", () => {
    // Numbered children but none end with `?` and the parent heading is not
    // FAQ-shaped. Must NOT collapse into Q/A atoms.
    const body = `
<h1>Setup guide</h1>
<h2>1. Install dependencies</h2>
<p>Run pnpm install to fetch all workspace packages with enough text here.</p>
<h2>2. Configure environment</h2>
<p>Copy .env.example to .env.local and fill every required variable listed.</p>
<h2>3. Start the dev server</h2>
<p>Run pnpm dev:web to launch the Next.js app on http://localhost:3000 now.</p>
`;
    const chunks = chunkKbArticleByHeadings({
      articleId: "guide-1",
      title: "Setup",
      bodyText: body,
    });
    for (const chunk of chunks) {
      expect(chunk.text.startsWith("Q:")).toBe(false);
    }
    expect(
      chunks.find(c => c.title === "1. Install dependencies")
    ).toBeDefined();
  });

  it("does not carry overlap between sibling Q/A atoms", () => {
    // Prior section's tail must not bleed into the first Q/A, and Q1's tail
    // must not leak into Q2.
    const body = `
<h1>Часто задаваемые вопросы</h1>
<h3>1. Первый вопрос со странным словом пингвин?</h3>
<p>Ответ на первый вопрос, длина достаточно для фильтра минимальной длины чанка.</p>
<h3>2. Второй вопрос совсем про другое?</h3>
<p>Ответ на второй вопрос, тоже длинный для прохождения фильтра.</p>
`;
    const chunks = chunkKbArticleByHeadings({
      articleId: "faq-tree-2",
      title: "FAQ",
      bodyText: body,
    });
    expect(chunks.length).toBe(2);
    expect(chunks[0].text).not.toContain("Второй вопрос");
    expect(chunks[1].text).not.toContain("пингвин");
    expect(chunks[1].text).not.toContain("Ответ на первый вопрос");
  });

  it("recursively splits oversized sections", () => {
    const bigParagraph = "Sentence. ".repeat(200).trim();
    const body = `<h2>Huge</h2><p>${bigParagraph}</p>`;
    const chunks = chunkKbArticleByHeadings({
      articleId: "big1",
      title: "Doc",
      bodyText: body,
    });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(1400);
    }
  });

  it("preserves http(s) URLs from anchor tags as plain text so they survive tag stripping", () => {
    // Real-world shape: `<a href="URL">label</a>` where label != URL. The
    // downstream allowlist (`extractHttpUrlsFromKbSource`) reads the stored
    // chunk body; if we drop the URL during tag stripping it never reaches
    // the reply.
    const body = `
<h2>Links</h2>
<p>See the form at <a target="_blank" rel="noopener noreferrer" href="https://docs.google.com/forms/d/1czTYjmSGV27/viewform">the Google form</a> and our <a href='https://example.kz/about'>about page</a>.</p>
<p>Contact us via <a href="mailto:info@example.kz">info@example.kz</a> or on <a href="https://example.com/x">https://example.com/x</a>.</p>
`;
    const chunks = chunkKbArticleByHeadings({
      articleId: "links-1",
      title: "Doc",
      bodyText: body,
    });
    const joined = chunks.map(c => c.text).join("\n");
    expect(joined).toContain(
      "https://docs.google.com/forms/d/1czTYjmSGV27/viewform"
    );
    expect(joined).toContain("https://example.kz/about");
    expect(joined).toContain("https://example.com/x");
    expect(joined).toContain("the Google form");
    expect(joined).toContain("about page");
    // Anchor where visible text already is the URL should not duplicate it.
    expect((joined.match(/https:\/\/example\.com\/x/g) || []).length).toBe(1);
    // mailto: is kept as visible text but must not leak into http(s) URL space.
    expect(joined).toContain("info@example.kz");
    expect(joined).not.toMatch(/https?:\/\/[^\s)]*info@example\.kz/);
    // No raw HTML should remain in the chunk body.
    for (const chunk of chunks) {
      expect(chunk.text).not.toMatch(/<\/?[a-z][^>]*>/i);
    }
  });

  it("drops sections shorter than minChunkChars", () => {
    const body = `<h2>Tiny</h2><p>Hi.</p><h2>Real</h2><p>This section has enough characters to survive the minimum threshold check easily.</p>`;
    const chunks = chunkKbArticleByHeadings({
      articleId: "mix",
      title: "Doc",
      bodyText: body,
    });
    expect(chunks.find(c => c.title === "Tiny")).toBeUndefined();
    expect(chunks.find(c => c.title === "Real")).toBeDefined();
  });
});

describe("chunkCuratedSnippet", () => {
  it("collapses short Q/A to a single chunk", () => {
    const chunks = chunkCuratedSnippet({
      snippetId: "s1",
      question: "What is the price?",
      answer: "It is $199 per month.",
    });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toContain("Q: What is the price?");
    expect(chunks[0].text).toContain("A: It is $199 per month.");
  });

  it("splits long Q/A into multiple chunks with overlap", () => {
    const longAnswer = "Paragraph. ".repeat(400).trim();
    const chunks = chunkCuratedSnippet({
      snippetId: "s2",
      question: "Explain pricing in detail",
      answer: longAnswer,
    });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0].text).toContain("Q: Explain pricing in detail");
  });
});

describe("buildChunkEmbeddingText", () => {
  it("prepends document title and heading path", () => {
    const text = buildChunkEmbeddingText({
      documentTitle: "Plans",
      headingPath: ["Plans", "Pricing", "Enterprise"],
      text: "Enterprise tier unlimited seats.",
    });
    expect(text.startsWith("Plans > Pricing > Enterprise")).toBe(true);
    expect(text).toContain("Enterprise tier unlimited seats.");
  });

  it("dedupes when heading path already starts with document title", () => {
    const text = buildChunkEmbeddingText({
      documentTitle: "Plans",
      headingPath: ["Pricing"],
      text: "Body",
    });
    expect(text.startsWith("Plans > Pricing")).toBe(true);
  });

  it("returns body as-is when no titles available", () => {
    const text = buildChunkEmbeddingText({
      documentTitle: null,
      headingPath: null,
      text: "Body only.",
    });
    expect(text).toBe("Body only.");
  });
});

describe("buildChunkedSections", () => {
  it("returns objects with both heading and headingPath", () => {
    const sections = buildChunkedSections(
      `<h1>Plans</h1><p>intro intro intro intro intro intro intro</p><h2>Pricing</h2><p>Pricing body long enough to survive filter.</p>`,
      "Doc"
    );
    for (const section of sections) {
      expect(Array.isArray(section.headingPath)).toBe(true);
      expect(typeof section.heading).toBe("string");
    }
  });
});
