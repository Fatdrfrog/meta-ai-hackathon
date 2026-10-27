import {
  clearWhatsAppSelectionSessionCookie,
  openWhatsAppSelectionSession,
  readWhatsAppSelectionSessionToken,
  sealWhatsAppSelectionSession,
  setWhatsAppSelectionSessionCookie,
  WHATSAPP_SELECTION_SESSION_COOKIE,
  WHATSAPP_SELECTION_SESSION_MAX_AGE_SECONDS,
} from "./embedded-signup-selection-session";

const NOW = Date.UTC(2026, 9, 18, 9, 0, 0);
const scope = { workspaceId: "workspace-1", userId: "user-1", now: NOW };

function seal(
  overrides: Partial<Parameters<typeof sealWhatsAppSelectionSession>[0]> = {}
) {
  return sealWhatsAppSelectionSession({
    accessToken: "EAAbusiness",
    workspaceId: "workspace-1",
    userId: "user-1",
    now: NOW,
    ...overrides,
  });
}

describe("embedded signup selection session", () => {
  const originalSecret = process.env.ENCRYPTION_SECRET;

  beforeAll(() => {
    process.env.ENCRYPTION_SECRET = "test-selection-session-secret";
  });

  afterAll(() => {
    process.env.ENCRYPTION_SECRET = originalSecret;
  });

  it("round-trips the token for the same user and workspace", () => {
    const sealed = seal();
    expect(sealed?.maxAge).toBe(WHATSAPP_SELECTION_SESSION_MAX_AGE_SECONDS);
    expect(openWhatsAppSelectionSession(sealed?.value, scope)).toBe(
      "EAAbusiness"
    );
  });

  it("never stores the token in readable form", () => {
    const sealed = seal();
    expect(sealed?.value).not.toContain("EAAbusiness");
    expect(
      Buffer.from(sealed!.value, "base64url").toString("utf8")
    ).not.toContain("EAAbusiness");
  });

  it("rejects another workspace or another user", () => {
    const sealed = seal();
    expect(
      openWhatsAppSelectionSession(sealed?.value, {
        ...scope,
        workspaceId: "workspace-2",
      })
    ).toBeNull();
    expect(
      openWhatsAppSelectionSession(sealed?.value, {
        ...scope,
        userId: "user-2",
      })
    ).toBeNull();
  });

  it("expires after 30 minutes", () => {
    const sealed = seal();
    expect(
      openWhatsAppSelectionSession(sealed?.value, {
        ...scope,
        now: NOW + WHATSAPP_SELECTION_SESSION_MAX_AGE_SECONDS * 1000,
      })
    ).toBeNull();
  });

  it("never outlives the Meta token itself", () => {
    const sealed = seal({ tokenExpiresAt: new Date(NOW + 5 * 60 * 1000) });
    expect(sealed?.maxAge).toBe(5 * 60);
    expect(seal({ tokenExpiresAt: new Date(NOW - 1000) })).toBeNull();
  });

  it("rejects tampered or malformed values", () => {
    const sealed = seal()!;
    const tampered = Buffer.from(
      JSON.stringify({
        ...JSON.parse(Buffer.from(sealed.value, "base64url").toString("utf8")),
        ciphertext: Buffer.from("forged").toString("base64"),
      }),
      "utf8"
    ).toString("base64url");
    expect(openWhatsAppSelectionSession(tampered, scope)).toBeNull();
    expect(openWhatsAppSelectionSession("not-a-session", scope)).toBeNull();
    expect(openWhatsAppSelectionSession("", scope)).toBeNull();
  });

  it("reads the token from the request cookie header", () => {
    const sealed = seal({ now: Date.now() })!;
    const request = new Request("https://app.test/api/sources/whatsapp", {
      headers: {
        cookie: `theme=dark; ${WHATSAPP_SELECTION_SESSION_COOKIE}=${sealed.value}`,
      },
    });
    expect(
      readWhatsAppSelectionSessionToken(request, {
        workspaceId: "workspace-1",
        userId: "user-1",
      })
    ).toBe("EAAbusiness");
    expect(
      readWhatsAppSelectionSessionToken(request, {
        workspaceId: null,
        userId: "user-1",
      })
    ).toBeNull();
  });

  it("sets an httpOnly cookie scoped to the WhatsApp source routes and clears it", () => {
    const set = jest.fn();
    expect(
      setWhatsAppSelectionSessionCookie(
        { cookies: { set } },
        {
          accessToken: "EAAbusiness",
          workspaceId: "workspace-1",
          userId: "user-1",
        }
      )
    ).toBe(true);
    expect(set).toHaveBeenCalledWith(
      WHATSAPP_SELECTION_SESSION_COOKIE,
      expect.any(String),
      expect.objectContaining({
        httpOnly: true,
        sameSite: "lax",
        path: "/api/sources/whatsapp",
        maxAge: WHATSAPP_SELECTION_SESSION_MAX_AGE_SECONDS,
      })
    );

    clearWhatsAppSelectionSessionCookie({ cookies: { set } });
    expect(set).toHaveBeenLastCalledWith(
      WHATSAPP_SELECTION_SESSION_COOKIE,
      "",
      expect.objectContaining({ maxAge: 0, path: "/api/sources/whatsapp" })
    );
  });
});
