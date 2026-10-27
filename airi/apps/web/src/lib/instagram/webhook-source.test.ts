import {
  buildInstagramSourceData,
  normalizeInstagramWebhookComment,
  resolveInstagramEndpointId,
} from "@/lib/instagram/webhook-source";

describe("Instagram webhook source helpers", () => {
  it("resolves sender endpoint ids in auth-method-specific order", () => {
    const credentials = {
      auth_method: "instagram_business_login",
      instagram_scoped_id: "scoped",
      instagram_business_account_id: "business",
      page_id: "page",
    };

    expect(resolveInstagramEndpointId(credentials, ["fallback"])).toBe(
      "scoped"
    );
    expect(
      resolveInstagramEndpointId(
        { ...credentials, auth_method: "facebook_login" },
        ["fallback"]
      )
    ).toBe("page");
  });

  it("builds handler source data once for comments and messaging events", () => {
    expect(
      buildInstagramSourceData(
        {
          id: "source-1",
          workspace_id: "workspace-1",
          credentials: {
            page_access_token: "token",
            auth_method: "facebook_login",
            page_id: "page",
            instagram_business_account_id: "business",
            instagram_scoped_id: "scoped",
            username: "airi",
          },
        } as never,
        ["recipient", "entry"]
      )
    ).toEqual({
      id: "source-1",
      workspace_id: "workspace-1",
      pageAccessToken: "token",
      pageId: "page",
      instagramScopedId: "scoped",
      instagramBusinessAccountId: "business",
      instagramUsername: "airi",
      authMethod: "facebook_login",
    });

    expect(
      buildInstagramSourceData(
        {
          id: "source-1",
          workspace_id: "workspace-1",
          credentials: {},
        } as never,
        ["entry"]
      )
    ).toBeNull();
  });

  it("normalizes nested comment webhook payloads without route-local casts", () => {
    expect(
      normalizeInstagramWebhookComment({
        id: 123,
        text: "Nice",
        timestamp: "2026-06-01T00:00:00Z",
        hidden: true,
        like_count: 7,
        from: { id: 456, username: "alice" },
        media: {
          id: 789,
          media_product_type: "FEED",
          media_type: "IMAGE",
          permalink: "https://instagram.com/p/x",
          shortcode: "x",
          timestamp: "2026-06-01T00:00:00Z",
          caption: "caption",
          media_url: "https://cdn.example/image.jpg",
          thumbnail_url: "https://cdn.example/thumb.jpg",
          username: "brand",
        },
      })
    ).toEqual({
      id: "123",
      text: "Nice",
      timestamp: "2026-06-01T00:00:00Z",
      hidden: true,
      like_count: 7,
      from: { id: "456", username: "alice" },
      media: {
        id: "789",
        media_product_type: "FEED",
        media_type: "IMAGE",
        permalink: "https://instagram.com/p/x",
        shortcode: "x",
        timestamp: "2026-06-01T00:00:00Z",
        caption: "caption",
        media_url: "https://cdn.example/image.jpg",
        thumbnail_url: "https://cdn.example/thumb.jpg",
        username: "brand",
      },
    });
  });
});
