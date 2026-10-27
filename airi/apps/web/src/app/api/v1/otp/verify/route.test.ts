const mockAuthenticateRequest = jest.fn();
const mockHasPermission = jest.fn();
const mockVerifyOtpChallenge = jest.fn();

jest.mock("@/lib/api-auth", () => ({
  authenticateRequest: (...args: unknown[]) => mockAuthenticateRequest(...args),
  hasPermission: (...args: unknown[]) => mockHasPermission(...args),
}));

jest.mock("@/lib/otp/otp-verification-service", () => ({
  verifyOtpChallenge: (...args: unknown[]) => mockVerifyOtpChallenge(...args),
}));

import { POST } from "./route";

describe("POST /api/v1/otp/verify", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAuthenticateRequest.mockResolvedValue({
      apiKey: { workspace_id: "workspace-1" },
      error: null,
    });
    mockHasPermission.mockReturnValue(true);
    mockVerifyOtpChallenge.mockResolvedValue({
      verified: true,
      status: "verified",
      attemptsRemaining: 4,
    });
  });

  it("requires write permission", async () => {
    mockHasPermission.mockReturnValue(false);

    const response = await POST(
      new Request("http://localhost/api/v1/otp/verify", {
        method: "POST",
        body: JSON.stringify({ challengeId: "challenge-1", code: "123456" }),
      })
    );

    expect(response.status).toBe(403);
  });

  it("verifies only within the authenticated workspace", async () => {
    const response = await POST(
      new Request("http://localhost/api/v1/otp/verify", {
        method: "POST",
        body: JSON.stringify({ challengeId: "challenge-1", code: "123456" }),
      })
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      success: true,
      verified: true,
      status: "verified",
      attemptsRemaining: 4,
    });
    expect(mockVerifyOtpChallenge).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      challengeId: "challenge-1",
      code: "123456",
    });
  });
});
