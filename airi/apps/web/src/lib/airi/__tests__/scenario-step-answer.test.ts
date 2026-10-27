import { readScenarioStepAnswerKind } from "@/lib/airi/reply/runtime/intent";
import type { AiriScenarioRuntimeConfig } from "@icecore/airi-runtime/scenario-runtime-types";

const scenarioRuntime = {
  scenarioId: "scenario-1",
} as AiriScenarioRuntimeConfig;
const sharedLocation = { latitude: 51.105938, longitude: 71.396126 };

describe("scenario step answers", () => {
  it("reads a stored location share as the step's answer", () => {
    expect(
      readScenarioStepAnswerKind({
        scenarioRuntime,
        newMessage: { whatsappLocation: sharedLocation },
      })
    ).toBe("location");
  });

  it("reads a picked option as the step's answer", () => {
    expect(
      readScenarioStepAnswerKind({
        scenarioRuntime,
        newMessage: {},
        quickReplyPayload: "wsc:node-1:option-1",
      })
    ).toBe("choice");
  });

  it("leaves typed text and turns outside a scenario to understanding", () => {
    expect(
      readScenarioStepAnswerKind({ scenarioRuntime, newMessage: {} })
    ).toBeNull();
    expect(
      readScenarioStepAnswerKind({
        scenarioRuntime: null,
        newMessage: { whatsappLocation: sharedLocation },
        quickReplyPayload: "wsc:node-1:option-1",
      })
    ).toBeNull();
  });
});
