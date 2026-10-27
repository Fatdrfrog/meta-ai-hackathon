const mockMembership = jest.fn();
const mockConnectDB = jest.fn();
const mockCodeFindOne = jest.fn();
const mockRenderPng = jest.fn();
const mockRenderSvg = jest.fn();

jest.mock("@/lib/auth/workspace-membership", () => ({
  getAuthenticatedWorkspaceMembership: (...args: unknown[]) =>
    mockMembership(...args),
}));

jest.mock("@/lib/mongoose", () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockConnectDB(...args),
}));

jest.mock("@/models/whatsapp-qr-code", () => ({
  WhatsAppQrCode: {
    findOne: (...args: unknown[]) => mockCodeFindOne(...args),
  },
}));

jest.mock("@/lib/whatsapp/qr-entry-points/render.server", () => ({
  renderWhatsAppQrPng: (...args: unknown[]) => mockRenderPng(...args),
  renderWhatsAppQrSvg: (...args: unknown[]) => mockRenderSvg(...args),
}));

import { GET } from "./route";

describe("GET /api/whatsapp/qr-entry-points/[codeId]/artwork", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockMembership.mockResolvedValue({
      membership: { role: "admin" },
      user: { id: "user-1" },
    });
    mockConnectDB.mockResolvedValue(undefined);
    mockCodeFindOne.mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue({
          codeId: "code-1",
          workspaceId: "workspace-1",
          deepLink: "https://wa.me/message/ABC",
          providerState: "ACTIVE",
        }),
      }),
    });
    mockRenderPng.mockResolvedValue(Buffer.from([1, 2, 3]));
    mockRenderSvg.mockResolvedValue("<svg></svg>");
  });

  it("renders png artwork for a workspace-owned code", async () => {
    const response = await GET(
      new Request(
        "http://localhost/api/whatsapp/qr-entry-points/code-1/artwork?workspaceId=workspace-1&format=png"
      ),
      { params: Promise.resolve({ codeId: "code-1" }) }
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/png");
    expect(response.headers.get("Content-Disposition")).toContain(
      "whatsapp-qr-code-1.png"
    );
    expect(mockRenderPng).toHaveBeenCalledWith("https://wa.me/message/ABC");
    expect(mockMembership).toHaveBeenCalledWith("workspace-1");
  });

  it("renders svg artwork", async () => {
    const response = await GET(
      new Request(
        "http://localhost/api/whatsapp/qr-entry-points/code-1/artwork?workspaceId=workspace-1&format=svg"
      ),
      { params: Promise.resolve({ codeId: "code-1" }) }
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("image/svg+xml");
    await expect(response.text()).resolves.toBe("<svg></svg>");
  });

  it("returns 404 when deepLink is missing", async () => {
    mockCodeFindOne.mockReturnValueOnce({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue({
          codeId: "code-1",
          workspaceId: "workspace-1",
          providerState: "ACTIVE",
        }),
      }),
    });

    const response = await GET(
      new Request(
        "http://localhost/api/whatsapp/qr-entry-points/code-1/artwork?workspaceId=workspace-1&format=png"
      ),
      { params: Promise.resolve({ codeId: "code-1" }) }
    );

    expect(response.status).toBe(404);
    expect(mockRenderPng).not.toHaveBeenCalled();
  });
  it.each([
    [
      "deleted provider code",
      { providerState: "DELETED", deepLink: "https://wa.me/message/ABC" },
    ],
    [
      "malformed provider link",
      {
        providerState: "ACTIVE",
        deepLink: "https://wa.me/15551234567?text=Hello",
      },
    ],
  ])("returns 404 for a %s", async (_label, code) => {
    mockCodeFindOne.mockReturnValueOnce({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue({
          codeId: "code-1",
          workspaceId: "workspace-1",
          ...code,
        }),
      }),
    });

    const response = await GET(
      new Request(
        "http://localhost/api/whatsapp/qr-entry-points/code-1/artwork?workspaceId=workspace-1&format=png"
      ),
      { params: Promise.resolve({ codeId: "code-1" }) }
    );

    expect(response.status).toBe(404);
    expect(mockRenderPng).not.toHaveBeenCalled();
  });

  it("projects only the artwork fields from MongoDB", async () => {
    const select = jest.fn().mockReturnValue({
      lean: jest.fn().mockResolvedValue({
        codeId: "code-1",
        deepLink: "https://wa.me/message/ABC",
        providerState: "ACTIVE",
      }),
    });
    mockCodeFindOne.mockReturnValueOnce({ select });

    await GET(
      new Request(
        "http://localhost/api/whatsapp/qr-entry-points/code-1/artwork?workspaceId=workspace-1&format=png"
      ),
      { params: Promise.resolve({ codeId: "code-1" }) }
    );

    expect(select).toHaveBeenCalledWith("codeId deepLink providerState");
  });
});
