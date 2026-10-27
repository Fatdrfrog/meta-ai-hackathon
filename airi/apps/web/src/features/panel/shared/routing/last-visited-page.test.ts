import {
  buildWorkspaceSwitchPath,
  normalizeLastVisitedHref,
  normalizeStoredLastVisitedPath,
} from "./last-visited-page";

const workspaceId = "11111111-1111-4111-8111-111111111111";

describe("last visited page normalization", () => {
  it("retains the analytics home when switching workspaces", () => {
    expect(
      normalizeStoredLastVisitedPath(`/panel/w/${workspaceId}/analytics`)
    ).toMatchObject({
      ok: true,
      path: `/panel/w/${workspaceId}/analytics`,
    });
  });
  it("remembers every analytics report, including Outcomes", () => {
    for (const report of ["bulk", "llm", "outcomes"])
      expect(
        normalizeStoredLastVisitedPath(
          `/panel/w/${workspaceId}/analytics/${report}`
        )
      ).toEqual({
        ok: true,
        workspaceId,
        path: `/panel/w/${workspaceId}/analytics/${report}`,
      });
  });
  it("keeps the Outcomes report when switching workspaces", () => {
    const targetWorkspaceId = "22222222-2222-4222-8222-222222222222";
    expect(
      buildWorkspaceSwitchPath(
        `/panel/w/${workspaceId}/analytics/outcomes`,
        targetWorkspaceId
      )
    ).toBe(`/panel/w/${targetWorkspaceId}/analytics/outcomes`);
  });
  it("accepts the airi.chat production origins", () => {
    expect(
      normalizeLastVisitedHref(`https://airi.chat/panel/w/${workspaceId}/airi`)
    ).toEqual({
      ok: true,
      workspaceId,
      path: `/panel/w/${workspaceId}/airi`,
    });

    expect(
      normalizeLastVisitedHref(
        `https://www.airi.chat/panel/w/${workspaceId}/requests`
      )
    ).toEqual({
      ok: true,
      workspaceId,
      path: `/panel/w/${workspaceId}/requests`,
    });
  });

  it("rejects foreign and localhost origins", () => {
    expect(
      normalizeLastVisitedHref(`https://evil.test/panel/w/${workspaceId}/airi`)
    ).toMatchObject({ ok: false, reason: "invalid_origin" });

    expect(
      normalizeLastVisitedHref(
        `http://localhost:3000/panel/w/${workspaceId}/airi`
      )
    ).toMatchObject({ ok: false, reason: "invalid_origin" });
  });

  it("rejects API, Next internals, static files, and unknown panel paths", () => {
    expect(
      normalizeLastVisitedHref(
        `https://airi.chat/api/workspaces/${workspaceId}`
      )
    ).toMatchObject({ ok: false });

    expect(
      normalizeLastVisitedHref(`https://airi.chat/_next/static/chunk.js`)
    ).toMatchObject({ ok: false });

    expect(
      normalizeLastVisitedHref(
        `https://airi.chat/panel/w/${workspaceId}/settings/team.json`
      )
    ).toMatchObject({ ok: false });

    expect(
      normalizeLastVisitedHref(
        `https://airi.chat/panel/w/${workspaceId}/does-not-exist`
      )
    ).toMatchObject({ ok: false, reason: "unknown_route" });
  });

  it("rejects non-workspace and invalid workspace paths", () => {
    expect(normalizeLastVisitedHref("https://airi.chat/panel")).toMatchObject({
      ok: false,
      reason: "invalid_path",
    });

    expect(
      normalizeLastVisitedHref("https://airi.chat/panel/w/not-a-uuid/airi")
    ).toMatchObject({
      ok: false,
      reason: "invalid_workspace",
    });
  });

  it("normalizes workspace roots to the Airi page", () => {
    expect(
      normalizeLastVisitedHref(`https://airi.chat/panel/w/${workspaceId}`)
    ).toEqual({
      ok: true,
      workspaceId,
      path: `/panel/w/${workspaceId}/airi`,
    });
  });

  it("preserves only useful request deep-link params", () => {
    expect(
      normalizeLastVisitedHref(
        `https://airi.chat/panel/w/${workspaceId}/requests?utm_source=x&message=m2&conversation=c1`
      )
    ).toEqual({
      ok: true,
      workspaceId,
      path: `/panel/w/${workspaceId}/requests?conversation=c1&message=m2`,
    });
  });

  it("strips arbitrary query params outside the requests page", () => {
    expect(
      normalizeLastVisitedHref(
        `https://airi.chat/panel/w/${workspaceId}/airi?source=onboarding`
      )
    ).toEqual({
      ok: true,
      workspaceId,
      path: `/panel/w/${workspaceId}/airi`,
    });
  });

  it("validates stored relative paths with the same route rules", () => {
    expect(
      normalizeStoredLastVisitedPath(`/panel/w/${workspaceId}/settings/team`)
    ).toEqual({
      ok: true,
      workspaceId,
      path: `/panel/w/${workspaceId}/settings/team`,
    });

    expect(normalizeStoredLastVisitedPath("//evil.test/panel")).toMatchObject({
      ok: false,
      reason: "invalid_path",
    });
  });

  it("remembers Settings → Offices, which redirects when its flag is off", () => {
    expect(
      normalizeLastVisitedHref(
        `https://airi.chat/panel/w/${workspaceId}/settings/business-locations`
      )
    ).toEqual({
      ok: true,
      workspaceId,
      path: `/panel/w/${workspaceId}/settings/business-locations`,
    });
  });

  it("remembers Products, which redirects when its flag is off or the user isn't an admin", () => {
    expect(
      normalizeLastVisitedHref(
        `https://airi.chat/panel/w/${workspaceId}/products`
      )
    ).toEqual({
      ok: true,
      workspaceId,
      path: `/panel/w/${workspaceId}/products`,
    });
  });

  it("repairs stored request links whose query was encoded into the pathname", () => {
    expect(
      normalizeStoredLastVisitedPath(
        `/panel/w/${workspaceId}/requests%3Fconversation=conversation_1&message=message_2`
      )
    ).toEqual({
      ok: true,
      workspaceId,
      path: `/panel/w/${workspaceId}/requests?conversation=conversation_1&message=message_2`,
    });
  });

  it("rejects decoded query characters inside panel route segments", () => {
    expect(
      normalizeStoredLastVisitedPath(`/panel/w/${workspaceId}/settings%3Fteam`)
    ).toMatchObject({ ok: false, reason: "invalid_path" });
  });

  it("preserves stable routes when switching workspaces", () => {
    const targetWorkspaceId = "22222222-2222-4222-8222-222222222222";

    expect(
      buildWorkspaceSwitchPath(
        `/panel/w/${workspaceId}/requests`,
        targetWorkspaceId
      )
    ).toBe(`/panel/w/${targetWorkspaceId}/requests`);

    expect(
      buildWorkspaceSwitchPath(
        `/panel/w/${workspaceId}/settings/team`,
        targetWorkspaceId
      )
    ).toBe(`/panel/w/${targetWorkspaceId}/settings/team`);

    expect(
      buildWorkspaceSwitchPath(
        `/panel/w/${workspaceId}/settings/business-locations`,
        targetWorkspaceId
      )
    ).toBe(`/panel/w/${targetWorkspaceId}/settings/business-locations`);

    expect(
      buildWorkspaceSwitchPath(
        `/panel/w/${workspaceId}/leads`,
        targetWorkspaceId
      )
    ).toBe(`/panel/w/${targetWorkspaceId}/leads`);
  });

  it("drops workspace-specific deep links when switching workspaces", () => {
    const targetWorkspaceId = "22222222-2222-4222-8222-222222222222";

    expect(
      buildWorkspaceSwitchPath(
        `/panel/w/${workspaceId}/kb/article-a`,
        targetWorkspaceId
      )
    ).toBe(`/panel/w/${targetWorkspaceId}/kb`);

    expect(
      buildWorkspaceSwitchPath(
        `/panel/w/${workspaceId}/does-not-exist`,
        targetWorkspaceId
      )
    ).toBe(`/panel/w/${targetWorkspaceId}/airi`);
  });
});
