import assert from "node:assert/strict";
import { it } from "node:test";
import {
  buildWhatsAppFlowEndpointTopology,
  WhatsAppFlowEndpointTopologyError,
} from "./whatsapp-flow-endpoint.ts";

it("reports routing limit failures with a stable contract code", () => {
  const screens = Array.from({ length: 12 }, (_, index) => ({
    id: `SCREEN_${index}`,
    title: `Screen ${index}`,
    fields: [],
  }));

  assert.throws(
    () =>
      buildWhatsAppFlowEndpointTopology({
        templateId: "endpoint",
        ctaText: "Open",
        flowNavigationMode: "data_endpoint",
        screens,
      }),
    (error: unknown) =>
      error instanceof WhatsAppFlowEndpointTopologyError &&
      error.code === "routing_edge_limit_exceeded",
  );
});
