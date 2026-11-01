/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import type { ProductsWhatsAppLinkResponse } from "@/lib/products/types";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { SWRConfig } from "swr";
import {
  WHATSAPP_LINK_POLL_MS,
  WhatsAppLinkButton,
} from "./product-whatsapp-link";

// "Send from WhatsApp": a QR whose message names the shop, and the phones
// that sent it, waiting here for the admin to say they're theirs.

const mockToDataUrl = jest.fn();
jest.mock("qrcode", () => ({
  __esModule: true,
  default: { toDataURL: (...args: unknown[]) => mockToDataUrl(...args) },
}));

const API = "/api/workspaces/workspace-1/products/whatsapp-link";
const LINK_URL = `https://wa.me/77080000011?text=${encodeURIComponent(
  "Hi Airi! Please link this phone to my shop QazOner Group."
)}`;
const TITLE = "Send videos from your phone";

const panel = (
  overrides: Partial<ProductsWhatsAppLinkResponse> = {}
): ProductsWhatsAppLinkResponse => ({
  pairing: {
    url: LINK_URL,
    expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
  },
  requests: [],
  linkedPhones: [],
  businessNumbers: [],
  ...overrides,
});
const ask = (id: string, phone: string, profileName: string | null = null) => ({
  id,
  phone,
  profileName,
  createdAt: new Date().toISOString(),
});
const linked = (
  id: string,
  phone: string,
  via: "approved" | "connected_number" | "code" = "approved"
) => ({
  id,
  phone,
  via,
  linkedAt: new Date().toISOString(),
  lastVideoAt: null,
});

type Answer = { ok: boolean; status: number; json: () => Promise<unknown> };
const answer =
  (body: unknown, status = 200) =>
  (): Answer => ({ ok: status < 400, status, json: async () => body });

/** What each request answers, by method and path. */
let routes: Record<string, () => Answer | Promise<Answer>>;

beforeEach(() => {
  mockToDataUrl.mockReset().mockResolvedValue("data:image/png;base64,QR");
  routes = {
    [`POST ${API}`]: answer(panel(), 201),
    [`GET ${API}`]: answer(panel()),
  };
  global.fetch = jest.fn(async (url: string, init?: RequestInit) => {
    const route = routes[`${init?.method ?? "GET"} ${url}`];
    if (!route) throw new Error(`Unexpected request: ${init?.method} ${url}`);
    return route();
  }) as unknown as typeof fetch;
});

const requestsTo = (method: string, url = API) =>
  (global.fetch as jest.Mock).mock.calls.filter(
    ([called, init]) => called === url && (init?.method ?? "GET") === method
  );

function openPanel() {
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <WhatsAppLinkButton workspaceId="workspace-1" number="+7 708 000 0011" />
    </SWRConfig>
  );
  fireEvent.click(screen.getByRole("button", { name: "Send from WhatsApp" }));
}

describe("WhatsAppLinkButton", () => {
  it("opens the shop to phones and shows a QR whose message names the shop", async () => {
    openPanel();

    expect(await screen.findByRole("img", { name: TITLE })).toHaveAttribute(
      "src",
      "data:image/png;base64,QR"
    );
    expect(global.fetch).toHaveBeenCalledWith(API, {
      method: "POST",
      cache: "no-store",
    });
    expect(mockToDataUrl).toHaveBeenCalledWith(LINK_URL, expect.anything());
    expect(screen.getByRole("link", { name: "Open WhatsApp" })).toHaveAttribute(
      "href",
      LINK_URL
    );
    expect(
      screen.getByText(
        "Scan this with your phone's camera and press Send in WhatsApp. Then confirm your phone here."
      )
    ).toBeInTheDocument();
    // The title holds the focus: no keypress links a phone unread.
    expect(screen.getByText(TITLE)).toHaveFocus();
    expect(requestsTo("GET")).toHaveLength(0);
  });

  it("shows the QR is on its way while the shop opens, still for reduced motion", async () => {
    let opened: (value: Answer) => void = () => undefined;
    routes[`POST ${API}`] = () => new Promise(resolve => (opened = resolve));
    openPanel();

    const placeholder = screen.getByRole("status", {
      name: "Getting your QR code ready…",
    });
    expect(placeholder).toHaveClass("motion-safe:animate-pulse");
    expect(placeholder).not.toHaveClass("animate-pulse");

    await act(async () => opened(answer(panel(), 201)()));
    expect(await screen.findByRole("img", { name: TITLE })).toBeInTheDocument();
  });

  it("asks whether a phone that asked is the admin's, and links it on Yes", async () => {
    routes[`POST ${API}`] = answer(
      panel({ requests: [ask("req-1", "+7 ••• ••• 12 34", "Samat")] }),
      201
    );
    routes[`POST ${API}/requests/req-1`] = answer(
      panel({ linkedPhones: [linked("link-1", "+7 ••• ••• 12 34")] })
    );
    openPanel();

    const question = await screen.findByText("Is +7 ••• ••• 12 34 your phone?");
    expect(question.closest("[aria-live]")).toHaveAttribute(
      "aria-live",
      "polite"
    );
    // The WhatsApp name stands apart, labelled, so it can't pass for the number.
    const name = screen.getByText("WhatsApp name: Samat");
    expect(question).not.toContainElement(name);
    expect(
      screen.getByRole("button", { name: "Yes, link it" })
    ).toHaveAccessibleDescription(
      /^Is \+7\s•••\s•••\s12\s34 your phone\? WhatsApp name: Samat$/
    );
    // The QR waits while a phone asks.
    expect(
      screen.queryByRole("link", { name: "Open WhatsApp" })
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/More than one phone/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Yes, link it" }));

    const line = await screen.findByText("Linked: +7 ••• ••• 12 34");
    await waitFor(() => expect(line).toHaveFocus());
    expect(requestsTo("POST", `${API}/requests/req-1`)).toHaveLength(1);
    expect(screen.queryByText(/your phone\?/)).not.toBeInTheDocument();
    expect(
      screen.getByText(
        "Shelf videos you send to Airi at +7 708 000 0011 turn up here."
      )
    ).toBeInTheDocument();
  });

  it("forgets a phone on Not me, writing nothing to it, and shows the QR again", async () => {
    routes[`POST ${API}`] = answer(
      panel({ requests: [ask("req-1", "+7 ••• ••• 12 34")] }),
      201
    );
    routes[`DELETE ${API}/requests/req-1`] = answer(panel());
    openPanel();

    expect(
      await screen.findByText("Is +7 ••• ••• 12 34 your phone?")
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Not me" }));

    expect(
      await screen.findByRole("link", { name: "Open WhatsApp" })
    ).toBeInTheDocument();
    expect(screen.queryByText(/your phone\?/)).not.toBeInTheDocument();
    expect(requestsTo("DELETE", `${API}/requests/req-1`)).toHaveLength(1);
    await waitFor(() => expect(screen.getByText(TITLE)).toHaveFocus());
  });

  it("warns when more than one phone asked, and keeps long names inside the panel", async () => {
    routes[`POST ${API}`] = answer(
      panel({
        requests: [
          ask("req-1", "+7 ••• ••• 12 34", "Samat"),
          ask("req-2", "+7 ••• ••• 56 78", "Aigerim Nurlanqyzy Seitkali…"),
          ask("req-3", "+998 ••• ••• 90 12"),
        ],
      }),
      201
    );
    openPanel();

    expect(
      await screen.findByText(
        "More than one phone asked. Only link the one you recognise."
      )
    ).toBeInTheDocument();
    expect(
      screen.getAllByRole("button", { name: "Yes, link it" })
    ).toHaveLength(3);
    expect(screen.getAllByRole("button", { name: "Not me" })).toHaveLength(3);
    expect(
      screen.getByText("WhatsApp name: Aigerim Nurlanqyzy Seitkali…")
    ).toHaveClass("break-words");
    expect(
      screen.getByText("Is +998 ••• ••• 90 12 your phone?")
    ).toBeInTheDocument();
    expect(screen.getAllByText(/^WhatsApp name:/)).toHaveLength(2);
  });

  it("says when an ask expired before the admin said Yes", async () => {
    routes[`POST ${API}`] = answer(
      panel({ requests: [ask("req-1", "+7 ••• ••• 12 34")] }),
      201
    );
    routes[`POST ${API}/requests/req-1`] = answer(
      {
        error: "That phone or request wasn't found",
        code: "whatsapp_link_not_found",
      },
      404
    );
    openPanel();

    fireEvent.click(
      await screen.findByRole("button", { name: "Yes, link it" })
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "That request has expired. Send the message from your phone again."
    );
    // The panel asks again, so the ask that's gone leaves it.
    await waitFor(() => expect(requestsTo("GET")).toHaveLength(1));
  });

  it("says when the phone turned out to be another shop's", async () => {
    routes[`POST ${API}`] = answer(
      panel({ requests: [ask("req-1", "+7 ••• ••• 12 34")] }),
      201
    );
    routes[`POST ${API}/requests/req-1`] = answer(
      {
        error: "That phone is linked to another workspace",
        code: "whatsapp_link_linked_elsewhere",
      },
      409
    );
    openPanel();

    fireEvent.click(
      await screen.findByRole("button", { name: "Yes, link it" })
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This phone is linked to another shop in airi. Unlink it there first, then send the message from your phone again."
    );
    await waitFor(() => expect(requestsTo("GET")).toHaveLength(1));
    await waitFor(() => expect(screen.getByText(TITLE)).toHaveFocus());
  });

  it("lists linked phones with Unlink, and shows the QR again to link another", async () => {
    routes[`POST ${API}`] = answer(
      panel({
        linkedPhones: [
          linked("link-1", "+7 ••• ••• 12 34"),
          linked("link-2", "+7 ••• ••• 99 00", "connected_number"),
        ],
      }),
      201
    );
    routes[`DELETE ${API}/phones/link-1`] = answer(panel());
    openPanel();

    expect(
      await screen.findByText("Linked: +7 ••• ••• 12 34")
    ).toBeInTheDocument();
    // The shop's own number needs no linking, so it isn't listed.
    expect(
      screen.queryByText("Linked: +7 ••• ••• 99 00")
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("img", { name: TITLE })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Link another phone" }));
    expect(await screen.findByRole("img", { name: TITLE })).toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.getByText(/^Scan this with your phone's camera/)
      ).toHaveFocus()
    );

    fireEvent.click(screen.getByRole("button", { name: "Unlink" }));
    await waitFor(() =>
      expect(
        screen.queryByText("Linked: +7 ••• ••• 12 34")
      ).not.toBeInTheDocument()
    );
    expect(requestsTo("DELETE", `${API}/phones/link-1`)).toHaveLength(1);
  });

  it("mentions the shop's own WhatsApp Business numbers", async () => {
    routes[`POST ${API}`] = answer(
      panel({ businessNumbers: ["+7 701 999 8877"] }),
      201
    );
    openPanel();

    expect(
      await screen.findByText(
        "Or send videos straight from your shop's WhatsApp Business number +7 701 999 8877. No linking needed."
      )
    ).toBeInTheDocument();
  });

  it("offers to try again when the QR can't be made", async () => {
    routes[`POST ${API}`] = answer({ code: "save_failed" }, 503);
    openPanel();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The QR code couldn't be made. Try again."
    );
    expect(
      screen.queryByRole("link", { name: "Open WhatsApp" })
    ).not.toBeInTheDocument();

    routes[`POST ${API}`] = answer(panel(), 201);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(
      await screen.findByRole("link", { name: "Open WhatsApp" })
    ).toBeInTheDocument();
  });

  it("stays closed to phones while another shop in airi has the same name", async () => {
    routes[`POST ${API}`] = answer(
      {
        error: "Another workspace with Products has the same name",
        code: "whatsapp_link_shop_name_taken",
      },
      409
    );
    openPanel();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Another shop in airi has the same name, so a phone's message can't say which shop it means. Contact airi to change your shop's name."
    );
    expect(
      screen.queryByRole("link", { name: "Open WhatsApp" })
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("img", { name: TITLE })).not.toBeInTheDocument();

    // Once renamed, trying again opens it.
    routes[`POST ${API}`] = answer(panel(), 201);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(
      await screen.findByRole("link", { name: "Open WhatsApp" })
    ).toBeInTheDocument();
  });

  it("checks for phones every few seconds while open, and stops once closed", async () => {
    jest.useFakeTimers();
    try {
      openPanel();
      expect(
        await screen.findByRole("link", { name: "Open WhatsApp" })
      ).toBeInTheDocument();
      expect(requestsTo("GET")).toHaveLength(0);

      routes[`GET ${API}`] = answer(
        panel({ requests: [ask("req-1", "+7 ••• ••• 12 34", "Samat")] })
      );
      await act(async () => {
        jest.advanceTimersByTime(WHATSAPP_LINK_POLL_MS);
      });
      expect(
        await screen.findByText("Is +7 ••• ••• 12 34 your phone?")
      ).toBeInTheDocument();
      expect(requestsTo("GET")).toHaveLength(1);

      fireEvent.keyDown(screen.getByText(TITLE), { key: "Escape" });
      await waitFor(() =>
        expect(screen.queryByText(TITLE)).not.toBeInTheDocument()
      );
      const asked = requestsTo("GET").length;
      await act(async () => {
        jest.advanceTimersByTime(WHATSAPP_LINK_POLL_MS * 5);
      });
      expect(requestsTo("GET")).toHaveLength(asked);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe("keeping the shop open while the panel is", () => {
  // The server opened the shop at noon by its own clock, for 15 minutes.
  const SERVER_NOW = Date.parse("2026-10-30T12:00:00.000Z");
  const opened = () =>
    panel({
      pairing: {
        url: LINK_URL,
        expiresAt: new Date(SERVER_NOW + 15 * 60_000).toISOString(),
      },
    });
  const advance = (ms: number) =>
    act(async () => {
      await jest.advanceTimersByTimeAsync(ms);
    });
  // Minutes at once: the timers due fire in turn, and the requests they
  // start are answered after, so a poll fires once rather than every 3 s.
  const jump = (ms: number) =>
    act(async () => {
      jest.advanceTimersByTime(ms);
    });

  afterEach(() => {
    jest.useRealTimers();
  });

  it.each([
    ["an hour ahead", 60 * 60_000],
    ["an hour behind", -60 * 60_000],
  ])(
    "opens it again before it closes, once, with this computer's clock %s",
    async (_clock, skew) => {
      jest.useFakeTimers({ now: SERVER_NOW + skew });
      routes[`POST ${API}`] = answer(opened(), 201);
      routes[`GET ${API}`] = answer(opened());
      openPanel();
      expect(
        await screen.findByRole("link", { name: "Open WhatsApp" })
      ).toBeInTheDocument();

      // A clock ahead once made the panel open the shop over and over.
      await advance(5_000);
      expect(requestsTo("POST")).toHaveLength(1);

      // A clock behind once left it to close before opening it again.
      await jump(14 * 60_000 + 25_000);
      expect(requestsTo("POST")).toHaveLength(2);
      expect(
        screen.getByRole("link", { name: "Open WhatsApp" })
      ).toBeInTheDocument();
    }
  );

  it("opens a shop a check finds closed at once, but never more than every 30 seconds", async () => {
    jest.useFakeTimers({ now: SERVER_NOW });
    routes[`POST ${API}`] = answer(opened(), 201);
    // The server keeps closing it, say its clocks disagree with each other.
    routes[`GET ${API}`] = answer(panel({ pairing: null }));
    openPanel();
    await screen.findByRole("link", { name: "Open WhatsApp" });

    await advance(10_000);
    expect(requestsTo("POST")).toHaveLength(1);
    await advance(21_000);
    expect(requestsTo("POST")).toHaveLength(2);
    await advance(30_000);
    expect(requestsTo("POST")).toHaveLength(3);
  });
});
