import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import * as vercelRuntimeEnv from "./sync-vercel-runtime-env.mjs";

import {
  buildVercelEnvPayload,
  buildVercelEnvUrl,
  deriveVercelProjectIdOrName,
  deriveVercelTeamSlug,
  parseTargets,
  syncVercelRuntimeEnv,
} from "./sync-vercel-runtime-env.mjs";

function legacySupabaseKey(role) {
  return [
    { alg: "HS256", typ: "JWT" },
    { iss: "supabase", role },
  ]
    .map((value) => Buffer.from(JSON.stringify(value)).toString("base64url"))
    .concat("fixture_signature")
    .join(".");
}

test("public Supabase mode syncs only the public key without changing existing runtime values", async () => {
  const key = "sb_publishable_public_fixture";
  const values = vercelRuntimeEnv.buildStableVercelRuntimeValues(
    {
      NEXT_PUBLIC_SUPABASE_ANON_KEY: key,
      GCP_AI_GATEWAY_URL: "https://must-stay-unchanged.example",
      ANTHROPIC_API_KEY: "must-stay-unchanged-private-fixture",
    },
    { publicSupabaseOnly: true },
  );
  assert.deepEqual(values, { NEXT_PUBLIC_SUPABASE_ANON_KEY: key });
  const calls = [];
  const synced = await syncVercelRuntimeEnv({
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return { ok: true, status: 200 };
    },
    token: "vercel-token",
    projectId: "prj_123",
    teamId: "team_123",
    values,
  });
  assert.deepEqual(synced, ["NEXT_PUBLIC_SUPABASE_ANON_KEY"]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].init.body), [
    {
      key: "NEXT_PUBLIC_SUPABASE_ANON_KEY",
      value: key,
      type: "plain",
      target: ["production"],
    },
  ]);
});

test("public Supabase mode accepts legacy anon keys", () => {
  const key = legacySupabaseKey("anon");
  assert.deepEqual(
    vercelRuntimeEnv.buildStableVercelRuntimeValues(
      {
        NEXT_PUBLIC_SUPABASE_ANON_KEY: key,
      },
      { publicSupabaseOnly: true },
    ),
    { NEXT_PUBLIC_SUPABASE_ANON_KEY: key },
  );
});

test("public Supabase mode rejects missing and privileged credentials without exposing them", () => {
  for (const key of [
    undefined,
    "",
    " ",
    "sb_secret_private_fixture",
    legacySupabaseKey("service_role"),
  ]) {
    assert.throws(
      () =>
        vercelRuntimeEnv.buildStableVercelRuntimeValues(
          {
            NEXT_PUBLIC_SUPABASE_ANON_KEY: key,
          },
          { publicSupabaseOnly: true },
        ),
      (error) => {
        assert.match(
          error.message,
          /must be a Supabase publishable key or legacy anon JWT/,
        );
        if (key?.trim()) assert.equal(error.message.includes(key), false);
        return true;
      },
    );
  }
});

test("public Supabase payload rejects privileged keys before any Vercel request", async () => {
  let fetchCalls = 0;
  await assert.rejects(
    syncVercelRuntimeEnv({
      fetchImpl: async () => {
        fetchCalls += 1;
        return { ok: true, status: 200 };
      },
      token: "vercel-token",
      projectId: "prj_123",
      values: {
        NEXT_PUBLIC_SUPABASE_ANON_KEY: legacySupabaseKey("service_role"),
      },
    }),
    /must be a Supabase publishable key or legacy anon JWT/,
  );
  assert.equal(fetchCalls, 0);
});

test("Supabase-only CLI validates the public key before syncing without printing its value", () => {
  const key = "sb_secret_private_cli_fixture";
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL("./sync-vercel-runtime-env.mjs", import.meta.url)),
      "--public-supabase-only",
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        NEXT_PUBLIC_SUPABASE_ANON_KEY: key,
        VERCEL_TOKEN: "",
      },
    },
  );
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /must be a Supabase publishable key or legacy anon JWT/,
  );
  assert.equal(`${result.stdout}${result.stderr}`.includes(key), false);
});

test("Deploy Web runs the required public-key preflight before canonical production deploy", () => {
  const workflow = readFileSync(
    new URL("../workflows/deploy-web.yml", import.meta.url),
    "utf8",
  ).replace(/\r\n?/g, "\n");
  const preflight = workflow.match(
    /      - name: Sync public Supabase key\n([\s\S]*?)(?=\n      - name:)/,
  )?.[1];
  assert.ok(preflight, "required public-key preflight step must exist");
  assert.match(
    preflight,
    /NEXT_PUBLIC_SUPABASE_ANON_KEY: \$\{\{ secrets\.NEXT_PUBLIC_SUPABASE_ANON_KEY \}\}/,
  );
  assert.match(preflight, /VERCEL_TOKEN: \$\{\{ secrets\.VERCEL_TOKEN \}\}/);
  assert.match(preflight, /VERCEL_ENV_TARGETS: production/);
  assert.match(
    preflight,
    /run: node \.github\/scripts\/sync-vercel-runtime-env\.mjs --public-supabase-only/,
  );
  assert.doesNotMatch(preflight, /continue-on-error:|\n\s+if:/);
  assert.ok(
    workflow.indexOf("Test web deployment tooling") <
      workflow.indexOf("Sync public Supabase key"),
  );
  assert.ok(
    workflow.indexOf("Sync public Supabase key") <
      workflow.indexOf("Deploy web production"),
  );
  assert.match(
    workflow,
    /run: node --test [^\n]*\.github\/scripts\/sync-vercel-runtime-env\.test\.mjs/,
  );
});

test("builds Vercel env upsert URL with team id", () => {
  assert.equal(
    buildVercelEnvUrl({
      projectId: "prj_123",
      teamId: "team_123",
    }),
    "https://api.vercel.com/v10/projects/prj_123/env?upsert=true&teamId=team_123",
  );
});

test("builds plain runtime env payload and skips empty values", () => {
  assert.deepEqual(
    buildVercelEnvPayload(
      {
        GCP_AI_GATEWAY_URL: "https://gateway.example",
        GCP_MEDIA_API_URL: "https://media.example",
        REALTIME_GATEWAY_URL: " ",
      },
      ["production"],
    ),
    [
      {
        key: "GCP_AI_GATEWAY_URL",
        value: "https://gateway.example",
        type: "plain",
        target: ["production"],
      },
      {
        key: "GCP_MEDIA_API_URL",
        value: "https://media.example",
        type: "plain",
        target: ["production"],
      },
    ],
  );
});

test("syncs an explicitly selected heavy Gemini model without replacing an unset model", () => {
  const values = vercelRuntimeEnv.buildStableVercelRuntimeValues({
    VERTEX_GEMINI_HEAVY_MODEL: " gemini-3.8-flash ",
  });
  assert.equal(values.VERTEX_GEMINI_HEAVY_MODEL, "gemini-3.8-flash");
  assert.equal(
    Object.hasOwn(
      vercelRuntimeEnv.buildStableVercelRuntimeValues({}),
      "VERTEX_GEMINI_HEAVY_MODEL",
    ),
    false,
  );
  assert.deepEqual(
    buildVercelEnvPayload({
      VERTEX_GEMINI_HEAVY_MODEL: values.VERTEX_GEMINI_HEAVY_MODEL,
    }),
    [
      {
        key: "VERTEX_GEMINI_HEAVY_MODEL",
        value: "gemini-3.8-flash",
        type: "plain",
        target: ["production"],
      },
    ],
  );
});

test("syncs explicitly selected Claude text settings but never the Anthropic API key", () => {
  const selected = {
    AI_CHAT_PROVIDER_ORDER: " anthropic,vertex ",
    ANTHROPIC_AI_ENABLED: "true",
    ANTHROPIC_LIGHT_MODEL: " claude-haiku-4-5 ",
    ANTHROPIC_HEAVY_MODEL: "claude-sonnet-5-5",
    ANTHROPIC_REASONING_MODEL: "claude-opus-5-5",
    ANTHROPIC_WORKSPACE_ID: "wrkspc_contract",
  };
  const values = vercelRuntimeEnv.buildStableVercelRuntimeValues({
    ...selected,
    ANTHROPIC_API_KEY: "contract-anthropic-key",
  });

  assert.equal(values.AI_CHAT_PROVIDER_ORDER, "anthropic,vertex");
  assert.equal(values.ANTHROPIC_AI_ENABLED, "true");
  assert.equal(values.ANTHROPIC_LIGHT_MODEL, "claude-haiku-4-5");
  assert.equal(values.ANTHROPIC_HEAVY_MODEL, "claude-sonnet-5-5");
  assert.equal(values.ANTHROPIC_REASONING_MODEL, "claude-opus-5-5");
  assert.equal(values.ANTHROPIC_WORKSPACE_ID, "wrkspc_contract");
  assert.equal(Object.hasOwn(values, "ANTHROPIC_API_KEY"), false);
  assert.doesNotMatch(JSON.stringify(values), /contract-anthropic-key/);

  const unset = vercelRuntimeEnv.buildStableVercelRuntimeValues({
    AI_CHAT_PROVIDER_ORDER: " ",
  });
  for (const key of Object.keys(selected)) {
    assert.equal(
      Object.hasOwn(unset, key),
      false,
      `${key} must not replace an unset Vercel value`,
    );
  }

  const payload = buildVercelEnvPayload(
    Object.fromEntries(Object.keys(selected).map((key) => [key, values[key]])),
  );
  assert.deepEqual(
    payload.map(({ key, type, target }) => ({ key, type, target })),
    Object.keys(selected).map((key) => ({
      key,
      type: "plain",
      target: ["production"],
    })),
  );
});

test("parses comma-separated Vercel targets with production default", () => {
  assert.deepEqual(parseTargets("production,preview"), [
    "production",
    "preview",
  ]);
  assert.deepEqual(parseTargets(""), ["production"]);
});

test("derives Vercel project name from OIDC subjects", () => {
  assert.equal(
    deriveVercelProjectIdOrName({
      oidcSubjects:
        "owner:fatdrfrogs-projects:project:nest-ai-front:environment:production,owner:fatdrfrogs-projects:project:nest-ai-front:environment:preview",
    }),
    "nest-ai-front",
  );
});

test("derives Vercel team slug from OIDC audience or issuer", () => {
  assert.equal(
    deriveVercelTeamSlug({
      oidcAudience: "https://vercel.com/fatdrfrogs-projects",
    }),
    "fatdrfrogs-projects",
  );
  assert.equal(
    deriveVercelTeamSlug({
      oidcIssuerUrl: "https://oidc.vercel.com/fatdrfrogs-projects",
    }),
    "fatdrfrogs-projects",
  );
});

test("syncs Vercel runtime env through REST upsert", async () => {
  const calls = [];
  const synced = await syncVercelRuntimeEnv({
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return {
        ok: true,
      };
    },
    token: "vercel-token",
    oidcAudience: "https://vercel.com/fatdrfrogs-projects",
    oidcSubjects:
      "owner:fatdrfrogs-projects:project:nest-ai-front:environment:production",
    values: {
      GCP_AI_GATEWAY_URL: "https://ai.example",
      GCP_MEDIA_API_URL: "https://media.example",
      REALTIME_GATEWAY_URL: "https://realtime.example",
      WHATSAPP_FAST_WEBHOOK_PUBSUB_TOPIC: "icecore-whatsapp-fast-events",
    },
  });

  assert.deepEqual(synced, [
    "GCP_AI_GATEWAY_URL",
    "GCP_MEDIA_API_URL",
    "REALTIME_GATEWAY_URL",
    "WHATSAPP_FAST_WEBHOOK_PUBSUB_TOPIC",
  ]);
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    "https://api.vercel.com/v10/projects/nest-ai-front/env?upsert=true&slug=fatdrfrogs-projects",
  );
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers.Authorization, "Bearer vercel-token");
  assert.deepEqual(JSON.parse(calls[0].init.body), [
    {
      key: "GCP_AI_GATEWAY_URL",
      value: "https://ai.example",
      type: "plain",
      target: ["production"],
    },
    {
      key: "GCP_MEDIA_API_URL",
      value: "https://media.example",
      type: "plain",
      target: ["production"],
    },
    {
      key: "REALTIME_GATEWAY_URL",
      value: "https://realtime.example",
      type: "plain",
      target: ["production"],
    },
    {
      key: "WHATSAPP_FAST_WEBHOOK_PUBSUB_TOPIC",
      value: "icecore-whatsapp-fast-events",
      type: "plain",
      target: ["production"],
    },
  ]);
});

test("does not include a failed Vercel response body or submitted value in errors", async () => {
  const privateValue = "private-value-for-regression";

  await assert.rejects(
    syncVercelRuntimeEnv({
      fetchImpl: async () => ({
        ok: false,
        status: 400,
        text: async () =>
          JSON.stringify({
            error: {
              code: "INVALID_ENV_VALUE",
              message: `Rejected value ${privateValue}`,
            },
          }),
      }),
      token: "vercel-token",
      projectId: "prj_123",
      values: { GCP_AI_GATEWAY_URL: privateValue },
    }),
    (error) => {
      assert.equal(error.message, "Vercel env sync failed with HTTP 400");
      assert.equal(error.message.includes(privateValue), false);
      assert.equal(error.message.includes("INVALID_ENV_VALUE"), false);
      return true;
    },
  );
});

test("Vercel OTP delivery stays on pubsub unless temporal is explicit", () => {
  assert.equal(
    vercelRuntimeEnv.buildStableVercelRuntimeValues({})
      .WHATSAPP_OTP_DELIVERY_MODE,
    "pubsub",
  );
  assert.equal(
    vercelRuntimeEnv.buildStableVercelRuntimeValues({
      WHATSAPP_OTP_DELIVERY_MODE: "both",
    }).WHATSAPP_OTP_DELIVERY_MODE,
    "pubsub",
  );
  const temporal = vercelRuntimeEnv.buildStableVercelRuntimeValues({
    WHATSAPP_OTP_DELIVERY_MODE: "temporal",
    WHATSAPP_OTP_TEMPORAL_WORKSPACE_ALLOWLIST: " workspace-1 , workspace-2 ",
  });
  assert.equal(temporal.WHATSAPP_OTP_DELIVERY_MODE, "temporal");
  assert.equal(
    temporal.WHATSAPP_OTP_TEMPORAL_WORKSPACE_ALLOWLIST,
    "workspace-1 , workspace-2",
  );
});

test("stable runtime values ignore retired telemetry credentials", () => {
  const values = vercelRuntimeEnv.buildStableVercelRuntimeValues({
    DD_API_KEY: "retired-fixture",
    DD_LLMOBS_ENABLED: "true",
    GCP_AI_GATEWAY_URL: "https://ai.example",
  });
  assert.equal(
    Object.keys(values).some((key) => key.startsWith("DD_")),
    false,
  );
  assert.equal(values.GCP_AI_GATEWAY_URL, "https://ai.example");
});

test("builds stable classification rollout values with publishing and reconciliation enabled", () => {
  assert.equal(
    typeof vercelRuntimeEnv.buildStableVercelRuntimeValues,
    "function",
    "buildStableVercelRuntimeValues must be exported",
  );

  assert.deepEqual(
    vercelRuntimeEnv.buildStableVercelRuntimeValues({
      GCP_PROJECT_ID: "project-1",
      GCP_AI_GATEWAY_URL: "https://gateway.example",
      GCP_MEDIA_API_URL: "https://media.example",
      REALTIME_GATEWAY_URL: "https://realtime.example",
      WHATSAPP_FAST_WEBHOOK_PUBSUB_TOPIC: "icecore-whatsapp-fast-events",
      CONVERSATION_CLASSIFICATION_PUBLISHING_ENABLED: "false",
      CONVERSATION_CLASSIFICATION_RECONCILIATION_ENABLED: "false",
    }),
    {
      GCP_AI_GATEWAY_URL: "https://gateway.example",
      GCP_MEDIA_API_URL: "https://media.example",
      REALTIME_GATEWAY_URL: "https://realtime.example",
      WHATSAPP_FAST_WEBHOOK_PUBSUB_TOPIC: "icecore-whatsapp-fast-events",
      WHATSAPP_OTP_DELIVERY_MODE: "pubsub",
      WHATSAPP_OTP_TEMPORAL_WORKSPACE_ALLOWLIST: "",
      CONVERSATION_CLASSIFICATION_PUBSUB_PROJECT_ID: "project-1",
      CONVERSATION_CLASSIFICATION_PUBSUB_TOPIC:
        "icecore-conversation-classification-events",
      CONVERSATION_CLASSIFICATION_PUBLISHING_ENABLED: "true",
      CONVERSATION_CLASSIFICATION_RECONCILIATION_ENABLED: "true",
    },
  );
});

const cleanupOptions = {
  token: "vercel-token",
  projectId: "prj_123",
  teamId: "team_123",
  removeRetiredDatadogEnv: true,
  values: { GCP_AI_GATEWAY_URL: "https://gateway.example" },
};

function inventoryResponse(envs, next) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      envs,
      hiddenProductionEnvCount: 0,
      ...(next === undefined ? {} : { pagination: { next } }),
    }),
  };
}

test("retirement inventories every page and deletes only explicit retired keys before syncing", async () => {
  const retiredKeys = [
    "DD_API_KEY",
    "DD_APP_KEY",
    "DD_LLMOBS_ENABLED",
    "DD_LLMOBS_AGENTLESS_ENABLED",
    "DD_LLMOBS_ML_APP",
    "DD_LLMOBS_SAMPLE_RATE",
    "DD_SERVICE",
    "DD_SITE",
  ];
  const retiredEntries = retiredKeys.map((key, index) => ({
    id: `retired_${index}`,
    key,
    target: index === 0 ? ["production", "preview"] : ["production"],
    value: "must-not-be-logged",
  }));
  const retained = [
    { id: "other", key: "GCP_AI_GATEWAY_URL" },
    { id: "similar", key: "DD_API_KEY_BACKUP" },
    { id: "not-allowlisted", key: "DD_ENV" },
  ];
  const responses = [
    inventoryResponse([...retained, retiredEntries[0]], 1540095775951),
    inventoryResponse(retiredEntries.slice(1), null),
    ...retiredKeys.map(() => ({ ok: true, status: 204 })),
    inventoryResponse(retained.slice(0, 1), 1540095776000),
    inventoryResponse(retained.slice(1), null),
    { ok: true, status: 200 },
  ];
  const calls = [];
  const synced = await syncVercelRuntimeEnv({
    ...cleanupOptions,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      assert.ok(responses.length, "unexpected Vercel request");
      return responses.shift();
    },
  });

  assert.deepEqual(synced, ["GCP_AI_GATEWAY_URL"]);
  assert.equal(responses.length, 0);
  assert.deepEqual(
    calls.map(({ init }) => init.method),
    ["GET", "GET", ...retiredKeys.map(() => "DELETE"), "GET", "GET", "POST"],
  );
  assert.equal(
    new URL(calls[1].url).searchParams.get("until"),
    "1540095775951",
  );
  assert.equal(
    new URL(calls[11].url).searchParams.get("until"),
    "1540095776000",
  );
  assert.deepEqual(
    calls
      .filter(({ init }) => init.method === "DELETE")
      .map(({ url }) => new URL(url).pathname),
    retiredKeys.map((_, index) => `/v9/projects/prj_123/env/retired_${index}`),
  );
  for (const { url, init } of calls) {
    assert.equal(new URL(url).searchParams.get("teamId"), "team_123");
    assert.equal(init.headers.Authorization, "Bearer vercel-token");
  }
});

test("retirement validates all inventory pages before making any mutation", async (t) => {
  for (const [name, body, expected] of [
    ["missing envs", {}, /envs array/],
    [
      "hidden production variables",
      { envs: [], hiddenProductionEnvCount: 1 },
      /hides production/,
    ],
    [
      "invalid pagination",
      { envs: [], pagination: null },
      /invalid pagination cursor/,
    ],
    [
      "invalid cursor",
      { envs: [], pagination: { next: "private-inventory-value" } },
      /invalid pagination cursor/,
    ],
    [
      "repeated cursor",
      { envs: [], pagination: { next: 123 } },
      /repeated pagination cursor/,
    ],
    [
      "missing id",
      { envs: [{ key: "DD_API_KEY" }] },
      /invalid environment entry/,
    ],
    [
      "non-string id",
      { envs: [{ id: {}, key: "DD_API_KEY" }] },
      /invalid environment entry/,
    ],
    [
      "missing unrelated key",
      { envs: [{ id: "other" }] },
      /invalid environment entry/,
    ],
    [
      "duplicate id",
      { envs: [{ id: "retired", key: "UNRELATED_SECRET" }] },
      /repeated environment id/,
    ],
  ]) {
    await t.test(name, async () => {
      const methods = [];
      const responses = [
        inventoryResponse([{ id: "retired", key: "DD_API_KEY" }], 123),
        { ok: true, status: 200, json: async () => body },
      ];
      await assert.rejects(
        syncVercelRuntimeEnv({
          ...cleanupOptions,
          fetchImpl: async (_url, init) => {
            methods.push(init.method);
            return responses.shift();
          },
        }),
        (error) => {
          assert.match(error.message, expected);
          assert.doesNotMatch(
            error.message,
            /private-inventory-value|UNRELATED_SECRET/,
          );
          return true;
        },
      );
      assert.deepEqual(methods, ["GET", "GET"]);
    });
  }
});

test("retirement sanitizes inventory parse failures before mutation", async () => {
  const methods = [];
  await assert.rejects(
    syncVercelRuntimeEnv({
      ...cleanupOptions,
      fetchImpl: async (_url, init) => {
        methods.push(init.method);
        return {
          ok: true,
          status: 200,
          json: async () => {
            throw new Error("private-inventory-value");
          },
        };
      },
    }),
    (error) => {
      assert.equal(error.message, "Vercel env inventory returned invalid JSON");
      return true;
    },
  );
  assert.deepEqual(methods, ["GET"]);
});

test("retirement tolerates already-deleted entries and is safe to repeat", async () => {
  const methods = [];
  let reads = 0;
  const options = {
    ...cleanupOptions,
    fetchImpl: async (_url, init) => {
      methods.push(init.method);
      if (init.method === "GET") {
        reads += 1;
        return inventoryResponse(
          reads === 1 ? [{ id: "retired", key: "DD_APP_KEY" }] : [],
        );
      }
      return {
        ok: init.method !== "DELETE",
        status: init.method === "DELETE" ? 404 : 200,
      };
    },
  };
  assert.deepEqual(await syncVercelRuntimeEnv(options), ["GCP_AI_GATEWAY_URL"]);
  assert.deepEqual(await syncVercelRuntimeEnv(options), ["GCP_AI_GATEWAY_URL"]);
  assert.equal(methods.filter((method) => method === "DELETE").length, 1);
  assert.equal(methods.filter((method) => method === "POST").length, 2);
});

test("retirement fails if a retired key remains on a verification page", async () => {
  const methods = [];
  const retired = { id: "retired", key: "DD_SITE" };
  const responses = [
    inventoryResponse([retired]),
    { ok: true, status: 204 },
    inventoryResponse([], 123),
    inventoryResponse([retired], null),
  ];
  await assert.rejects(
    syncVercelRuntimeEnv({
      ...cleanupOptions,
      fetchImpl: async (_url, init) => {
        methods.push(init.method);
        return responses.shift();
      },
    }),
    /still contains 1 retired Datadog environment entry after cleanup/,
  );
  assert.deepEqual(methods, ["GET", "DELETE", "GET", "GET"]);
});

test("retirement fails on deletion errors without exposing response values", async () => {
  const methods = [];
  await assert.rejects(
    syncVercelRuntimeEnv({
      ...cleanupOptions,
      fetchImpl: async (_url, init) => {
        methods.push(init.method);
        return init.method === "GET"
          ? inventoryResponse([{ id: "retired", key: "DD_API_KEY" }])
          : { ok: false, status: 403, text: async () => "private-error-value" };
      },
    }),
    (error) => {
      assert.equal(
        error.message,
        "Vercel retired Datadog env removal failed with HTTP 403",
      );
      return true;
    },
  );
  assert.deepEqual(methods, ["GET", "DELETE"]);
});

test("retirement rejects a payload that would recreate a retired key before any request", async () => {
  let calls = 0;
  await assert.rejects(
    syncVercelRuntimeEnv({
      ...cleanupOptions,
      values: { DD_API_KEY: "private-retired-value" },
      fetchImpl: async () => {
        calls += 1;
        return { ok: true };
      },
    }),
    /Cannot sync retired Datadog environment variables/,
  );
  assert.equal(calls, 0);
});

test("retirement never exposes inventory or deletion transport error details", async (t) => {
  for (const [method, expected] of [
    ["GET", "Vercel env inventory request failed"],
    ["DELETE", "Vercel retired Datadog env removal request failed"],
  ]) {
    await t.test(method, async () => {
      await assert.rejects(
        syncVercelRuntimeEnv({
          ...cleanupOptions,
          fetchImpl: async (_url, init) => {
            if (init.method === method)
              throw new Error("private-transport-value");
            return inventoryResponse([{ id: "retired", key: "DD_API_KEY" }]);
          },
        }),
        (error) => {
          assert.equal(error.message, expected);
          return true;
        },
      );
    });
  }
});

for (const publicSupabaseOnly of [false, true]) {
  test(`CLI ${publicSupabaseOnly ? "public-only sync skips" : "normal sync performs"} retired variable cleanup`, () => {
    const preload = `
      let retiredExists = true;
      globalThis.fetch = async (_url, init) => {
        console.log('fixture-method:' + init.method);
        if (init.method === 'GET') return {ok:true,status:200,json:async()=>({envs:retiredExists?[{id:'retired',key:'DD_API_KEY',value:'private-inventory-value'}]:[]})};
        if (init.method === 'DELETE') retiredExists = false;
        return {ok:true,status:200};
      };
    `;
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        `data:text/javascript,${encodeURIComponent(preload)}`,
        fileURLToPath(
          new URL("./sync-vercel-runtime-env.mjs", import.meta.url),
        ),
        ...(publicSupabaseOnly ? ["--public-supabase-only"] : []),
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          VERCEL_TOKEN: "fixture-token",
          VERCEL_PROJECT_ID: "fixture-project",
          NEXT_PUBLIC_SUPABASE_ANON_KEY: "sb_publishable_public_fixture",
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(
      [...result.stdout.matchAll(/fixture-method:(\w+)/g)].map(
        (match) => match[1],
      ),
      publicSupabaseOnly ? ["POST"] : ["GET", "DELETE", "GET", "POST"],
    );
    assert.doesNotMatch(
      `${result.stdout}${result.stderr}`,
      /private-inventory-value|fixture-token|sb_publishable_public_fixture/,
    );
  });
}
