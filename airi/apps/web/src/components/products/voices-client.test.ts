/** @jest-environment node */
import { ProductDraftError } from "./products-client";
import {
  changeProductAdVoice,
  createProductVoice,
  fetchProductVoice,
  fetchProductVoiceSamples,
  productAdVoiceUrl,
  productVoiceSamplesUrl,
  removeProductVoice,
} from "./voices-client";

const WS = "workspace 1";
const AD = "751f1f77bcf86cd799439031";
const API = "/api/workspaces/workspace%201/products";

const fetchMock = jest.fn();
const answer = (body: unknown, status = 200) => ({
  ok: status < 400,
  status,
  json: async () => body,
});

beforeEach(() => {
  fetchMock.mockReset();
  global.fetch = fetchMock as unknown as typeof fetch;
});

test("the voice API's links", () => {
  expect(productVoiceSamplesUrl(WS, "kk")).toBe(
    `${API}/voice/samples?language=kk`
  );
  expect(productAdVoiceUrl(WS, AD)).toBe(`${API}/ads/${AD}/voice`);
});

test("the workspace's voice, or none", async () => {
  fetchMock.mockResolvedValueOnce(answer({ voice: { state: "ready" } }));
  expect(await fetchProductVoice(`${API}/voice`)).toEqual({ state: "ready" });
  fetchMock.mockResolvedValueOnce(answer({ voice: null }));
  expect(await fetchProductVoice(`${API}/voice`)).toBeNull();
  fetchMock.mockResolvedValueOnce(answer({}));
  await expect(fetchProductVoice(`${API}/voice`)).rejects.toBeInstanceOf(
    ProductDraftError
  );
});

test("the consent posts the tick and the products, and a refusal keeps its code", async () => {
  fetchMock.mockResolvedValueOnce(answer({ voice: { state: "pending" } }, 201));
  expect(
    await createProductVoice(WS, { consent: true, productIds: [AD] })
  ).toEqual({
    state: "pending",
  });
  expect(fetchMock).toHaveBeenLastCalledWith(
    `${API}/voice`,
    expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ consent: true, productIds: [AD] }),
    })
  );
  fetchMock.mockResolvedValueOnce(
    answer({ error: "x", code: "voice_consent_required" }, 400)
  );
  await expect(createProductVoice(WS, { consent: true })).rejects.toMatchObject(
    {
      code: "voice_consent_required",
    }
  );
});

test("Remove my voice deletes; a failure says why", async () => {
  fetchMock.mockResolvedValueOnce(answer({ voice: null }));
  await removeProductVoice(WS);
  expect(fetchMock).toHaveBeenLastCalledWith(
    `${API}/voice`,
    expect.objectContaining({ method: "DELETE" })
  );
  fetchMock.mockResolvedValueOnce(
    answer({ error: "x", code: "voice_unavailable" }, 503)
  );
  await expect(removeProductVoice(WS)).rejects.toMatchObject({
    code: "voice_unavailable",
  });
});

test("airi's voices, and an ad read in another voice", async () => {
  fetchMock.mockResolvedValueOnce(answer({ language: "kk", samples: [] }));
  expect(
    await fetchProductVoiceSamples(productVoiceSamplesUrl(WS, "kk"))
  ).toEqual({
    language: "kk",
    samples: [],
  });
  fetchMock.mockResolvedValueOnce(
    answer({ ad: { id: AD, status: "making" } }, 202)
  );
  expect(
    await changeProductAdVoice(WS, AD, { requestId: "r1", voice: "none" })
  ).toEqual({ id: AD, status: "making" });
  fetchMock.mockResolvedValueOnce(
    answer({ error: "x", code: "spend_limit" }, 409)
  );
  await expect(
    changeProductAdVoice(WS, AD, { requestId: "r1", voice: "clone" })
  ).rejects.toMatchObject({ code: "spend_limit" });
});
