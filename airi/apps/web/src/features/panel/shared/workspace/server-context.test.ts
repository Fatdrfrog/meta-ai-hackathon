const mockCreateReadOnlyClient = jest.fn();
const mockGetUser = jest.fn();

// Outside a React server render, cache() does not memoize; this stands in for
// the per-request memoization the page relies on.
jest.mock("react", () => {
  const actual = jest.requireActual("react");
  return {
    ...actual,
    cache: <T>(fn: () => T) => {
      let result: { value: T } | null = null;
      return () => {
        result ??= { value: fn() };
        return result.value;
      };
    },
  };
});
jest.mock("@/lib/supabase/server", () => ({
  createReadOnlyClient: () => mockCreateReadOnlyClient(),
}));

import {
  getReadOnlySupabaseClient,
  getReadOnlySupabaseContext,
} from "./server-context";

describe("read-only Supabase server context", () => {
  it("checks the user on the same client the page's early reads use", async () => {
    const client = { auth: { getUser: mockGetUser } };
    mockCreateReadOnlyClient.mockResolvedValue(client);
    mockGetUser.mockResolvedValue({ data: { user: { id: "user-1" } } });

    const earlyReadsClient = await getReadOnlySupabaseClient();
    const context = await getReadOnlySupabaseContext();

    expect(context.supabase).toBe(earlyReadsClient);
    expect(context.user).toEqual({ id: "user-1" });
    expect(mockCreateReadOnlyClient).toHaveBeenCalledTimes(1);
    expect(mockGetUser).toHaveBeenCalledTimes(1);
  });
});
