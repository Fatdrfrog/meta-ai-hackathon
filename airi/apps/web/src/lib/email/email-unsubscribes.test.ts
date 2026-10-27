import { getUnsubscribedEmailSet } from "./email-unsubscribes";

describe("email unsubscribe helpers", () => {
  it("chunks unsubscribe lookups for large recipient lists", async () => {
    const queriedChunks: string[][] = [];
    const supabase = {
      from: jest.fn(() => ({
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        in: jest.fn((column: string, emails: string[]) => {
          queriedChunks.push(emails);
          const blocked = emails.includes("user-777@example.com")
            ? [{ email: "user-777@example.com" }]
            : [];
          return Promise.resolve({ data: blocked, error: null });
        }),
      })),
    };

    const emails = Array.from(
      { length: 1_201 },
      (_, index) => `User-${index}@Example.com`
    );

    const result = await getUnsubscribedEmailSet({
      supabase,
      workspaceId: "workspace-1",
      emails,
    });

    expect(queriedChunks.map(chunk => chunk.length)).toEqual([500, 500, 201]);
    expect(result).toEqual(new Set(["user-777@example.com"]));
  });
});
