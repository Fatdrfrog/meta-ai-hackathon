import {
  MetaGraphRequestError,
  type WhatsAppGraphClient,
} from "@icecore/shared/lib/meta/api";

const cacheStore = new Map<string, unknown>();
const cacheControl = { failReads: false };
const mockCache = {
  get: jest.fn(async (key: string) => {
    if (cacheControl.failReads) throw new Error("redis down");
    return cacheStore.has(key) ? cacheStore.get(key) : null;
  }),
  set: jest.fn(async (key: string, value: unknown) => {
    cacheStore.set(key, value);
  }),
  del: jest.fn(async (key: string) => {
    cacheStore.delete(key);
  }),
};

jest.mock("@icecore/shared/lib/cache", () => ({
  ...jest.requireActual("@icecore/shared/lib/cache"),
  cache: {
    get: (key: string) => mockCache.get(key),
    set: (key: string, value: unknown) => mockCache.set(key, value),
    del: (key: string) => mockCache.del(key),
  },
}));

import { DEMOSHOP_FLOW_JSON } from "@/components/scenarios/builders/whatsapp/flow-json-fixtures";
import { invalidateTemplateFlowFacts } from "./template-flow-facts-cache";
import { readTemplateFlowFacts } from "./template-flow-facts";

const WABA_ID = "102116369487468";
const FLOW_ID = "2244981489363579";
const NOW = new Date("2026-09-28T12:00:00.000Z");

type FakeFlow = {
  status?: string;
  name?: string;
  wabaId?: string;
  screens?: string[] | null;
  /** The Flow JSON to download, in place of one built from `screens`. */
  json?: unknown;
};

function createClient(flows: Record<string, FakeFlow | Error>) {
  const client = {
    getJson: jest.fn(async (path: string) => {
      const [flowId, edge] = path.split("/");
      const flow = flows[flowId];
      if (flow instanceof Error) throw flow;
      if (!flow) throw new Error(`Unexpected path: ${path}`);
      if (edge === "assets") {
        return flow.screens === null
          ? { error: { message: "assets unavailable", code: 1 } }
          : {
              data: [
                {
                  asset_type: "FLOW_JSON",
                  download_url: `https://lookaside.facebook.com/${flowId}`,
                  updated_time: "2026-04-25T12:37:22+0000",
                },
              ],
            };
      }
      return {
        id: flowId,
        name: flow.name ?? `Flow ${flowId}`,
        status: flow.status ?? "PUBLISHED",
        whatsapp_business_account: { id: flow.wabaId ?? WABA_ID },
      };
    }),
    postJson: jest.fn(),
    request: jest.fn(async (url: string) => {
      const flowId = url.split("/").pop() ?? "";
      const flow = flows[flowId] as FakeFlow;
      return new Response(
        JSON.stringify(
          flow.json ?? {
            version: "6.3",
            screens: (flow.screens ?? []).map(id => ({ id })),
          }
        ),
        { status: 200 }
      );
    }),
  };
  return client;
}

function read(
  client: ReturnType<typeof createClient>,
  flowIds: string[],
  options: { refresh?: boolean; wabaId?: string; now?: Date } = {}
) {
  return readTemplateFlowFacts({
    wabaId: options.wabaId ?? WABA_ID,
    accessToken: "token",
    flowIds,
    refresh: options.refresh,
    client: client as unknown as WhatsAppGraphClient,
    now: () => options.now ?? NOW,
  });
}

beforeEach(() => {
  cacheStore.clear();
  cacheControl.failReads = false;
  jest.clearAllMocks();
});

describe("readTemplateFlowFacts", () => {
  it("reads status and screen ids, then answers from the cache", async () => {
    const client = createClient({
      [FLOW_ID]: {
        name: "Message templates_medal_pick_1_MARKETING_9b1bc",
        screens: ["SURVEY_FORM"],
      },
    });

    const first = await read(client, [FLOW_ID]);
    const second = await read(client, [FLOW_ID]);

    expect(first).toEqual([
      {
        flowId: FLOW_ID,
        state: "found",
        name: "Message templates_medal_pick_1_MARKETING_9b1bc",
        status: "PUBLISHED",
        screenIds: ["SURVEY_FORM"],
        answerSchema: null,
        checkedAt: NOW.toISOString(),
      },
    ]);
    expect(second).toEqual(first);
    expect(client.getJson).toHaveBeenCalledTimes(2);
    expect(client.request).toHaveBeenCalledTimes(1);
  });

  it("bounds every Graph request with an abort signal", async () => {
    const client = createClient({ [FLOW_ID]: { screens: ["START"] } });

    await read(client, [FLOW_ID]);

    for (const [, options] of client.getJson.mock.calls as unknown as Array<
      [string, { signal?: unknown }]
    >) {
      expect(options.signal).toBeInstanceOf(AbortSignal);
    }
    expect(
      (
        client.request.mock.calls[0] as unknown as [
          string,
          { signal?: unknown },
        ]
      )[1].signal
    ).toBeInstanceOf(AbortSignal);
  });

  it("re-reads Meta on refresh and stores the new answer", async () => {
    const client = createClient({ [FLOW_ID]: { screens: ["SURVEY_FORM"] } });
    await read(client, [FLOW_ID]);

    const refreshed = createClient({
      [FLOW_ID]: { screens: ["QUESTION_ONE"] },
    });
    const [fresh] = await read(refreshed, [FLOW_ID], { refresh: true });
    const [cached] = await read(refreshed, [FLOW_ID]);

    expect(fresh).toMatchObject({ screenIds: ["QUESTION_ONE"] });
    expect(cached).toEqual(fresh);
    expect(refreshed.getJson).toHaveBeenCalledTimes(2);
  });

  it("expires cached answers after ten minutes", async () => {
    const client = createClient({ [FLOW_ID]: { screens: ["START"] } });
    await read(client, [FLOW_ID]);

    await read(client, [FLOW_ID], {
      now: new Date(NOW.getTime() + 11 * 60 * 1000),
    });

    expect(client.getJson).toHaveBeenCalledTimes(4);
  });

  it("clears a cached answer when our app changes the Flow", async () => {
    const client = createClient({ [FLOW_ID]: { screens: ["START"] } });
    await read(client, [FLOW_ID]);

    await invalidateTemplateFlowFacts(FLOW_ID);
    await read(client, [FLOW_ID]);

    expect(client.getJson).toHaveBeenCalledTimes(4);
  });

  it("treats a Flow owned by another WABA as missing", async () => {
    const client = createClient({
      [FLOW_ID]: { wabaId: "other-waba", screens: ["START"] },
    });

    const [facts] = await read(client, [FLOW_ID]);

    expect(facts).toEqual({
      flowId: FLOW_ID,
      state: "missing",
      checkedAt: NOW.toISOString(),
    });
    // Ownership fails before the assets are listed.
    expect(client.getJson).toHaveBeenCalledTimes(1);
  });

  it("treats Graph's 'object does not exist' error as missing", async () => {
    const client = createClient({
      [FLOW_ID]: new MetaGraphRequestError({
        message: "Unsupported get request",
        status: 400,
        statusText: "Bad Request",
        url: `https://graph.facebook.com/v25.0/${FLOW_ID}`,
        details: {
          error: {
            message: "Unsupported get request.",
            type: "GraphMethodException",
            code: 100,
            error_subcode: 33,
          },
        },
      }),
    });

    const [facts] = await read(client, [FLOW_ID]);

    expect(facts).toMatchObject({ state: "missing" });
  });

  it("reports failed reads as unavailable and retries them next time", async () => {
    const client = createClient({ [FLOW_ID]: new Error("socket hang up") });

    const [facts] = await read(client, [FLOW_ID]);
    await read(client, [FLOW_ID]);

    expect(facts).toEqual({
      flowId: FLOW_ID,
      state: "unavailable",
      checkedAt: NOW.toISOString(),
    });
    expect(client.getJson).toHaveBeenCalledTimes(2);
    expect(mockCache.set).not.toHaveBeenCalled();
  });

  it("doesn't cache an open Flow whose JSON couldn't be read", async () => {
    const client = createClient({ [FLOW_ID]: { screens: null } });

    const [facts] = await read(client, [FLOW_ID]);

    expect(facts).toMatchObject({ state: "found", screenIds: null });
    expect(mockCache.set).not.toHaveBeenCalled();
  });

  it("caches a draft Flow even without readable JSON", async () => {
    const client = createClient({
      [FLOW_ID]: { status: "DRAFT", screens: null },
    });

    await read(client, [FLOW_ID]);

    expect(mockCache.set).toHaveBeenCalledTimes(1);
  });

  it("ignores a cached answer stored for another WABA", async () => {
    const client = createClient({ [FLOW_ID]: { screens: ["START"] } });
    await read(client, [FLOW_ID]);

    await read(client, [FLOW_ID], { wabaId: "other-waba" });

    expect(client.getJson).toHaveBeenCalledTimes(3);
  });

  it("falls back to Meta when the cache is down", async () => {
    cacheControl.failReads = true;
    const client = createClient({ [FLOW_ID]: { screens: ["START"] } });

    const [facts] = await read(client, [FLOW_ID]);

    expect(facts).toMatchObject({ state: "found", screenIds: ["START"] });
  });

  it("shares one Meta read between concurrent checks of the same Flow", async () => {
    const client = createClient({ [FLOW_ID]: { screens: ["START"] } });

    await Promise.all([read(client, [FLOW_ID]), read(client, [FLOW_ID])]);

    expect(client.getJson).toHaveBeenCalledTimes(2);
  });

  it("drops invalid ids, repeats and anything past 25 Flows", async () => {
    const ids = Array.from({ length: 30 }, (_, index) => String(1000 + index));
    const client = createClient(
      Object.fromEntries(ids.map(id => [id, { screens: ["START"] }]))
    );

    const facts = await read(client, ["abc", ids[0], ids[0], ...ids]);

    expect(facts.map(entry => entry.flowId)).toEqual(ids.slice(0, 25));
  });

  it("reads the answers a Flow sends from the JSON it already downloads", async () => {
    const client = createClient({
      [FLOW_ID]: { name: "demoshop_ai_case", json: DEMOSHOP_FLOW_JSON },
    });

    const [facts] = await read(client, [FLOW_ID]);

    expect(facts).toMatchObject({
      state: "found",
      screenIds: ["QUESTION_ONE", "DETAILS", "OTHER_DETAILS"],
      answerSchema: { flowName: "demoshop_ai_case", coverage: "complete" },
    });
    expect(
      facts.state === "found" &&
        facts.answerSchema?.fields.map(field => field.responseKey)
    ).toEqual(["__9ba1c9", "____133f36", "_68d224", "_ebfcfb", "other_sport"]);
    // No Graph request beyond the details, assets and JSON download.
    expect(client.getJson).toHaveBeenCalledTimes(2);
    expect(client.request).toHaveBeenCalledTimes(1);
  });

  it("has no answers for a Flow whose JSON couldn't be read", async () => {
    const client = createClient({ [FLOW_ID]: { screens: null } });

    const [facts] = await read(client, [FLOW_ID]);

    expect(facts).toMatchObject({ state: "found", answerSchema: null });
  });

  it("caches facts under the v2 key, so no answer without a schema is served", async () => {
    const v2Key = `icecore:whatsapp:template-flow-facts:v2:${FLOW_ID}`;
    cacheStore.set(`icecore:whatsapp:template-flow-facts:v1:${FLOW_ID}`, {
      wabaId: WABA_ID,
      facts: {
        flowId: FLOW_ID,
        state: "found",
        name: "demoshop_ai_case",
        status: "PUBLISHED",
        screenIds: ["QUESTION_ONE"],
        checkedAt: NOW.toISOString(),
      },
    });
    const client = createClient({ [FLOW_ID]: { json: DEMOSHOP_FLOW_JSON } });

    const [fresh] = await read(client, [FLOW_ID]);
    const [cached] = await read(client, [FLOW_ID]);

    expect(mockCache.get).toHaveBeenCalledWith(v2Key);
    expect(mockCache.set).toHaveBeenCalledWith(v2Key, {
      wabaId: WABA_ID,
      facts: fresh,
    });
    expect(fresh).toMatchObject({ answerSchema: { coverage: "complete" } });
    expect(cached).toEqual(fresh);
    expect(client.getJson).toHaveBeenCalledTimes(2);
  });
});
