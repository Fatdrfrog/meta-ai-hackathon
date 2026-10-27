import {
  WORKSPACE_ONBOARDING_STEP_IDS,
  buildWorkspaceOnboardingState,
  buildWorkspaceOnboardingUpsert,
  normalizeOnboardingCompletedSteps,
} from "./workspace-onboarding";
describe("workspace onboarding state", () => {
  it("starts new workspaces on the Airi test step after company profile setup", () => {
    const state = buildWorkspaceOnboardingState({
      workspaceId: "workspace-1",
      metrics: {
        successfulTestAnswersCount: 0,
        activeScenariosCount: 0,
        publishedKbArticlesCount: 0,
        verifiedSnippetsCount: 0,
        connectedSourcesCount: 0,
      },
      connectedSourceTypes: [],
    });

    expect(state.completed).toBe(false);
    expect(state.status).toBe("active");
    expect(state.currentStepId).toBe("test_airi");
    expect(state.completedStepIds).toEqual(["company_profile"]);
    expect(state.progress).toBeCloseTo(1 / 6);
    expect(state.integration.suggestedSourceType).toBe("whatsapp");
    expect(state.steps.find(step => step.id === "test_airi")?.href).toBe(
      "/panel/w/workspace-1/airi?source=onboarding"
    );
    expect(state.steps.map(step => step.id)).toEqual(
      WORKSPACE_ONBOARDING_STEP_IDS
    );
  });

  it("advances to scenario setup once any onboarding integration is connected", () => {
    const state = buildWorkspaceOnboardingState({
      workspaceId: "workspace-1",
      metrics: {
        successfulTestAnswersCount: 1,
        activeScenariosCount: 0,
        publishedKbArticlesCount: 0,
        verifiedSnippetsCount: 0,
        connectedSourcesCount: 1,
      },
      connectedSourceTypes: ["telegram"],
    });

    expect(state.currentStepId).toBe("create_scenario");
    expect(state.completedStepIds).toEqual([
      "company_profile",
      "test_airi",
      "connect_integration",
    ]);
    expect(state.integration.suggestedSourceType).toBe("whatsapp");
  });

  it("marks onboarding complete when every step target is met", () => {
    const state = buildWorkspaceOnboardingState({
      workspaceId: "workspace-1",
      metrics: {
        successfulTestAnswersCount: 1,
        activeScenariosCount: 1,
        publishedKbArticlesCount: 5,
        verifiedSnippetsCount: 5,
        connectedSourcesCount: 2,
      },
      connectedSourceTypes: ["whatsapp", "telegram"],
    });

    expect(state.completed).toBe(true);
    expect(state.status).toBe("completed");
    expect(state.currentStepId).toBeNull();
    expect(state.completedStepIds).toEqual([...WORKSPACE_ONBOARDING_STEP_IDS]);
    expect(state.progress).toBe(1);
    expect(state.integration.suggestedSourceType).toBe("instagram");
  });

  it("normalizes persisted completed steps and drops unknown values", () => {
    expect(
      normalizeOnboardingCompletedSteps([
        "company_profile",
        "connect_integration",
        "unknown",
        42,
        "company_profile",
      ])
    ).toEqual(["company_profile", "connect_integration"]);
  });

  it("builds a stable persistence payload and preserves completed_at once set", () => {
    const state = buildWorkspaceOnboardingState({
      workspaceId: "workspace-1",
      metrics: {
        successfulTestAnswersCount: 1,
        activeScenariosCount: 1,
        publishedKbArticlesCount: 5,
        verifiedSnippetsCount: 5,
        connectedSourcesCount: 1,
      },
      connectedSourceTypes: ["whatsapp"],
      persisted: {
        completed_at: "2026-05-01T00:00:00.000Z",
      },
    });

    expect(
      buildWorkspaceOnboardingUpsert(state, {
        now: "2026-05-08T12:00:00.000Z",
        previousCompletedAt: "2026-05-01T00:00:00.000Z",
      })
    ).toEqual({
      workspace_id: "workspace-1",
      current_step_id: null,
      completed_steps: [...WORKSPACE_ONBOARDING_STEP_IDS],
      status: "completed",
      completed_at: "2026-05-01T00:00:00.000Z",
      last_seen_at: "2026-05-08T12:00:00.000Z",
    });
  });
});
