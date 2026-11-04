import {
  createProductKit,
  fetchProductKit,
  fetchProductKitPlan,
  fetchProductsMade,
  loadProductKitEditSource,
  newKitRequestId,
  prepareProductKitDrafts,
  productKitEditUrl,
  productKitPlanUrl,
  retryProductKitPart,
  sendProductKitFormTest,
  sendProductKitPartEdit,
} from "./kits-client";
import { ProductDraftError } from "./products-client";

// The kit requests the make view and the made list send.

const kit = { id: "kit-1", parts: {}, status: "ready" };
let calls: Array<{ url: string; init?: RequestInit }>;
let answer: { status: number; body: unknown };

beforeEach(() => {
  calls = [];
  answer = { status: 200, body: { kit } };
  global.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(answer.body), {
      status: answer.status,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
});

test("the plan's address names the products, and the review they came from", () => {
  expect(productKitPlanUrl("ws 1", ["a", "b"], "imp")).toBe(
    "/api/workspaces/ws%201/products/kits?products=a%2Cb&importId=imp"
  );
  expect(productKitPlanUrl("ws", ["a"], null)).toBe(
    "/api/workspaces/ws/products/kits?products=a"
  );
});

test("a press posts the request as JSON and answers with the kit", async () => {
  const request = {
    requestId: "press-0001",
    productIds: ["a"],
    make: { carousel: false, orderForm: true },
  };

  expect(await createProductKit("ws", request)).toEqual(kit);
  expect(calls[0]!.url).toBe("/api/workspaces/ws/products/kits");
  expect(calls[0]!.init).toMatchObject({ method: "POST" });
  expect(JSON.parse(String(calls[0]!.init!.body))).toEqual(request);
});

test("a part is made again by its own request", async () => {
  expect(await retryProductKitPart("ws", "kit-1", "carousel")).toEqual(kit);
  expect(calls[0]!.url).toBe("/api/workspaces/ws/products/kits/kit-1/retry");
  expect(JSON.parse(String(calls[0]!.init!.body))).toEqual({
    part: "carousel",
  });
});

test("a refusal throws the API's code; an answer without a kit is a failure", async () => {
  answer = { status: 409, body: { code: "whatsapp_not_connected" } };
  await expect(fetchProductKit("/kit")).rejects.toEqual(
    new ProductDraftError("whatsapp_not_connected")
  );

  answer = { status: 200, body: { kit: null } };
  await expect(fetchProductKit("/kit")).rejects.toMatchObject({
    code: "failed",
  });

  answer = { status: 200, body: { products: "nope" } };
  await expect(fetchProductKitPlan("/plan")).rejects.toMatchObject({
    code: "failed",
  });

  answer = { status: 200, body: { kits: [], ads: null } };
  await expect(fetchProductsMade("/made")).rejects.toMatchObject({
    code: "failed",
  });
});

test("each press gets its own id, in the form the API takes", () => {
  const first = newKitRequestId();
  expect(first).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
  expect(newKitRequestId()).not.toBe(first);
});

// ------------------------------------------------------------ kit editing

const carousel = {
  name: "products_20261103_091500_abcdef",
  language: "kk",
  components: [{ type: "BODY", text: "Біздің тауарлар" }],
  productIds: ["a", "b"],
  leftOut: 0,
};

test("Edit cards before Make posts the products and language, and answers the shelf's cards", async () => {
  answer = { status: 200, body: { carousel } };

  expect(
    await prepareProductKitDrafts("ws", {
      productIds: ["a", "b"],
      language: "kk",
    })
  ).toEqual({ carousel });
  expect(calls[0]!.url).toBe("/api/workspaces/ws/products/kits/drafts");
  expect(calls[0]!.init).toMatchObject({ method: "POST" });
  expect(JSON.parse(String(calls[0]!.init!.body))).toEqual({
    productIds: ["a", "b"],
    language: "kk",
  });

  answer = { status: 200, body: { carousel: { name: "x" } } };
  await expect(
    prepareProductKitDrafts("ws", { productIds: ["a"], language: "kk" })
  ).rejects.toMatchObject({ code: "failed" });

  answer = { status: 409, body: { code: "storage_full" } };
  await expect(
    prepareProductKitDrafts("ws", { productIds: ["a"], language: "kk" })
  ).rejects.toMatchObject({ code: "storage_full" });
});

test("an edit opens with what the part sent, read by its part", async () => {
  expect(productKitEditUrl("ws", "kit-1")).toBe(
    "/api/workspaces/ws/products/kits/kit-1/edit"
  );
  answer = { status: 200, body: { kit, carousel } };

  expect(await loadProductKitEditSource("ws", "kit-1", "carousel")).toEqual({
    kit,
    carousel,
  });
  expect(calls[0]!.url).toBe(
    "/api/workspaces/ws/products/kits/kit-1/edit?part=carousel"
  );
  expect(calls[0]!.init).toMatchObject({ method: "GET" });

  answer = { status: 200, body: { carousel } };
  await expect(
    loadProductKitEditSource("ws", "kit-1", "carousel")
  ).rejects.toMatchObject({ code: "failed" });
});

test("an edit sent again answers with the kit, or throws with the issues, the kit found at Meta, or Meta's words", async () => {
  const request = {
    requestId: "edit-0001",
    part: "carousel" as const,
    name: carousel.name,
    components: carousel.components as never,
  };
  expect(await sendProductKitPartEdit("ws", "kit-1", request)).toEqual(kit);
  expect(calls[0]!.url).toBe("/api/workspaces/ws/products/kits/kit-1/edit");
  expect(JSON.parse(String(calls[0]!.init!.body))).toEqual(request);

  answer = {
    status: 400,
    body: { code: "invalid_request", issues: ["One", "Two", "Three", "Four"] },
  };
  await expect(
    sendProductKitPartEdit("ws", "kit-1", request)
  ).rejects.toMatchObject({
    code: "invalid_request",
    issues: ["One", "Two", "Three"],
  });

  answer = { status: 409, body: { code: "carousel_found", kit } };
  await expect(
    sendProductKitPartEdit("ws", "kit-1", request)
  ).rejects.toMatchObject({ code: "carousel_found", kit });

  answer = {
    status: 409,
    body: { code: "meta_refused", issues: ["Your card breaks a policy."], kit },
  };
  await expect(
    sendProductKitPartEdit("ws", "kit-1", request)
  ).rejects.toMatchObject({
    code: "meta_refused",
    issues: ["Your card breaks a policy."],
    kit,
  });
});

test("Send me the order form posts the form part to the kit's test send", async () => {
  answer = { status: 200, body: { sent: true } };
  await sendProductKitFormTest("ws", "kit-1");
  expect(calls[0]!.url).toBe(
    "/api/workspaces/ws/products/kits/kit-1/send-test"
  );
  expect(JSON.parse(String(calls[0]!.init!.body))).toEqual({
    part: "orderForm",
  });

  answer = { status: 409, body: { code: "test_phone_missing" } };
  await expect(sendProductKitFormTest("ws", "kit-1")).rejects.toMatchObject({
    code: "test_phone_missing",
  });
});
