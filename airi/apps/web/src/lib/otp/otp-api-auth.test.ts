const mockAuthenticateRequest = jest.fn();
const mockHasPermission = jest.fn();

jest.mock("@/lib/api-auth", () => ({
  authenticateRequest: (...args: unknown[]) => mockAuthenticateRequest(...args),
  hasPermission: (...args: unknown[]) => mockHasPermission(...args),
}));

import { authenticateOtpWriteRequest } from "./otp-api-auth";

describe("OTP API auth", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAuthenticateRequest.mockResolvedValue({
      apiKey: { workspace_id: "workspace-1" },
      error: null,
    });
    mockHasPermission.mockReturnValue(true);
  });

  it("returns the authenticated workspace for write-enabled API keys", async () => {
    const result = await authenticateOtpWriteRequest(
      new Request("http://localhost/api/v1/otp/verify"),
      "verify"
    );

    expect(result).toEqual({
      workspaceId: "workspace-1",
      apiKey: { workspace_id: "workspace-1" },
    });
    expect(mockHasPermission).toHaveBeenCalledWith(
      { workspace_id: "workspace-1" },
      "write"
    );
  });

  it("returns operation-specific permission errors", async () => {
    mockHasPermission.mockReturnValue(false);

    const result = await authenticateOtpWriteRequest(
      new Request("http://localhost/api/v1/otp/whatsapp/request"),
      "request"
    );

    expect("error" in result && result.error.status).toBe(403);
    expect("error" in result && (await result.error.json())).toEqual({
      success: false,
      error: "API key does not have permission to request OTPs",
    });
  });
});
