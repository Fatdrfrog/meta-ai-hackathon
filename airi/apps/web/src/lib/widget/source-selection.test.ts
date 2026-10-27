import { findPrimaryWebWidgetSource } from "./source-selection";

const baseSource = {
  id: "source-1",
  company_id: "company-1",
  workspace_id: "workspace-1",
  name: "Website",
  type: "web_widget" as const,
};

describe("findPrimaryWebWidgetSource", () => {
  it("ignores onboarding test widget sources", () => {
    const source = findPrimaryWebWidgetSource([
      {
        ...baseSource,
        id: "onboarding",
        created_at: "2026-06-22T10:00:00.000Z",
        credentials: {
          client_key: "widget_onboarding",
          allowed_domains: [],
          onboarding_test: true,
          status: "active" as const,
        },
      },
      {
        ...baseSource,
        id: "real",
        created_at: "2026-06-21T10:00:00.000Z",
        credentials: {
          client_key: "widget_real",
          allowed_domains: ["airi.chat"],
          status: "active" as const,
        },
      },
    ]);

    expect(source?.id).toBe("real");
  });

  it("prefers active sources and then the newest source", () => {
    const source = findPrimaryWebWidgetSource([
      {
        ...baseSource,
        id: "new-inactive",
        created_at: "2026-06-22T10:00:00.000Z",
        credentials: {
          client_key: "widget_new",
          allowed_domains: ["new.example.com"],
          status: "inactive" as const,
        },
      },
      {
        ...baseSource,
        id: "old-active",
        created_at: "2026-06-20T10:00:00.000Z",
        credentials: {
          client_key: "widget_old",
          allowed_domains: ["old.example.com"],
          status: "active" as const,
        },
      },
    ]);

    expect(source?.id).toBe("old-active");
  });
});
