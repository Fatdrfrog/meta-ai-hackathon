import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test, expect } from "@playwright/test";
import type {
  CommerceTrackingEventType,
  CommerceTrackingInput,
} from "@icecore/shared/types/commerce-tracking";

type CartTestWindow = Window & {
  AiriChat?: {
    track: (
      type: CommerceTrackingEventType,
      payload: CommerceTrackingInput
    ) => void;
  };
};

let server: Server;
let baseUrl: string;
const widgetDist = path.resolve(process.cwd(), "../widget/dist");

test.beforeAll(async () => {
  server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url || "/", "http://localhost").pathname;
      const requestedFile = pathname === "/" ? "index.html" : pathname.slice(1);
      const resolvedFile = path.resolve(widgetDist, requestedFile);
      if (!resolvedFile.startsWith(`${widgetDist}${path.sep}`)) {
        response.writeHead(404).end();
        return;
      }
      const body = await readFile(resolvedFile);
      response.writeHead(200, {
        "Content-Type": resolvedFile.endsWith(".js")
          ? "text/javascript"
          : resolvedFile.endsWith(".css")
            ? "text/css"
            : "text/html",
      });
      response.end(body);
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Fixture server failed");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close(error => (error ? reject(error) : resolve()))
  );
});

test("shows a neutral fallback when noopener makes window.open return null", async ({
  page,
}, testInfo) => {
  const consoleErrors: string[] = [];
  let handoffAttempts = 0;
  page.on("console", message => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  await page.addInitScript(() => {
    const browserWindow = window as typeof window & {
      __airiOpenCall?: unknown[];
    };
    browserWindow.open = (...args: Parameters<typeof window.open>) => {
      browserWindow.__airiOpenCall = args;
      return null;
    };
  });

  await page.route("**/api/widget/config**", route =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        success: true,
        config: {
          sourceId: "source-browser",
          workspaceId: "workspace-browser",
          companyId: "company-browser",
          theme: {
            primaryColor: "#0B6BCB",
            bubbleColor: "#0B6BCB",
            headerBgColor: "#FFFFFF",
            headerTextColor: "#111827",
          },
          settings: {
            welcomeMessage: "How can we help you today?",
            responseTime: "Usually within a few hours",
            aiEnabled: true,
            autoOpen: false,
            position: "bottom-right",
          },
          content: {
            botName: "Store support",
            headerTitle: "Chat with us",
            heroTitle: "",
            ctaPrimaryText: "Send us a message",
            ctaSecondaryText: "We typically reply in a few minutes",
            quickReplies: [],
          },
          branding: {
            bubbleMode: "icon",
            bubbleText: "",
            bubbleSvgUrl: "",
            logoMode: "default",
            logoText: "",
            logoSvgUrl: "",
          },
          layout: {
            homeVariant: "intercom",
            showHelpTab: true,
            showNewsTab: false,
          },
          locale: "en",
          realtime: { url: "" },
        },
      }),
    })
  );
  await page.route("**/api/widget/conversations/history**", route =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ success: true, conversations: [] }),
    })
  );
  await page.route("**/api/widget/commerce", async route => {
    const body = route.request().postDataJSON();
    if (body.action === "session") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          enabled: true,
          sessionToken: "browser-session",
        }),
      });
      return;
    }
    if (body.action === "events" || body.action === "carts") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          carts: [
            {
              cartId: "cart-browser",
              status: "cart",
              itemCount: 2,
              total: 14990,
              currency: "KZT",
              recoveryUrl: "https://store.example/cart/browser",
              linked: false,
            },
          ],
        }),
      });
      return;
    }
    if (body.action === "handoff") {
      handoffAttempts += 1;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(
          handoffAttempts === 1
            ? {}
            : { url: "https://wa.me/77010000000?text=cart-browser" }
        ),
      });
      return;
    }
    await route.fulfill({ status: 400, body: "unexpected action" });
  });

  await page.goto(baseUrl);
  await page.evaluate(apiUrl => {
    const script = document.createElement("script");
    script.src = "/loader.js";
    script.dataset.clientKey = "browser-client-key";
    script.dataset.apiUrl = apiUrl;
    document.body.appendChild(script);
  }, `${baseUrl}/api/widget`);
  await page.waitForFunction(
    () => typeof (window as CartTestWindow).AiriChat?.track === "function"
  );
  await page.evaluate(() =>
    (window as CartTestWindow).AiriChat!.track("cart_updated", {
      eventId: "browser-cart-null-window-open",
      cartId: "cart-browser",
      currency: "KZT",
      recoveryUrl: "https://store.example/cart/browser",
      items: [{ id: "sku-1", name: "Green shirt", quantity: 2, price: 29.5 }],
    })
  );

  const panel = page.getByLabel("Your cart");
  await panel.getByRole("checkbox").check();
  await panel.getByRole("button", { name: "Send my cart to WhatsApp" }).click();
  await expect(panel.getByRole("alert")).toContainText(
    "We could not prepare your WhatsApp cart"
  );
  await expect(
    panel.getByRole("link", { name: "Open WhatsApp and send" })
  ).toHaveCount(0);
  await panel.getByRole("button", { name: "Try again" }).click();

  const fallback = panel.getByRole("link", { name: "Open WhatsApp and send" });
  await expect(fallback).toBeVisible();
  await expect(fallback).toHaveAttribute(
    "href",
    "https://wa.me/77010000000?text=cart-browser"
  );
  await expect(panel.getByRole("alert")).toHaveCount(0);
  const viewport = page.viewportSize();
  const bounds = await panel.boundingBox();
  expect(viewport).not.toBeNull();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.y).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport!.width);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport!.height);
  await page.screenshot({
    path: testInfo.outputPath(
      `widget-cart-recovery-${testInfo.project.name}.png`
    ),
    fullPage: true,
  });
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as typeof window & { __airiOpenCall?: unknown[] })
            .__airiOpenCall
      )
    )
    .toEqual([
      "https://wa.me/77010000000?text=cart-browser",
      "_blank",
      "noopener,noreferrer",
    ]);
  expect(consoleErrors).toEqual([]);
});
