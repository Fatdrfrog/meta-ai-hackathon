import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import type {
  AiriScenarioGenerativeAIResultEvent,
  AiriScenarioGenerativeAIWorkflowInput,
} from "@icecore/temporal";
import {
  acceptScenarioGenerativeAIImageActivityWithDependencies,
  acceptScenarioGenerativeAIVideoActivityWithDependencies,
  beginScenarioGenerativeAIActivityWithDependencies,
  importScenarioGenerativeAISourceActivityWithDependencies,
  reportScenarioGenerativeAIResultActivityWithDependencies,
  startScenarioGenerativeAIVideoActivityWithDependencies,
  type ScenarioGenerativeAIExecutionOwner,
  type ScenarioGenerativeAIVideoAsset,
  type ScenarioGenerativeAIImageAsset,
} from "./activities/scenario-generative-ai.js";

const root = dirname(fileURLToPath(import.meta.url));
const read = (...parts: string[]) => readFileSync(join(root, ...parts), "utf8");

const workflow = read("workflows", "scenario-generative-ai.ts");
const activities = read("activities", "scenario-generative-ai.ts");
const workflowIndex = read("workflows", "index.ts");
const worker = read("worker.ts");
const replayExport = read("export-replay-histories.ts");

const COMMAND: AiriScenarioGenerativeAIWorkflowInput = {
  version: 1,
  kind: "start_generative_ai_scenario",
  workflowId: "scenario-generation:execution-1",
  workspaceId: "workspace-1",
  conversationId: "conversation-1",
  executionId: "execution-1",
  scenarioId: "scenario-1",
  scenarioRevisionFingerprint: "a".repeat(64),
  actionNodeId: "action-1",
};

function execution(
  phase: ScenarioGenerativeAIExecutionOwner["phase"],
  mode: ScenarioGenerativeAIExecutionOwner["mode"] = "text_to_video",
): ScenarioGenerativeAIExecutionOwner {
  return {
    executionId: COMMAND.executionId,
    phase,
    scenarioId: COMMAND.scenarioId,
    scenarioRevisionFingerprint: COMMAND.scenarioRevisionFingerprint,
    actionNodeId: COMMAND.actionNodeId,
    inputMessageId: "inbound-1",
    mode,
    composedPrompt: "Create a concise product reveal",
    scenarioWorkflowId: COMMAND.workflowId,
    sourceMedia:
      mode === "image_to_video"
        ? {
            whatsappMediaId: "whatsapp-media-1",
            declaredMimeType: "image/jpeg",
            fileName: "source.jpg",
          }
        : null,
  };
}

function videoAsset(): ScenarioGenerativeAIVideoAsset {
  return {
    _id: "asset-1",
    workspaceId: COMMAND.workspaceId,
    status: "queued",
    generation: {
      contractVersion: 1,
      submission: { attemptToken: "attempt-1" },
      orchestration: {
        completionTarget: {
          workflowId: COMMAND.workflowId,
          signalName: "airi.scenarioGenerativeAI.videoCompletion",
          correlationId: COMMAND.executionId,
        },
      },
    },
  } as unknown as ScenarioGenerativeAIVideoAsset;
}

test("begin advances once and recovers the destination phase on retry", async () => {
  let owner = execution("accepted");
  let advances = 0;
  const dependencies = {
    mediaTaskQueue: () => "airi-media",
    loadOwned: async (
      _input: AiriScenarioGenerativeAIWorkflowInput,
      expectedPhase: ScenarioGenerativeAIExecutionOwner["phase"],
    ) => (owner.phase === expectedPhase ? owner : null),
    advance: async (input: {
      expectedPhase: ScenarioGenerativeAIExecutionOwner["phase"];
      nextPhase: ScenarioGenerativeAIExecutionOwner["phase"];
    }) => {
      if (owner.phase !== input.expectedPhase) return null;
      advances += 1;
      owner = { ...owner, phase: input.nextPhase };
      return owner;
    },
  };

  const first = await beginScenarioGenerativeAIActivityWithDependencies(
    COMMAND,
    dependencies,
  );
  const replay = await beginScenarioGenerativeAIActivityWithDependencies(
    COMMAND,
    dependencies,
  );

  assert.deepEqual(first, {
    contractVersion: 1,
    mode: "text_to_video",
    phase: "preparing_generation",
    mediaTaskQueue: "airi-media",
  });
  assert.deepEqual(replay, first);
  assert.equal(advances, 1);
});

for (const [provider, modelId] of [
  ["google", "gemini-3.1-flash-image"],
  ["elevenlabs", "gpt-image-2.5-flare"],
] as const)
  test(`image preparation pins authored ${provider} settings and recovers one durable asset on replay`, async () => {
    const imageConfig = {
      provider,
      sourceId: "11111111-1111-4111-8111-111111111111",
      modelId,
      aspectRatio: "16:9" as const,
      referenceImages: [],
      includeInboundText: true,
    };
    let owner: ScenarioGenerativeAIExecutionOwner = {
      ...execution("preparing_generation", "text_to_image"),
      imageConfig,
    };
    let asset: ScenarioGenerativeAIImageAsset | null = null;
    let creations = 0;
    const sources: unknown[] = [];
    const lookups: Array<{ assetId?: string }> = [];
    const dependencies = {
      loadOwned: async (
        _input: AiriScenarioGenerativeAIWorkflowInput,
        phase: ScenarioGenerativeAIExecutionOwner["phase"],
      ) => (owner.phase === phase ? owner : null),
      advance: async (input: {
        nextPhase: ScenarioGenerativeAIExecutionOwner["phase"];
        updates?: { assetId?: string; videoWorkflowId?: string };
      }) => {
        owner = { ...owner, phase: input.nextPhase, ...input.updates };
        return owner;
      },
      findAcceptedImage: async (scope: { assetId?: string }) => {
        lookups.push(scope);
        return asset;
      },
      assertSource: async (input: unknown) => {
        sources.push(input);
      },
      createImage: async (input: ScenarioGenerativeAIImageAsset) => {
        creations++;
        asset = input;
        return input;
      },
    };
    const first = await acceptScenarioGenerativeAIImageActivityWithDependencies(
      COMMAND,
      dependencies,
    );
    const replay =
      await acceptScenarioGenerativeAIImageActivityWithDependencies(
        COMMAND,
        dependencies,
      );
    assert.deepEqual(replay, first);
    assert.equal(creations, 1);
    assert.equal(lookups[0]?.assetId, first.assetId);
    assert.equal(lookups[1]?.assetId, first.assetId);
    assert.deepEqual(sources, [
      {
        workspaceId: COMMAND.workspaceId,
        provider,
        providerSourceId: imageConfig.sourceId,
      },
    ]);
    // The asset and the generation run with the provider the step chose.
    const created = asset as ScenarioGenerativeAIImageAsset | null;
    assert.equal(created?.source, provider);
    assert.equal(created?.provider, provider);
    assert.equal(first.imageInput.provider, provider);
    assert.equal(first.imageInput.prompt, owner.composedPrompt);
    assert.equal(first.imageInput.modelId, imageConfig.modelId);
    assert.equal(first.imageInput.providerSourceId, imageConfig.sourceId);
    assert.deepEqual(
      first.imageInput.referenceImages,
      imageConfig.referenceImages,
    );
    assert.equal(owner.phase, "generating");
    assert.equal(owner.videoWorkflowId, first.videoWorkflowId);
    assert.equal(JSON.stringify(first).includes("apiKey"), false);
  });

test("image preparation rejects an invalid source before creating an asset", async () => {
  let creations = 0;
  await assert.rejects(
    acceptScenarioGenerativeAIImageActivityWithDependencies(COMMAND, {
      loadOwned: async () => ({
        ...execution("preparing_generation", "text_to_image"),
        imageConfig: {
          provider: "google",
          sourceId: "11111111-1111-4111-8111-111111111111",
          modelId: "gemini-3.1-flash-image",
          aspectRatio: "1:1",
          referenceImages: [],
          includeInboundText: true,
        },
      }),
      advance: async () => null,
      findAcceptedImage: async () => null,
      assertSource: async () => {
        throw new Error("own_ai_source_required");
      },
      createImage: async (value) => {
        creations++;
        return value;
      },
    }),
    /own_ai_source_required/,
  );
  assert.equal(creations, 0);
});

test("image preparation rejects oversized composed prompts before asset creation and preserves the exact limit", async () => {
  const atLimitPrompt = "Аяла\nМедаль ұстағыш".padEnd(16000, "қ");
  const owner: ScenarioGenerativeAIExecutionOwner = {
    ...execution("preparing_generation", "text_to_image"),
    composedPrompt: `${atLimitPrompt}!`,
    imageConfig: {
      provider: "google",
      sourceId: "11111111-1111-4111-8111-111111111111",
      modelId: "gemini-3.1-flash-image",
      aspectRatio: "16:9",
      referenceImages: [],
      includeInboundText: true,
    },
  };
  const assets: ScenarioGenerativeAIImageAsset[] = [];
  const dependencies = {
    loadOwned: async (
      _input: AiriScenarioGenerativeAIWorkflowInput,
      phase: ScenarioGenerativeAIExecutionOwner["phase"],
    ) => (phase === "preparing_generation" ? owner : null),
    advance: async () => null,
    findAcceptedImage: async () => null,
    assertSource: async () => {},
    createImage: async (asset: ScenarioGenerativeAIImageAsset) => {
      assets.push(asset);
      return asset;
    },
  };
  await assert.rejects(
    acceptScenarioGenerativeAIImageActivityWithDependencies(
      COMMAND,
      dependencies,
    ),
    /image prompt is invalid/,
  );
  assert.equal(assets.length, 0);

  owner.composedPrompt = atLimitPrompt;
  const accepted =
    await acceptScenarioGenerativeAIImageActivityWithDependencies(
      COMMAND,
      dependencies,
    );
  assert.equal(assets.length, 1);
  assert.equal(assets[0]?.prompt, atLimitPrompt);
  assert.equal(accepted.imageInput.prompt, atLimitPrompt);
});

test("image workflow branch awaits the canonical media child before reporting its terminal result", () => {
  const imageBranch = workflow.slice(
    workflow.indexOf('if (begin.mode === "text_to_image")'),
    workflow.indexOf('if (begin.mode === "image_to_video")'),
  );
  assert.match(
    imageBranch,
    /AIRI_SCENARIO_GENERATIVE_AI_ACCEPT_IMAGE_ACTIVITY/,
  );
  assert.match(
    imageBranch,
    /await executeChild[\s\S]*CREATIVE_IMAGE_GENERATION_WORKFLOW/,
  );
  assert.match(imageBranch, /taskQueue: begin.mediaTaskQueue/);
  assert.match(imageBranch, /args: \[accepted.imageInput\]/);
  assert.match(imageBranch, /workflowIdReusePolicy: "REJECT_DUPLICATE"/);
  assert.match(imageBranch, /await reportUntilProcessed/);
  assert.doesNotMatch(
    imageBranch,
    /acceptScenarioGenerativeAIVideo|startScenarioGenerativeAIVideo/,
  );
  assert.match(worker, /AIRI_SCENARIO_GENERATIVE_AI_ACCEPT_IMAGE_ACTIVITY/);
});

test("begin rejects a media task queue beyond Temporal's bound", async () => {
  await assert.rejects(
    beginScenarioGenerativeAIActivityWithDependencies(COMMAND, {
      mediaTaskQueue: () => "q".repeat(257),
      loadOwned: async (_input, expectedPhase) =>
        expectedPhase === "preparing_generation"
          ? execution("preparing_generation")
          : null,
      advance: async () => null,
    }),
    /media task queue is invalid/,
  );
});

test("imports the exact persisted image identity once per activity execution", async () => {
  const owner = execution("importing_source", "image_to_video");
  const imported: unknown[] = [];

  const result = await importScenarioGenerativeAISourceActivityWithDependencies(
    COMMAND,
    {
      loadOwned: async () => owner,
      importSource: async (input) => {
        imported.push(input);
        return {
          assetId: "source-asset-1",
          mimeType: "image/jpeg",
          fileSize: 123,
        };
      },
    },
  );

  assert.deepEqual(result, {
    contractVersion: 1,
    sourceAssetId: "source-asset-1",
  });
  assert.deepEqual(imported, [
    {
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      inputMessageId: "inbound-1",
      whatsappMediaId: "whatsapp-media-1",
      declaredMimeType: "image/jpeg",
      fileName: "source.jpg",
    },
  ]);
});

test("accepts the fixed recipe once and recovers attempt identity after CAS", async () => {
  let owner: ScenarioGenerativeAIExecutionOwner = execution(
    "preparing_generation",
  );
  const asset = videoAsset();
  let accepts = 0;
  let persistedAsset: ScenarioGenerativeAIVideoAsset | null = null;
  const acceptedInputs: unknown[] = [];
  const dependencies = {
    loadOwned: async (
      _input: AiriScenarioGenerativeAIWorkflowInput,
      expectedPhase: ScenarioGenerativeAIExecutionOwner["phase"],
    ) => (owner.phase === expectedPhase ? owner : null),
    advance: async (input: {
      expectedPhase: ScenarioGenerativeAIExecutionOwner["phase"];
      nextPhase: ScenarioGenerativeAIExecutionOwner["phase"];
      updates?: { assetId?: string; videoWorkflowId?: string };
    }) => {
      if (owner.phase !== input.expectedPhase) return null;
      owner = {
        ...owner,
        phase: input.nextPhase,
        assetId: input.updates?.assetId,
        videoWorkflowId: input.updates?.videoWorkflowId,
      };
      return owner;
    },
    acceptVideo: async (input: unknown) => {
      accepts += 1;
      acceptedInputs.push(input);
      persistedAsset = asset;
      return {
        asset,
        workflowInput: {
          contractVersion: 1 as const,
          workspaceId: COMMAND.workspaceId,
          assetId: "asset-1",
          attemptToken: "attempt-1",
        },
      };
    },
    findAcceptedVideo: async () => persistedAsset,
  };

  const first = await acceptScenarioGenerativeAIVideoActivityWithDependencies(
    { ...COMMAND, sourceAssetId: null },
    dependencies,
  );
  const replay = await acceptScenarioGenerativeAIVideoActivityWithDependencies(
    { ...COMMAND, sourceAssetId: null },
    dependencies,
  );

  assert.deepEqual(first, replay);
  assert.deepEqual(first, {
    contractVersion: 1,
    assetId: "asset-1",
    attemptToken: "attempt-1",
    videoWorkflowId: "video-generation:asset-1",
  });
  assert.equal(accepts, 1);
  assert.deepEqual(acceptedInputs, [
    {
      workspaceId: "workspace-1",
      createdBy: null,
      idempotencyKey: "execution-1",
      providerPolicy: { provider: "happyhorse" },
      request: {
        mode: "text_to_video",
        skill: "video",
        prompt: "Create a concise product reveal",
        durationSeconds: 5,
        resolution: "720P",
        aspectRatio: "9:16",
      },
      completionTarget: {
        workflowId: "scenario-generation:execution-1",
        signalName: "airi.scenarioGenerativeAI.videoCompletion",
        correlationId: "execution-1",
      },
    },
  ]);
});

test("keeps the accepted asset target alive when the owner is concurrently cleared", async () => {
  let owner: ScenarioGenerativeAIExecutionOwner | null = execution(
    "preparing_generation",
    "image_to_video",
  );
  const asset = videoAsset();
  let persistedAsset: ScenarioGenerativeAIVideoAsset | null = null;
  let accepts = 0;

  const dependencies = {
    loadOwned: async (
      _input: AiriScenarioGenerativeAIWorkflowInput,
      expectedPhase: ScenarioGenerativeAIExecutionOwner["phase"],
    ) => (owner?.phase === expectedPhase ? owner : null),
    advance: async (input: {
      expectedPhase: ScenarioGenerativeAIExecutionOwner["phase"];
      nextPhase: ScenarioGenerativeAIExecutionOwner["phase"];
      updates?: { assetId?: string; videoWorkflowId?: string };
    }) => {
      if (input.expectedPhase === "preparing_generation") {
        owner = null;
        return null;
      }
      return null;
    },
    acceptVideo: async () => {
      accepts += 1;
      persistedAsset = asset;
      return {
        asset,
        workflowInput: {
          contractVersion: 1 as const,
          workspaceId: COMMAND.workspaceId,
          assetId: "asset-1",
          attemptToken: "attempt-1",
        },
      };
    },
    findAcceptedVideo: async () => persistedAsset,
  };

  const result = await acceptScenarioGenerativeAIVideoActivityWithDependencies(
    { ...COMMAND, sourceAssetId: "source-asset-1" },
    dependencies,
  );
  const replay = await acceptScenarioGenerativeAIVideoActivityWithDependencies(
    { ...COMMAND, sourceAssetId: "source-asset-1" },
    dependencies,
  );

  assert.equal(accepts, 1);
  assert.equal(result.attemptToken, "attempt-1");
  assert.deepEqual(replay, result);
});

test("keeps the accepted target alive when a conflicting owner is present", async () => {
  const asset = videoAsset();
  let advances = 0;
  let accepts = 0;

  const result = await acceptScenarioGenerativeAIVideoActivityWithDependencies(
    { ...COMMAND, sourceAssetId: null },
    {
      loadOwned: async (_input, expectedPhase) =>
        expectedPhase === "generating"
          ? {
              ...execution("generating"),
              scenarioWorkflowId: "scenario-generation:newer-execution",
              assetId: "newer-asset",
              videoWorkflowId: "video-generation:newer-asset",
            }
          : null,
      advance: async () => {
        advances += 1;
        return null;
      },
      acceptVideo: async () => {
        accepts += 1;
        throw new Error("accepted asset replay must not call accept");
      },
      findAcceptedVideo: async () => asset,
    },
  );

  assert.deepEqual(result, {
    contractVersion: 1,
    assetId: "asset-1",
    attemptToken: "attempt-1",
    videoWorkflowId: "video-generation:asset-1",
  });
  assert.equal(accepts, 0);
  assert.equal(advances, 0);
});

test("start validates the persisted asset and delegates one canonical start", async () => {
  const asset = videoAsset();
  const starts: ScenarioGenerativeAIVideoAsset[] = [];

  const result = await startScenarioGenerativeAIVideoActivityWithDependencies(
    {
      ...COMMAND,
      contractVersion: 1,
      assetId: "asset-1",
      attemptToken: "attempt-1",
      videoWorkflowId: "video-generation:asset-1",
    },
    {
      loadVideoAsset: async () => asset,
      ensureStarted: async (value) => {
        starts.push(value);
        return value;
      },
    },
  );

  assert.equal(starts.length, 1);
  assert.equal(starts[0], asset);
  assert.deepEqual(result, {
    contractVersion: 1,
    assetId: "asset-1",
    videoWorkflowId: "video-generation:asset-1",
  });
});

test("report delegates the exact normalized result event", async () => {
  const event: AiriScenarioGenerativeAIResultEvent = {
    kind: "generative_ai_result",
    workspaceId: "workspace-1",
    conversationId: "conversation-1",
    messageId: "execution-1",
    executionId: "execution-1",
    scenarioWorkflowId: "scenario-generation:execution-1",
    videoWorkflowId: "video-generation:asset-1",
    assetId: "asset-1",
    terminal: {
      state: "complete",
      code: "generation_complete",
      attemptToken: "attempt-1",
    },
  };
  const reports: AiriScenarioGenerativeAIResultEvent[] = [];

  await reportScenarioGenerativeAIResultActivityWithDependencies(event, {
    report: async (value) => {
      reports.push(value);
    },
  });

  assert.deepEqual(reports, [event]);
  await assert.rejects(
    reportScenarioGenerativeAIResultActivityWithDependencies(
      { ...event, messageId: "different" },
      { report: async () => undefined },
    ),
    /messageId/,
  );
});

test("installs completion and processed handlers before the first activity", () => {
  const completionHandler = workflow.indexOf(
    "setHandler(videoCompletionSignal",
  );
  const processedHandler = workflow.indexOf("setHandler(resultProcessedSignal");
  const firstActivity = workflow.indexOf("await beginScenarioGenerativeAI");

  assert.ok(completionHandler >= 0);
  assert.ok(processedHandler >= 0);
  assert.ok(firstActivity > completionHandler);
  assert.ok(firstActivity > processedHandler);
  assert.match(
    workflow,
    /const actualWorkflowId = workflowInfo\(\)\.workflowId[\s\S]*normalizedInput\.workflowId !== actualWorkflowId/,
  );
});

test("imports only image input on the media queue and preserves phase order", () => {
  assert.match(
    workflow,
    /begin\.mode\s*===\s*"image_to_video"[\s\S]*await importScenarioGenerativeAISource/,
  );
  assert.equal(
    workflow.match(/await importScenarioGenerativeAISource\(/g)?.length,
    1,
  );
  assert.match(
    workflow,
    /taskQueue:\s*begin\.mediaTaskQueue[\s\S]*AIRI_SCENARIO_GENERATIVE_AI_IMPORT_SOURCE_ACTIVITY/,
  );
  assert.match(
    activities,
    /accepted[\s\S]*importing_source[\s\S]*preparing_generation[\s\S]*generating/,
  );
});

test("accepts one fixed HappyHorse recipe before starting its canonical workflow", () => {
  assert.match(activities, /acceptVideoGeneration/);
  assert.match(activities, /provider:\s*"happyhorse"/);
  assert.match(activities, /durationSeconds:\s*5/);
  assert.match(activities, /resolution:\s*"720P"/);
  assert.match(activities, /aspectRatio:\s*"9:16"/);
  assert.match(
    activities,
    /signalName:\s*AIRI_SCENARIO_GENERATIVE_AI_VIDEO_COMPLETION_SIGNAL/,
  );
  assert.match(activities, /ensureVideoGenerationWorkflowStarted/);

  const acceptIndex = workflow.indexOf("await acceptScenarioGenerativeAIVideo");
  const startIndex = workflow.indexOf("await startScenarioGenerativeAIVideo");
  const waitIndex = workflow.indexOf("await condition", startIndex);
  assert.ok(acceptIndex >= 0);
  assert.ok(startIndex > acceptIndex);
  assert.ok(waitIndex > startIndex);
  assert.doesNotMatch(workflow, /CreativeAsset|Conversation|mongoose|Mongo/);
});

test("reports bounded terminal events repeatedly until the processed signal", () => {
  assert.match(activities, /signalWithStartAiriConversationExternalEvent/);
  assert.match(
    workflow,
    /while\s*\(!isProcessed\(\)\)[\s\S]*await reportScenarioGenerativeAIResult[\s\S]*condition\(\(\)\s*=>\s*isProcessed\(\)/,
  );
  assert.match(workflow, /AIRI_SCENARIO_GENERATIVE_AI_RESULT_PROCESSED_SIGNAL/);
  assert.match(workflow, /continueAsNew[\s\S]*reporting:/);
  assert.match(workflow, /workflowInfo\(\)\.continueAsNewSuggested/);
  assert.match(workflow, /source_import_failed/);
  assert.match(workflow, /generation_preparation_failed/);
  assert.match(workflow, /generation_start_failed/);
  assert.doesNotMatch(workflow, /error\.message|String\(error\)/);
});

test("registers workflow, main activities, media import, and replay export", () => {
  assert.match(workflowIndex, /airiScenarioGenerativeAIWorkflow/);
  assert.match(worker, /AIRI_SCENARIO_GENERATIVE_AI_BEGIN_ACTIVITY/);
  assert.match(worker, /AIRI_SCENARIO_GENERATIVE_AI_ACCEPT_VIDEO_ACTIVITY/);
  assert.match(worker, /AIRI_SCENARIO_GENERATIVE_AI_START_VIDEO_ACTIVITY/);
  assert.match(worker, /AIRI_SCENARIO_GENERATIVE_AI_REPORT_RESULT_ACTIVITY/);
  assert.equal(
    worker.match(/AIRI_SCENARIO_GENERATIVE_AI_IMPORT_SOURCE_ACTIVITY/g)?.length,
    3,
    "the import constant is imported and registered in both worker maps",
  );
  assert.match(replayExport, /AIRI_SCENARIO_GENERATIVE_AI_WORKFLOW/);
});

test("keeps preparation and start idempotent across safe activity retries", () => {
  assert.match(activities, /generation\.requestIdempotencyKey/);
  assert.match(activities, /loadGenerativeExecutionIfOwned/);
  assert.match(activities, /acceptVideoGeneration/);
  assert.match(activities, /idempotencyKey:\s*input\.executionId/);
  assert.match(
    activities,
    /buildVideoGenerationWorkflowId[\s\S]*advanceGenerativeExecutionPhase/,
  );
  assert.match(
    activities,
    /generation\.submission\.attemptToken[\s\S]*ensureVideoGenerationWorkflowStarted/,
  );
  assert.doesNotMatch(activities, /queueVideoGeneration/);
  const acceptPolicy = workflow.slice(
    workflow.indexOf("const acceptActivities"),
    workflow.indexOf("const startActivities"),
  );
  const startPolicy = workflow.slice(
    workflow.indexOf("const startActivities"),
    workflow.indexOf("const reportActivities"),
  );
  assert.doesNotMatch(acceptPolicy, /maximumAttempts/);
  assert.doesNotMatch(startPolicy, /maximumAttempts/);
});
