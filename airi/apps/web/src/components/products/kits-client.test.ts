import {
  createProductKit,
  fetchProductKit,
  fetchProductKitPlan,
  fetchProductsMade,
  newKitRequestId,
  productKitPlanUrl,
  retryProductKitPart,
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
