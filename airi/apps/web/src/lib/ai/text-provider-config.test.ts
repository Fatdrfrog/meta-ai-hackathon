const mockCanUseVertexAI = jest.fn();
const mockCanUseAnthropicAI = jest.fn(() => false);
jest.mock("./vertex-config", () => ({
  canUseVertexAI: () => mockCanUseVertexAI(),
}));
jest.mock("./anthropic-config", () => ({
  canUseAnthropicAI: () => mockCanUseAnthropicAI(),
}));

import { canUseTextAI } from "./text-provider-config";
import { withWorkspaceTextAiAction } from "./workspace-ai-policy";

it("lets an established customer action reach admission without platform credentials", async () => {
  mockCanUseVertexAI.mockReturnValue(false);
  expect(canUseTextAI()).toBe(false);
  await withWorkspaceTextAiAction(
    { workspaceId: "w", actionId: "action" },
    async () => {
      expect(canUseTextAI()).toBe(true);
    }
  );
  expect(canUseTextAI()).toBe(false);
});

it("preserves platform availability for unscoped infrastructure", () => {
  mockCanUseVertexAI.mockReturnValue(true);
  expect(canUseTextAI()).toBe(true);
});

it("reports platform availability when only Anthropic is configured", () => {
  mockCanUseVertexAI.mockReturnValue(false);
  mockCanUseAnthropicAI.mockReturnValue(true);
  expect(canUseTextAI()).toBe(true);
});
