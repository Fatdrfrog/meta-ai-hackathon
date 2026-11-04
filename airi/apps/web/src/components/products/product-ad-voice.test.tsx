/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import {
  PRODUCT_AD_STOCK_VOICES,
  type ProductAdBriefProduct,
  type ProductAdRecord,
  type ProductVoiceRecord,
} from "@/lib/products/types";
import { installMatchMedia } from "@/test-support/dom-test-utils";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { useState } from "react";
import { SWRConfig } from "swr";
import {
  newWordsCents,
  PRODUCT_AD_VOICE_DEFAULT,
  ProductAdVoiceChoice,
  ProductAdVoicePanel,
  productAdVoiceRequest,
  recordingCents,
  type ProductAdVoiceValue,
} from "./product-ad-voice";

// The ad's voice: the brief's four voices, the consent before the owner's
// voice is copied, "Remove my voice", airi's voices with their samples, and
// the finished ad read again in another voice.

installMatchMedia();

const WS = "workspace-1";
const DOLL = "651f1f77bcf86cd799439011";
const MUG = "651f1f77bcf86cd799439012";
const AD = "751f1f77bcf86cd799439031";
const API = `/api/workspaces/${WS}/products`;
const VOICE_URL = `${API}/voice`;
const SAMPLES_URL = `${API}/voice/samples?language=kk`;
const AD_VOICE_URL = `${API}/ads/${AD}/voice`;
const IMPORT = "551f1f77bcf86cd799439021";
/** The video a copy would be made from, for the brief's two products. */
const SOURCE_URL = `${VOICE_URL}?productIds=${encodeURIComponent(`${DOLL},${MUG}`)}`;
const SOURCE = {
  importId: IMPORT,
  sourceVideoAt: "2026-11-01T08:00:00.000Z",
  speechSeconds: 42,
  productNames: ["Кукла Лол", "Кружка"],
};
const [JESSICA, LIAM] = PRODUCT_AD_STOCK_VOICES;

const product = (
  productId: string,
  hasVoice: boolean
): ProductAdBriefProduct => ({
  productId,
  name: productId === DOLL ? "Кукла Лол" : "Кружка",
  englishName: null,
  priceText: "5 000 ₸",
  imageUrl: null,
  problem: null,
  hasVoice,
});
const PRODUCTS = [product(DOLL, true), product(MUG, false)];

const voice = (
  overrides: Partial<ProductVoiceRecord> = {}
): ProductVoiceRecord => ({
  state: "pending",
  sourceImportId: "551f1f77bcf86cd799439021",
  sourceVideoAt: "2026-11-01T08:00:00.000Z",
  speechSeconds: 42,
  errorCode: null,
  consentAt: "2026-11-03T12:00:00.000Z",
  createdAt: "2026-11-03T12:00:00.000Z",
  ...overrides,
});

const samples = {
  language: "kk",
  samples: PRODUCT_AD_STOCK_VOICES.map(stock => ({
    voiceId: stock.id,
    name: stock.name,
    about: stock.about,
    url: `${API}/voice/samples/${stock.id}?language=kk`,
  })),
};

type Answer = { status: number; body: unknown };
const answer =
  (body: unknown, status = 200): (() => Answer) =>
  () => ({ status, body });
let routes: Record<string, (init?: RequestInit) => Answer>;

const callsTo = (method: string, url: string) =>
  (global.fetch as jest.Mock).mock.calls.filter(
    ([called, init]) => called === url && (init?.method ?? "GET") === method
  );

beforeEach(() => {
  routes = {
    [`GET ${VOICE_URL}`]: answer({ voice: null }),
    [`GET ${SOURCE_URL}`]: answer({ voice: null, source: SOURCE }),
    [`GET ${SAMPLES_URL}`]: answer(samples),
  };
  global.fetch = jest.fn(async (url: string, init?: RequestInit) => {
    const route = routes[`${init?.method ?? "GET"} ${url}`];
    if (!route) throw new Error(`Unexpected request: ${init?.method} ${url}`);
    const { status, body } = route(init);
    return { ok: status < 400, status, json: async () => body };
  }) as unknown as typeof fetch;
  window.HTMLMediaElement.prototype.play = jest.fn(() => Promise.resolve());
  window.HTMLMediaElement.prototype.pause = jest.fn();
});

function Brief({
  products = PRODUCTS,
  onValue,
}: {
  products?: ProductAdBriefProduct[];
  onValue?: (value: ProductAdVoiceValue) => void;
}) {
  const [value, setValue] = useState(PRODUCT_AD_VOICE_DEFAULT);
  return (
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <ProductAdVoiceChoice
        workspaceId={WS}
        idPrefix="brief"
        value={value}
        onChange={next => {
          setValue(next);
          onValue?.(next);
        }}
        products={products}
        wordsCode="kk"
      />
      <output data-testid="request">
        {JSON.stringify(productAdVoiceRequest(value, products))}
      </output>
    </SWRConfig>
  );
}

const sent = () =>
  JSON.parse(screen.getByTestId("request").textContent ?? "{}");

describe("the brief's voice", () => {
  it("offers the recording, the owner's voice in new words, Airi voices and no voice", () => {
    render(<Brief />);
    const group = screen.getByRole("group", { name: "Voice" });
    expect(
      within(group)
        .getAllByRole("radio")
        .map(radio => radio.closest("label")?.textContent)
    ).toEqual([
      "Your recording",
      "Your voice, new words",
      "Airi voices",
      "No voice",
    ]);
    expect(screen.getByRole("radio", { name: "Your recording" })).toBeChecked();
    expect(sent()).toEqual({ voice: "own" });
    // Nothing is asked of the API until a new voice is picked.
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("leaves the recording out when the video has no clip of the owner", () => {
    render(<Brief products={[product(DOLL, false)]} />);
    expect(screen.queryByRole("radio", { name: "Your recording" })).toBeNull();
    expect(screen.getByRole("radio", { name: "No voice" })).toBeChecked();
    expect(
      screen.getByText(
        "No voice: the video has no clip of you saying these products' prices."
      )
    ).toBeInTheDocument();
  });

  it("picks the first Airi voice, with a sample of each in the ad's language", async () => {
    render(<Brief />);
    fireEvent.click(screen.getByRole("radio", { name: "Airi voices" }));
    expect(sent()).toEqual({ voice: "stock", stockVoiceId: JESSICA!.id });
    const voices = await screen.findByRole("group", { name: "Airi voice" });
    expect(within(voices).getAllByRole("radio")).toHaveLength(
      PRODUCT_AD_STOCK_VOICES.length
    );
    fireEvent.click(
      within(voices).getByRole("radio", { name: new RegExp(LIAM!.name) })
    );
    expect(sent()).toEqual({ voice: "stock", stockVoiceId: LIAM!.id });

    const play = screen.getByRole("button", {
      name: `Play a sample: ${LIAM!.name}`,
    });
    fireEvent.click(play);
    expect(play).toHaveAttribute("aria-pressed", "true");
    expect(window.HTMLMediaElement.prototype.play).toHaveBeenCalled();
    // Another sample stops the first.
    fireEvent.click(
      screen.getByRole("button", { name: `Play a sample: ${JESSICA!.name}` })
    );
    expect(
      screen.getByRole("button", { name: `Play a sample: ${LIAM!.name}` })
    ).toHaveAttribute("aria-pressed", "false");
  });

  it("says when airi's voices can't load, with Try again", async () => {
    routes[`GET ${SAMPLES_URL}`] = answer(
      { error: "x", code: "load_failed" },
      503
    );
    render(<Brief />);
    fireEvent.click(screen.getByRole("radio", { name: "Airi voices" }));
    expect(
      await screen.findByText("Airi's voices couldn't load.")
    ).toBeInTheDocument();
    routes[`GET ${SAMPLES_URL}`] = answer(samples);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(
      await screen.findByRole("group", { name: "Airi voice" })
    ).toBeInTheDocument();
  });

  it("asks for the consent before copying the owner's voice, and copies it only with the tick", async () => {
    let created: unknown = null;
    routes[`POST ${VOICE_URL}`] = init => {
      created = JSON.parse(String(init?.body));
      return { status: 201, body: { voice: voice() } };
    };
    render(<Brief />);
    fireEvent.click(
      screen.getByRole("radio", { name: "Your voice, new words" })
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Use your voice for new words?",
    });
    // The video the copy is made from is named before the tick.
    expect(
      await within(dialog).findByText(
        "From your video of 1 Nov, with Кукла Лол and Кружка."
      )
    ).toBeInTheDocument();
    // Not chosen until the owner agrees.
    expect(sent()).toEqual({ voice: "own" });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Copy my voice" })
    );
    expect(within(dialog).getByRole("alert")).toHaveTextContent(
      "Tick the box to agree first."
    );
    expect(callsTo("POST", VOICE_URL)).toHaveLength(0);

    fireEvent.click(
      within(dialog).getByRole("checkbox", {
        name: /This is my voice, or the person speaking agreed to have it cloned/,
      })
    );
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Copy my voice" })
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // Agreed for the video shown, not whichever the server would pick.
    expect(created).toEqual({ consent: true, importId: IMPORT });
    expect(sent()).toEqual({ voice: "clone" });
    expect(
      screen.getByText("Copied from your video of 1 Nov when the ad is made.")
    ).toBeInTheDocument();
  });

  it("keeps the earlier voice when the owner doesn't agree", async () => {
    render(<Brief />);
    fireEvent.click(
      screen.getByRole("radio", { name: "Your voice, new words" })
    );
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Not now" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(sent()).toEqual({ voice: "own" });
    expect(screen.getByRole("radio", { name: "Your recording" })).toBeChecked();
  });

  it("says the voice can't be copied while the company has AI turned off", async () => {
    routes[`POST ${VOICE_URL}`] = answer(
      { error: "x", code: "ai_disabled" },
      409
    );
    render(<Brief />);
    fireEvent.click(
      screen.getByRole("radio", { name: "Your voice, new words" })
    );
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByText(/From your video of 1 Nov/);
    fireEvent.click(within(dialog).getByRole("checkbox"));
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Copy my voice" })
    );
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "AI is turned off for your company, so your voice can't be copied."
    );
    expect(sent()).toEqual({ voice: "own" });
  });

  it("explains a video with too little speech, and stays on the voice before", async () => {
    routes[`POST ${VOICE_URL}`] = answer(
      {
        voice: voice({
          state: "failed",
          errorCode: "too_little_speech",
          speechSeconds: 12,
        }),
      },
      201
    );
    render(<Brief />);
    fireEvent.click(
      screen.getByRole("radio", { name: "Your voice, new words" })
    );
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByText(/From your video of 1 Nov/);
    fireEvent.click(within(dialog).getByRole("checkbox"));
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Copy my voice" })
    );
    expect(
      await screen.findByText(
        /Your video has about 12 s of clear speech, and a copy needs at least 20 s/
      )
    ).toBeInTheDocument();
    expect(sent()).toEqual({ voice: "own" });
  });

  it("says when the products came from no video, and asks for no consent", async () => {
    routes[`GET ${SOURCE_URL}`] = answer({ voice: null, source: null });
    render(<Brief />);
    fireEvent.click(
      screen.getByRole("radio", { name: "Your voice, new words" })
    );
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "These products didn't come from one of your videos"
    );
    expect(
      within(dialog).getByRole("button", { name: "Copy my voice" })
    ).toBeDisabled();
    expect(callsTo("POST", VOICE_URL)).toHaveLength(0);
  });

  it("asks for no consent while the video it would copy can't be found, with Try again", async () => {
    let tries = 0;
    routes[`GET ${SOURCE_URL}`] = () =>
      ++tries === 1
        ? { status: 503, body: { error: "x", code: "load_failed" } }
        : { status: 200, body: { voice: null, source: SOURCE } };
    render(<Brief />);
    fireEvent.click(
      screen.getByRole("radio", { name: "Your voice, new words" })
    );
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "The video your voice would be copied from couldn't be found."
    );
    expect(
      within(dialog).getByRole("button", { name: "Copy my voice" })
    ).toBeDisabled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Try again" }));
    expect(
      await within(dialog).findByText(/From your video of 1 Nov/)
    ).toBeInTheDocument();
    expect(
      within(dialog).getByRole("button", { name: "Copy my voice" })
    ).toBeEnabled();
  });

  it("uses the workspace's copied voice at once, and removes it after a confirm", async () => {
    routes[`GET ${VOICE_URL}`] = answer({ voice: voice({ state: "ready" }) });
    routes[`DELETE ${VOICE_URL}`] = answer({ voice: null });
    render(<Brief />);
    fireEvent.click(
      screen.getByRole("radio", { name: "Your voice, new words" })
    );
    expect(
      await screen.findByText("Made from your video of 1 Nov")
    ).toBeInTheDocument();
    expect(sent()).toEqual({ voice: "clone" });
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Remove my voice" }));
    const confirm = screen.getByRole("group", { name: "Remove my voice" });
    expect(
      within(confirm).getByRole("button", { name: "Keep it" })
    ).toHaveFocus();
    fireEvent.click(within(confirm).getByRole("button", { name: "Remove" }));
    expect(
      await screen.findByText("Your voice was removed.")
    ).toBeInTheDocument();
    expect(callsTo("DELETE", VOICE_URL)).toHaveLength(1);
    expect(sent()).toEqual({ voice: "own" });
  });

  it("keeps the voice and says so when it can't be removed", async () => {
    routes[`GET ${VOICE_URL}`] = answer({ voice: voice({ state: "ready" }) });
    routes[`DELETE ${VOICE_URL}`] = answer(
      { error: "x", code: "voice_unavailable" },
      503
    );
    render(<Brief />);
    fireEvent.click(
      screen.getByRole("radio", { name: "Your voice, new words" })
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Remove my voice" })
    );
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Your voice couldn't be removed right now"
    );
    expect(sent()).toEqual({ voice: "clone" });
  });
});

function adRecord(overrides: Partial<ProductAdRecord> = {}): ProductAdRecord {
  return {
    id: AD,
    status: "ready",
    step: null,
    errorCode: null,
    createdAt: "2026-11-02T09:14:00.000Z",
    requestedAt: "2026-11-02T09:14:00.000Z",
    startedAt: "2026-11-02T09:14:04.000Z",
    readyAt: "2026-11-02T09:15:10.000Z",
    renderNo: 2,
    language: "Kazakh",
    timings: {},
    idea: { kind: "new", text: null },
    voice: "own",
    stockVoiceId: null,
    voiceResult: null,
    runKind: "make",
    lastRun: null,
    picturesLeft: null,
    openings: [],
    endings: [],
    ending: { phone: null, shopName: "QazOner" },
    products: [
      {
        productId: DOLL,
        name: "Кукла Лол",
        englishName: null,
        priceText: "5 000 ₸",
        imageUrl: null,
      },
      {
        productId: MUG,
        name: "Кружка",
        englishName: null,
        priceText: "500 ₸",
        imageUrl: null,
      },
    ],
    script: null,
    scenes: [],
    video: null,
    stills: { statusUrl: null, feedUrl: null },
    post: null,
    ctwa: null,
    presenter: null,
    costUsd: 0.08,
    ...overrides,
  };
}

function Panel({
  ad,
  onChanged = jest.fn(),
}: {
  ad: ProductAdRecord;
  onChanged?: (ad: ProductAdRecord) => void;
}) {
  return (
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <ProductAdVoicePanel workspaceId={WS} ad={ad} onChanged={onChanged} />
    </SWRConfig>
  );
}

describe("the finished ad's voice", () => {
  it("says what the video has, and why it fell back", () => {
    render(
      <Panel
        ad={adRecord({
          voice: "stock",
          stockVoiceId: JESSICA!.id,
          voiceResult: { used: "none", fallback: "spend_refused" },
        })}
      />
    );
    expect(screen.getByText(/In the video:/).parentElement).toHaveTextContent(
      "No voice"
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "This ad has no AI budget left for a new voice, so the video has no voice."
    );
  });

  it("names the Airi voice the video has", () => {
    render(<Panel ad={adRecord({ voice: "stock", stockVoiceId: LIAM!.id })} />);
    expect(screen.getByText(/In the video:/).parentElement).toHaveTextContent(
      `Airi voices · ${LIAM!.name}`
    );
  });

  it("reads the ad again in an Airi voice, saying what it costs first", async () => {
    const onChanged = jest.fn();
    let body: unknown = null;
    routes[`POST ${AD_VOICE_URL}`] = init => {
      body = JSON.parse(String(init?.body));
      return {
        status: 202,
        body: { ad: adRecord({ status: "making", runKind: "voice" }) },
      };
    };
    render(<Panel ad={adRecord()} onChanged={onChanged} />);
    fireEvent.click(screen.getByRole("button", { name: "Change the voice" }));
    expect(
      screen.getByText("The video already has this voice.")
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Make the video with this voice" })
    ).toBeDisabled();
    fireEvent.click(screen.getByRole("radio", { name: "Airi voices" }));
    expect(
      screen.getByText(
        `Reading new words costs about ${newWordsCents(2, false)}¢ of AI on this ad`
      )
    ).toBeInTheDocument();
    await screen.findByRole("group", { name: "Airi voice" });
    fireEvent.click(
      screen.getByRole("button", { name: "Make the video with this voice" })
    );
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(body).toEqual({
      requestId: expect.any(String),
      voice: "stock",
      stockVoiceId: JESSICA!.id,
    });
    expect(
      screen.getByRole("button", { name: "Change the voice" })
    ).toBeInTheDocument();
  });

  it("is free to go back to the recording or no voice", () => {
    render(
      <Panel ad={adRecord({ voice: "stock", stockVoiceId: JESSICA!.id })} />
    );
    fireEvent.click(screen.getByRole("button", { name: "Change the voice" }));
    fireEvent.click(screen.getByRole("radio", { name: "No voice" }));
    expect(screen.getByText("Free · no AI used")).toBeInTheDocument();
  });

  it("explains a refusal in the owner's words", async () => {
    routes[`POST ${AD_VOICE_URL}`] = answer(
      { error: "x", code: "spend_limit" },
      409
    );
    render(<Panel ad={adRecord()} />);
    fireEvent.click(screen.getByRole("button", { name: "Change the voice" }));
    fireEvent.click(screen.getByRole("radio", { name: "No voice" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Make the video with this voice" })
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The company's AI spending limit has been reached."
    );
  });

  it("waits while the new voice is read, and says when a change failed", () => {
    const { rerender } = render(
      <Panel ad={adRecord({ status: "making", runKind: "voice" })} />
    );
    expect(
      screen.getByText("Making the video with the new voice…")
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Change the voice" })
    ).toBeDisabled();
    rerender(
      <Panel
        ad={adRecord({
          lastRun: {
            renderNo: 3,
            kind: "voice",
            outcome: "failed",
            errorCode: "failed",
            at: "2026-11-03T12:00:00.000Z",
          },
        })}
      />
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "The voice couldn't be changed. Your earlier video is still here."
    );
    // Stopped because the company turned AI off: says so, not "try again".
    rerender(
      <Panel
        ad={adRecord({
          lastRun: {
            renderNo: 3,
            kind: "voice",
            outcome: "failed",
            errorCode: "ai_disabled",
            at: "2026-11-03T12:00:00.000Z",
          },
        })}
      />
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "AI is turned off for your company."
    );
  });

  it("explains a company that turned AI off", async () => {
    routes[`POST ${AD_VOICE_URL}`] = answer(
      { error: "x", code: "ai_disabled" },
      409
    );
    render(<Panel ad={adRecord()} />);
    fireEvent.click(screen.getByRole("button", { name: "Change the voice" }));
    fireEvent.click(screen.getByRole("radio", { name: "No voice" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Make the video with this voice" })
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "AI is turned off for your company."
    );
  });

  it("sends the same voice again after its voice run failed", async () => {
    const onChanged = jest.fn();
    let body: unknown = null;
    routes[`POST ${AD_VOICE_URL}`] = init => {
      body = JSON.parse(String(init?.body));
      return {
        status: 202,
        body: { ad: adRecord({ status: "making", runKind: "voice" }) },
      };
    };
    render(
      <Panel
        ad={adRecord({
          voice: "stock",
          stockVoiceId: JESSICA!.id,
          lastRun: {
            renderNo: 2,
            kind: "voice",
            outcome: "failed",
            errorCode: "failed",
            at: "2026-11-03T12:00:00.000Z",
          },
        })}
        onChanged={onChanged}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Change the voice" }));
    expect(
      screen.queryByText("The video already has this voice.")
    ).not.toBeInTheDocument();
    await screen.findByRole("group", { name: "Airi voice" });
    fireEvent.click(
      screen.getByRole("button", { name: "Make the video with this voice" })
    );
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(body).toEqual({
      requestId: expect.any(String),
      voice: "stock",
      stockVoiceId: JESSICA!.id,
    });
  });
});

describe("the finished ad's voice, what it costs and where the focus goes", () => {
  it("counts copying the voice in the cost while it's still to be copied", async () => {
    routes[`GET ${VOICE_URL}`] = answer({ voice: voice({ state: "pending" }) });
    render(<Panel ad={adRecord()} />);
    fireEvent.click(screen.getByRole("button", { name: "Change the voice" }));
    fireEvent.click(
      screen.getByRole("radio", { name: "Your voice, new words" })
    );
    expect(
      await screen.findByText(
        `Reading new words costs about ${newWordsCents(2, true)}¢ of AI on this ad`
      )
    ).toBeInTheDocument();
  });

  it("counts only the reading once the voice is copied", async () => {
    routes[`GET ${VOICE_URL}`] = answer({ voice: voice({ state: "ready" }) });
    render(<Panel ad={adRecord()} />);
    fireEvent.click(screen.getByRole("button", { name: "Change the voice" }));
    fireEvent.click(
      screen.getByRole("radio", { name: "Your voice, new words" })
    );
    expect(
      await screen.findByText(
        `Reading new words costs about ${newWordsCents(2, false)}¢ of AI on this ad`
      )
    ).toBeInTheDocument();
  });

  it("says the recording costs a little on an ad never read in it, and nothing once it was", () => {
    const { unmount } = render(
      <Panel
        ad={adRecord({
          voice: "stock",
          stockVoiceId: JESSICA!.id,
          voiceResult: { used: "stock", fallback: null },
        })}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Change the voice" }));
    fireEvent.click(screen.getByRole("radio", { name: "Your recording" }));
    expect(
      screen.getByText(
        `Cleaning up your recording costs about ${recordingCents(2)}¢ of AI on this ad`
      )
    ).toBeInTheDocument();
    unmount();

    // New words that fell back to the recording left it cleaned up and kept.
    render(
      <Panel
        ad={adRecord({
          voice: "clone",
          voiceResult: { used: "own", fallback: "no_voice" },
        })}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Change the voice" }));
    fireEvent.click(screen.getByRole("radio", { name: "Your recording" }));
    expect(screen.getByText("Free · no AI used")).toBeInTheDocument();
  });

  it("offers no recording on an ad without the owner's words", () => {
    render(<Panel ad={adRecord({ voice: "none", hasRecording: false })} />);
    fireEvent.click(screen.getByRole("button", { name: "Change the voice" }));
    expect(screen.queryByRole("radio", { name: "Your recording" })).toBeNull();
    expect(screen.getByRole("radio", { name: "No voice" })).toBeChecked();
  });

  it("says Voice once: the open picker's legend is for screen readers", () => {
    render(<Panel ad={adRecord()} />);
    fireEvent.click(screen.getByRole("button", { name: "Change the voice" }));
    expect(screen.getByRole("group", { name: "Voice" })).toBeInTheDocument();
    expect(screen.getByText("Voice", { selector: "legend" })).toHaveClass(
      "sr-only"
    );
  });

  it("gives the focus back to Change after Cancel", () => {
    render(<Panel ad={adRecord()} />);
    fireEvent.click(screen.getByRole("button", { name: "Change the voice" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(
      screen.getByRole("button", { name: "Change the voice" })
    ).toHaveFocus();
  });

  it("gives the focus to the panel's heading after Apply, while the new run keeps Change off", async () => {
    routes[`POST ${AD_VOICE_URL}`] = answer(
      { ad: adRecord({ status: "making", runKind: "voice" }) },
      202
    );
    function Live() {
      const [ad, setAd] = useState(adRecord());
      return <Panel ad={ad} onChanged={setAd} />;
    }
    render(<Live />);
    fireEvent.click(screen.getByRole("button", { name: "Change the voice" }));
    fireEvent.click(screen.getByRole("radio", { name: "No voice" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Make the video with this voice" })
    );
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Voice" })).toHaveFocus()
    );
    expect(
      screen.getByRole("button", { name: "Change the voice" })
    ).toBeDisabled();
  });
});

describe("the cost of new words", () => {
  it("is about a cent a product, more while the voice is copied", () => {
    expect(newWordsCents(1, false)).toBe(1);
    expect(newWordsCents(3, false)).toBe(2);
    expect(newWordsCents(3, true)).toBe(14);
  });

  it("cleaning up the recording is about a cent a product", () => {
    expect(recordingCents(1)).toBe(1);
    expect(recordingCents(3)).toBe(3);
  });
});
