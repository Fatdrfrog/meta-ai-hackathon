// Constants and request builders shared by the campaign pause, cancel and
// status route suites. jest.mock calls stay in each suite.

export const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
export const CAMPAIGN_ID = "11111111-1111-4111-8111-111111111111";

/** A JSON POST to /api/campaigns/:id/<action>. */
export function controlRequest(action: "pause" | "cancel", body: unknown) {
  return new Request(
    `https://airi.test/api/campaigns/${CAMPAIGN_ID}/${action}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }
  );
}

export function context(campaignId = CAMPAIGN_ID) {
  return { params: Promise.resolve({ campaignId }) };
}

/** What getAuthenticatedWorkspaceMembership resolves for a signed-in member. */
export function workspaceMembership(role = "manager") {
  return {
    user: { id: "33333333-3333-4333-8333-333333333333" },
    membership: { role },
    supabase: {},
  };
}
