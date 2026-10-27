import { requireAppAdmin } from "@/lib/auth/app-admin";
import { NextResponse } from "next/server";

import { GET } from "./route";

jest.mock("@/lib/auth/app-admin", () => ({
  requireAppAdmin: jest.fn(),
}));

const mockRequireAppAdmin = jest.mocked(requireAppAdmin);

describe("GET /api/metrics", () => {
  afterEach(() => {
    jest.resetAllMocks();
  });

  it.each([
    [401, "Unauthorized"],
    [403, "Forbidden"],
  ] as const)(
    "preserves the legacy %i error response contract",
    async (status, error) => {
      mockRequireAppAdmin.mockResolvedValue({
        userId: status === 401 ? null : "user-1",
        response: NextResponse.json({ error }, { status }),
        supabase: {} as never,
      });

      const response = await GET(new Request("http://localhost/api/metrics"));

      expect(response.status).toBe(status);
      expect(await response.text()).toBe(JSON.stringify({ error }));
      expect(response.headers.get("content-type")).toBe(
        "text/plain;charset=UTF-8"
      );
    }
  );
});
