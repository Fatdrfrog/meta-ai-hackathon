jest.mock("@/lib/kb/content-utils", () => ({
  extractPlainText: (content: string) => content,
}));

import { buildKBContentExcerpt } from "@/lib/airi/rag/kb/kb-content";

describe("kb content excerpting", () => {
  it("prefers the later section that matches the query over the article intro", () => {
    const excerpt = buildKBContentExcerpt({
      content: `
Overview

This article describes the foundation in general terms and gives background information.

Support for people with disabilities

The "Receive a Trade" program is available for people with disabilities and helps them learn a profession.

Contacts

Reach out to the foundation for more information.
      `,
      query: "support for people with disabilities and receive a trade program",
    });

    expect(excerpt).toContain("Support for people with disabilities");
    expect(excerpt).toContain('"Receive a Trade" program');
  });

  it("samples later sections when broad overview excerpting is requested", () => {
    const excerpt = buildKBContentExcerpt({
      content: `
Intro

This page collects the main ways we can help founders.

Special grant

QazInnovation support with jury-focused packaging and a winner package.

Situation 1

Grant Sprint for startups with MVP.

Situation 2

Consultation 60 minutes with a personalized grant shortlist.

Situation 3

Express consultation 30 minutes for quick feedback.

Situation 4

Done-for-you application writing under key.

Situation 5

One-on-one mentorship with long-term support.

Situation 6

Webinar recording plus prompt archive and examples.
      `,
      query: "What services do you offer?",
      maxChars: 900,
      preferBroadOverview: true,
    });

    expect(excerpt).toContain("QazInnovation support");
    expect(excerpt).toContain("One-on-one mentorship");
  });
});
