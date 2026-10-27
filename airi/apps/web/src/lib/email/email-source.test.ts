import {
  buildEmailSourceCredentials,
  isEmailSourceConfigured,
  parseEmailSourceCredentials,
} from "./email-source";
import type { EmailSource } from "@icecore/shared/types/sources";

describe("email-source helpers", () => {
  it("builds normalized email source credentials", () => {
    expect(
      buildEmailSourceCredentials({
        emailAddress: "Support@Example.com",
        providerId: "provider-1",
        providerStatus: "active",
        verificationStatus: "connected",
        status: "active",
        addressIds: ["addr-1", "addr-2"],
      })
    ).toEqual({
      email_address: "support@example.com",
      provider: "postmark",
      provider_id: "provider-1",
      provider_status: "active",
      verification_status: "connected",
      status: "active",
      address_ids: ["addr-1", "addr-2"],
      postmark_stream_outbound: "outbound",
      connected_at: expect.any(String),
    });
  });

  it("parses and validates configured email sources", () => {
    const source = {
      id: "source-1",
      workspace_id: "workspace-1",
      type: "email",
      credentials: buildEmailSourceCredentials({
        emailAddress: "support@example.com",
        providerId: "provider-1",
        providerStatus: "active",
        verificationStatus: "connected",
        status: "active",
      }),
    } as EmailSource;

    expect(parseEmailSourceCredentials(source.credentials)?.email_address).toBe(
      "support@example.com"
    );
    expect(isEmailSourceConfigured(source)).toBe(true);
    expect(
      isEmailSourceConfigured({
        ...source,
        credentials: {
          ...source.credentials,
          status: "inactive",
        },
      })
    ).toBe(false);
  });
});
