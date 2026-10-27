/** @jest-environment node */
const mockAccess = jest.fn();
const mockCreate = jest.fn();
const mockWorkflow = jest.fn();
jest.mock("@/lib/supabase/workspace-api-access", () => ({
  requireWorkspaceApiAccess: (...args: unknown[]) => mockAccess(...args),
}));
jest.mock("@/lib/mongoose", () => ({ __esModule: true, default: jest.fn() }));
jest.mock("@/models/creative-asset", () => ({
  CreativeAsset: { create: (...args: unknown[]) => mockCreate(...args) },
}));
jest.mock("@/lib/temporal/client", () => ({
  ...jest.requireActual("@/lib/temporal/client"),
  isTemporalConfigured: () => true,
}));
jest.mock("@/lib/temporal/wan-morph", () => ({
  isTemporalConfigured: () => true,
  startWanMorphWorkflow: (...args: unknown[]) => mockWorkflow(...args),
}));
jest.mock("@/lib/elevenlabs/elevenlabs-source", () => ({
  resolveWorkspaceElevenLabsGenerationAccess: async () => ({
    available: true,
    apiKey: "audio-key",
  }),
}));
import { describeCustomerSourceGate } from "../customer-source-gate-test-utils";
import { GET, POST } from "./route";
describeCustomerSourceGate(
  "alibaba",
  { GET, POST },
  { mockAccess, mockCreate, mockWorkflow },
  body => expect(body.configured).toBe(false)
);
