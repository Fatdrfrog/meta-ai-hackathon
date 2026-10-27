import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCreateCommand,
  buildMissingInstanceMessage,
  buildNetworkUri,
  buildPscAutoConnectionsArg,
  buildServiceDisabledMessage,
  classifyGcloudError,
  extractEndpoint,
  readBooleanFlag,
} from "./resolve-valkey-endpoint.mjs";

test("defaults boolean flags to explicit truthy values only", () => {
  assert.equal(readBooleanFlag(undefined), false);
  assert.equal(readBooleanFlag("false"), false);
  assert.equal(readBooleanFlag("1"), true);
  assert.equal(readBooleanFlag("true"), true);
});

test("builds Valkey PSC network values without duplicating full network URIs", () => {
  assert.equal(
    buildNetworkUri("project-1", "default"),
    "projects/project-1/global/networks/default",
  );
  assert.equal(
    buildNetworkUri("project-1", "projects/other/global/networks/shared"),
    "projects/other/global/networks/shared",
  );
});

test("builds the Valkey create command used by the deploy workflow", () => {
  const pscAutoConnections = buildPscAutoConnectionsArg(
    "project-1",
    "projects/project-1/global/networks/default",
  );

  assert.equal(
    pscAutoConnections,
    "network=projects/project-1/global/networks/default,projectId=project-1",
  );
  assert.deepEqual(
    buildCreateCommand({
      projectId: "project-1",
      location: "europe-west1",
      instance: "airi-otp-valkey",
      pscAutoConnections,
    }),
    [
      "memorystore",
      "instances",
      "create",
      "airi-otp-valkey",
      "--project=project-1",
      "--location=europe-west1",
      `--psc-auto-connections=${pscAutoConnections}`,
      "--mode=cluster-disabled",
      "--node-type=custom-pico",
      "--shard-count=1",
      "--replica-count=0",
    ],
  );
});

test("classifies disabled Memorystore API errors before missing-instance handling", () => {
  assert.equal(
    classifyGcloudError(
      "PERMISSION_DENIED: Memorystore API has not been used in project icecore-ai before or it is disabled. reason: SERVICE_DISABLED",
    ),
    "service_disabled",
  );
  assert.match(
    buildServiceDisabledMessage("icecore-ai"),
    /gcloud services enable memorystore\.googleapis\.com networkconnectivity\.googleapis\.com --project=icecore-ai/,
  );
});

test("missing instance message keeps billable infra creation explicit", () => {
  assert.match(
    buildMissingInstanceMessage({
      instance: "airi-otp-valkey",
      location: "europe-west1",
    }),
    /Normal deploy does not create billable infra by default/,
  );
});

test("extracts endpoints from PSC and discovery response shapes", () => {
  assert.deepEqual(
    extractEndpoint({
      endpoints: [
        {
          connections: [
            {
              pscAutoConnection: {
                ipAddress: "10.1.2.3",
                port: 6379,
              },
            },
          ],
        },
      ],
    }),
    { host: "10.1.2.3", port: "6379" },
  );
  assert.deepEqual(
    extractEndpoint({
      discoveryEndpoints: [{ address: "10.4.5.6" }],
    }),
    { host: "10.4.5.6", port: "6379" },
  );
});
