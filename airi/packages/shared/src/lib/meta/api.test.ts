import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import {
  buildGraphApiUrl,
  collectMetaGraphEdge,
  getMetaGraphAuthorizationMetadata,
  getWhatsAppGraphClient,
  isMetaGraphAuthorizationError,
  isMetaGraphRateLimitError,
  MetaGraphPaginationError,
  MetaGraphRequestError,
  parseMetaGraphAPIError,
  type MetaGraphAPIError,
  type WhatsAppGraphClient,
} from "./api";
import { buildGraphApiUrl as buildGraphApiUrlOwner } from "./graph-version";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("meta/api re-exports the canonical URL builder and owns one error shape", () => {
  const error: MetaGraphAPIError = {
    message: "Invalid request",
    type: "OAuthException",
    code: 100,
  };

  assert.equal(buildGraphApiUrl, buildGraphApiUrlOwner);
  assert.equal(
    buildGraphApiUrl("/waba-1/flows"),
    "https://graph.facebook.com/v25.0/waba-1/flows",
  );
  assert.deepEqual(parseMetaGraphAPIError({ error }), error);
});

test("Meta Graph rate-limit detection recognizes provider code 80008 and HTTP 429", () => {
  const providerRateLimit = new MetaGraphRequestError({
    message: "Too many calls",
    status: 400,
    statusText: "Bad Request",
    url: "https://graph.facebook.com/v25.0/phone-1",
    details: {
      error: {
        message: "Too many calls",
        type: "OAuthException",
        code: 80008,
      },
    },
    metaError: {
      message: "Too many calls",
      type: "OAuthException",
      code: 80008,
    },
  });
  const httpRateLimit = new MetaGraphRequestError({
    message: "Meta Graph API request failed: HTTP 429",
    status: 429,
    statusText: "Too Many Requests",
    url: "https://graph.facebook.com/v25.0/phone-1",
    details: null,
  });
  const permissionFailure = new MetaGraphRequestError({
    message: "Permissions error",
    status: 400,
    statusText: "Bad Request",
    url: "https://graph.facebook.com/v25.0/phone-1",
    details: {
      error: {
        message: "Permissions error",
        type: "OAuthException",
        code: 200,
      },
    },
    metaError: {
      message: "Permissions error",
      type: "OAuthException",
      code: 200,
    },
  });

  assert.equal(isMetaGraphRateLimitError(providerRateLimit), true);
  assert.equal(isMetaGraphRateLimitError(httpRateLimit), true);
  assert.equal(
    isMetaGraphRateLimitError({
      success: false,
      metaError: { message: "Too many calls", code: 80008 },
    }),
    true,
  );
  assert.equal(
    isMetaGraphRateLimitError({ success: false, status: 429 }),
    true,
  );
  assert.equal(isMetaGraphRateLimitError(permissionFailure), false);
  assert.equal(
    isMetaGraphRateLimitError({
      success: false,
      metaError: { message: "Permissions error", code: 200 },
    }),
    false,
  );
  assert.equal(isMetaGraphRateLimitError(new Error("rate limited")), false);
});

test("Meta Graph rate-limit detection recognizes canonical Graph throttle codes", () => {
  for (const code of [4, 17, 32, 613]) {
    assert.equal(
      isMetaGraphRateLimitError({
        status: 400,
        metaError: { message: "Request limit reached", code },
      }),
      true,
      `expected Graph error code ${code} to open the rate-limit circuit`,
    );
  }
});

test("Meta Graph authorization detection recognizes terminal HTTP and provider errors", () => {
  for (const status of [401, 403]) {
    assert.deepEqual(getMetaGraphAuthorizationMetadata({ status }), {
      status,
      requiresReconnect: true,
    });
  }

  for (const code of [10, 190, 200]) {
    assert.equal(
      isMetaGraphAuthorizationError({
        status: 400,
        metaError: { code },
      }),
      true,
    );
  }

  assert.deepEqual(
    getMetaGraphAuthorizationMetadata({
      status: 400,
      metaError: { code: 100, error_subcode: 33 },
    }),
    {
      status: 400,
      code: 100,
      subcode: 33,
      requiresReconnect: true,
    },
  );
  assert.equal(
    isMetaGraphAuthorizationError({
      status: 400,
      metaError: { code: 999 },
      formattedError: { requiresReconnect: true },
    }),
    true,
  );
});

test("Meta Graph authorization detection keeps generic code 100 non-terminal", () => {
  assert.equal(
    getMetaGraphAuthorizationMetadata({
      status: 400,
      metaError: { code: 100 },
      formattedError: { requiresReconnect: false },
    }),
    null,
  );
  assert.equal(
    isMetaGraphAuthorizationError({
      status: 400,
      metaError: { code: 100, error_subcode: 12 },
    }),
    false,
  );
  assert.equal(isMetaGraphAuthorizationError(new Error("Unauthorized")), false);
});

test("WhatsApp Graph client preserves JSON, FormData, and URLSearchParams bodies", async () => {
  const requests: RequestInit[] = [];
  globalThis.fetch = (async (_input, init) => {
    requests.push(init ?? {});
    return Response.json({ success: true });
  }) as typeof fetch;
  const client = getWhatsAppGraphClient();

  await client.postJson("flow-1", {
    token: "header-token",
    body: { name: "Lead Flow" },
  });

  const formData = new FormData();
  formData.append("name", "flow.json");
  await client.postJson("flow-1/assets", {
    token: "header-token",
    body: formData,
  });

  const searchParams = new URLSearchParams({ application_id: "app-1" });
  await client.postJson("flow-1", {
    token: "header-token",
    body: searchParams,
  });

  assert.equal(requests[0]?.body, '{"name":"Lead Flow"}');
  assert.equal(
    new Headers(requests[0]?.headers).get("content-type"),
    "application/json",
  );
  assert.equal(requests[1]?.body, formData);
  assert.equal(new Headers(requests[1]?.headers).has("content-type"), false);
  assert.equal(requests[2]?.body, searchParams);
  assert.equal(new Headers(requests[2]?.headers).has("content-type"), false);
  for (const request of requests) {
    assert.equal(
      new Headers(request.headers).get("authorization"),
      "Bearer header-token",
    );
  }
});

test("WhatsApp Graph request errors redact every query value", async () => {
  globalThis.fetch = (async () => {
    const response = Response.json(
      {
        error: {
          message:
            "Invalid request at https://graph.facebook.com/v25.0/flow-1?after=message-secret",
          type: "OAuthException",
          code: 100,
          error_data: {
            details:
              "Retry https://graph.facebook.com/v25.0/flow-1?cursor=details-secret",
          },
        },
      },
      { status: 400 },
    );
    Object.defineProperty(response, "url", {
      value:
        "https://graph.facebook.com/v25.0/flow-1?access_token=provider-secret&after=cursor-secret",
    });
    return response;
  }) as typeof fetch;

  await assert.rejects(
    getWhatsAppGraphClient().getJson("flow-1", {
      token: "header-secret",
    }),
    (error: unknown) => {
      assert.ok(error instanceof MetaGraphRequestError);
      assert.equal(error.url.includes("provider-secret"), false);
      assert.equal(error.url.includes("cursor-secret"), false);
      assert.equal(error.message.includes("message-secret"), false);
      assert.equal(
        JSON.stringify(error.details).includes("details-secret"),
        false,
      );
      return true;
    },
  );
});

test("WhatsApp Graph client wraps response-body read failures with bounded status-bearing evidence", async (t) => {
  for (const status of [200, 502]) {
    await t.test(`HTTP ${status}`, async () => {
      const response = new Response(null, {
        status,
        statusText: status === 200 ? "OK" : "Bad Gateway",
      });
      Object.defineProperties(response, {
        text: {
          value: async () => {
            throw new Error("response-body-secret");
          },
        },
        url: {
          value:
            "https://graph.facebook.com/v25.0/flow-1?access_token=url-secret",
        },
      });
      globalThis.fetch = (async () => response) as typeof fetch;

      await assert.rejects(
        getWhatsAppGraphClient().getJson("flow-1", {
          token: "header-secret",
        }),
        (error: unknown) => {
          assert.ok(error instanceof MetaGraphRequestError);
          assert.equal(error.status, status);
          assert.equal(
            error.message,
            "Meta Graph API response body could not be read",
          );
          assert.deepEqual(error.details, {
            reason: "response_body_unavailable",
          });
          assert.equal(
            JSON.stringify(error).includes("response-body-secret"),
            false,
          );
          assert.equal(JSON.stringify(error).includes("url-secret"), false);
          return true;
        },
      );
    });
  }
});

test("WhatsApp Graph client redacts 200 error envelopes without changing validation pointers", async () => {
  globalThis.fetch = (async () =>
    Response.json({
      error: {
        message:
          "Invalid request at https://graph.facebook.com/v25.0/flow-1?after=message-secret",
        type: "OAuthException",
        code: 100,
        error_data: {
          details:
            "Retry https://graph.facebook.com/v25.0/flow-1?cursor=details-secret",
        },
      },
      validation_errors: [
        {
          error: "PATTERN_MISMATCH",
          message: "Screen id is invalid",
          path: "screens[1].id",
        },
      ],
    })) as typeof fetch;

  const payload = await getWhatsAppGraphClient().postJson<{
    error: MetaGraphAPIError;
    validation_errors: Array<{
      error: string;
      message: string;
      path: string;
    }>;
  }>("flow-1/publish", {
    token: "header-secret",
  });

  assert.equal(JSON.stringify(payload).includes("message-secret"), false);
  assert.equal(JSON.stringify(payload).includes("details-secret"), false);
  assert.deepEqual(payload.validation_errors, [
    {
      error: "PATTERN_MISMATCH",
      message: "Screen id is invalid",
      path: "screens[1].id",
    },
  ]);
});

test("collectMetaGraphEdge preserves the initial query, strips URL tokens, and caps items", async () => {
  const calls: Array<{
    path: string;
    options: unknown;
  }> = [];
  const client = {
    getJson: async (path: string, options: unknown) => {
      calls.push({ path, options });
      if (calls.length === 1) {
        return {
          data: [{ id: "1" }, { id: "2" }],
          paging: {
            next: "https://graph.facebook.com/v25.0/waba-1/flows?after=page-2&access_token=query-secret",
          },
        };
      }
      return {
        data: [{ id: "3" }, { id: "4" }],
      };
    },
  } as WhatsAppGraphClient;

  const items = await collectMetaGraphEdge<{ id: string }>({
    client,
    accessToken: "header-token",
    path: "waba-1/flows",
    initialQuery: {
      fields: "id,name",
      include_hidden: true,
      limit: 3,
    },
    maxPages: 5,
    maxItems: 3,
    normalizePage: (payload: unknown) => {
      const page = payload as {
        data?: Array<{ id: string }>;
        paging?: { next?: string };
      };
      return {
        data: page.data ?? [],
        next: page.paging?.next,
      };
    },
  });

  assert.deepEqual(items, [{ id: "1" }, { id: "2" }, { id: "3" }]);
  assert.deepEqual(calls, [
    {
      path: "waba-1/flows",
      options: {
        token: "header-token",
        query: {
          fields: "id,name",
          include_hidden: true,
          limit: 3,
        },
      },
    },
    {
      path: "https://graph.facebook.com/v25.0/waba-1/flows?after=page-2",
      options: {
        token: "header-token",
      },
    },
  ]);
});

test("collectMetaGraphEdge runs a boundary hook and creates a fresh signal before each page", async () => {
  const boundaries: Array<{ pageNumber: number; collectedItems: number }> = [];
  const signals = [new AbortController().signal, new AbortController().signal];
  const signalCalls: AbortSignal[] = [];
  let calls = 0;
  const client = {
    getJson: async (_path: string, options: { signal?: AbortSignal }) => {
      assert.equal(options.signal, signals[calls]);
      signalCalls.push(options.signal!);
      calls += 1;
      return calls === 1
        ? {
            data: [{ id: "1" }],
            paging: {
              next: "https://graph.facebook.com/v25.0/waba-1/flows?after=page-2",
            },
          }
        : { data: [{ id: "2" }] };
    },
  } as unknown as WhatsAppGraphClient;

  await assert.doesNotReject(
    collectMetaGraphEdge<{ id: string }>({
      client,
      accessToken: "header-token",
      path: "waba-1/flows",
      maxPages: 2,
      maxItems: 3,
      beforePage: async (boundary) => {
        boundaries.push(boundary);
      },
      createRequestSignal: () => signals[signalCalls.length]!,
      normalizePage: (payload) => {
        const page = payload as {
          data: readonly { id: string }[];
          paging?: { next?: string };
        };
        return { data: page.data, next: page.paging?.next };
      },
    }),
  );

  assert.deepEqual(boundaries, [
    { pageNumber: 1, collectedItems: 0 },
    { pageNumber: 2, collectedItems: 1 },
  ]);
  assert.deepEqual(signalCalls, signals);
});

test("collectMetaGraphEdge rejects unsafe absolute paging URLs without disclosing them", async (t) => {
  const unsafeUrls = [
    "http://graph.facebook.com/v25.0/flows?after=protocol-secret",
    "https://graph.example.com/v25.0/flows?after=host-secret",
    "https://graph.facebook.com:444/v25.0/flows?after=port-secret",
    "https://user:password@graph.facebook.com/v25.0/flows?after=user-secret",
    "https://graph.facebook.com/v25.0/flows?after=fragment-secret#page",
  ];

  for (const unsafeUrl of unsafeUrls) {
    await t.test(new URL(unsafeUrl).hostname || unsafeUrl, async () => {
      const client = {
        getJson: async () => ({
          data: [],
          paging: { next: unsafeUrl },
        }),
      } as unknown as WhatsAppGraphClient;

      await assert.rejects(
        collectMetaGraphEdge({
          client,
          accessToken: "header-token",
          path: "waba-1/flows",
          maxPages: 2,
          maxItems: 2,
          normalizePage: (payload: unknown) => {
            const page = payload as {
              data: readonly unknown[];
              paging?: { next?: string };
            };
            return { data: page.data, next: page.paging?.next };
          },
        }),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.equal(error.message.includes("secret"), false);
          assert.equal(error.message.includes(unsafeUrl), false);
          return true;
        },
      );
    });
  }
});

test("collectMetaGraphEdge rejects repeated next links even when query tokens rotate", async () => {
  let calls = 0;
  const client = {
    getJson: async () => {
      calls += 1;
      return {
        data: [{ id: String(calls) }],
        paging: {
          next: `https://graph.facebook.com/v25.0/waba-1/flows?after=cycle-secret&access_token=token-${calls}`,
        },
      };
    },
  } as unknown as WhatsAppGraphClient;

  await assert.rejects(
    collectMetaGraphEdge({
      client,
      accessToken: "header-token",
      path: "waba-1/flows",
      maxPages: 5,
      maxItems: 10,
      normalizePage: (payload: unknown) => {
        const page = payload as {
          data: readonly { id: string }[];
          paging?: { next?: string };
        };
        return { data: page.data, next: page.paging?.next };
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof MetaGraphPaginationError);
      assert.equal(error.code, "META_GRAPH_PAGINATION_ERROR");
      assert.equal(error.reason, "cycle");
      assert.equal(error.message, "Meta Graph pagination cycle detected");
      assert.equal(error.message.includes("cycle-secret"), false);
      return true;
    },
  );
  assert.equal(calls, 2);
});

test("collectMetaGraphEdge fails when another page remains at the page bound", async () => {
  const client = {
    getJson: async () => ({
      data: [{ id: "1" }],
      paging: {
        next: "https://graph.facebook.com/v25.0/waba-1/flows?after=page-secret",
      },
    }),
  } as unknown as WhatsAppGraphClient;

  await assert.rejects(
    collectMetaGraphEdge({
      client,
      accessToken: "header-token",
      path: "waba-1/flows",
      maxPages: 1,
      maxItems: 10,
      normalizePage: (payload: unknown) => {
        const page = payload as {
          data: readonly { id: string }[];
          paging?: { next?: string };
        };
        return { data: page.data, next: page.paging?.next };
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof MetaGraphPaginationError);
      assert.equal(error.code, "META_GRAPH_PAGINATION_ERROR");
      assert.equal(error.reason, "page_limit");
      assert.equal(error.message, "Meta Graph page limit exceeded");
      assert.equal(error.message.includes("page-secret"), false);
      return true;
    },
  );
});
