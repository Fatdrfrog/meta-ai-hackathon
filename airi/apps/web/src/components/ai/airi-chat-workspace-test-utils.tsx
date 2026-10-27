/**
 * Shared stand-ins and fixtures for the AiriChatWorkspace test files.
 *
 * Module mocks are hoisted per test file, so each file keeps its own
 * jest.mock calls and builds the factories below with jest.requireActual.
 */
import { screen } from "@testing-library/react";
import React from "react";
import { ReadableStream } from "stream/web";
import { TextDecoder, TextEncoder } from "util";
import { resetAiriChatSessionCache } from "./use-airi-chat-session";

type MessageCatalog = Record<string, unknown>;

const AIRI_CHAT_CATALOG_NAMESPACES = new Set([
  "AiriChat",
  "AiriChatProgress",
  "AiriMetaAds",
]);

/**
 * next-intl with the real AiriChat/AiriChatProgress/AiriMetaAds catalogs
 * (English unless a locale is given); other namespaces return their keys.
 */
export function createAiriChatNextIntlMock(locale: "en" | "ru" | "kz" = "en") {
  const messages = jest.requireActual(
    `../../../messages/${locale}.json`
  ) as MessageCatalog;
  const catalog = (
    jest.requireActual(
      "@/test-support/next-intl-test-utils"
    ) as typeof import("@/test-support/next-intl-test-utils")
  ).createCatalogNextIntlMock(messages, locale);
  const fallback = Object.assign((key: string) => key, {
    has: () => false,
  });
  return {
    useLocale: catalog.useLocale,
    useTranslations: (namespace?: string) =>
      namespace && AIRI_CHAT_CATALOG_NAMESPACES.has(namespace)
        ? catalog.useTranslations(namespace)
        : fallback,
  };
}

type MockTemplateDraft = {
  name: string;
  language: string;
  category: "MARKETING" | "UTILITY" | "AUTHENTICATION";
  components: Array<{ type: string; text?: string }>;
};

/** A thin builder side panel: names, edit buttons, patch and conflict. */
export function createAiriBuilderSidePanelMock() {
  return {
    AiriBuilderSidePanel: (props: {
      mode: "whatsapp_template" | "whatsapp_flow";
      templateDraft: MockTemplateDraft;
      flowConfig: { screens: unknown[] };
      pendingPatch: { summary: string } | null;
      pendingPatchTarget?: "open" | "other" | "new";
      pendingPatchBusy?: boolean;
      pendingPatchBlocked?: boolean;
      hasActiveThread?: boolean;
      onTemplateDraftChange: (
        draft: MockTemplateDraft & { kind: "whatsapp_template" }
      ) => void;
      onApplyPendingPatch: () => void;
      onClose: () => void;
      showCloseButton?: boolean;
      conflict?: { revision: number; canTakeLatest: boolean } | null;
      onKeepLocalChanges?: () => void;
      onTakeLatestVersion?: () => void;
    }) => {
      if (!props.hasActiveThread) return null;
      const edit = (name: string) => () =>
        props.onTemplateDraftChange({
          ...props.templateDraft,
          kind: "whatsapp_template",
          name,
        });

      return React.createElement(
        "div",
        {
          "data-testid": "airi-builder-side-panel",
          "data-mode": props.mode,
          "data-has-active-thread": String(Boolean(props.hasActiveThread)),
        },
        [
          React.createElement(
            "div",
            { key: "template-name", "data-testid": "builder-template-name" },
            props.templateDraft.name
          ),
          React.createElement(
            "div",
            { key: "flow-count", "data-testid": "builder-flow-screen-count" },
            String(props.flowConfig.screens.length)
          ),
          React.createElement(
            "button",
            { key: "edit", type: "button", onClick: edit("local_template") },
            "Edit local template"
          ),
          React.createElement(
            "button",
            {
              key: "edit-again",
              type: "button",
              onClick: edit("newer_template"),
            },
            "Edit template again"
          ),
          props.pendingPatch
            ? React.createElement(
                "button",
                {
                  key: "patch",
                  type: "button",
                  "data-target": props.pendingPatchTarget ?? "open",
                  // Exposed, not enforced, so a test can also reach the
                  // workspace's own guard behind the disabled button.
                  "data-busy": String(Boolean(props.pendingPatchBusy)),
                  "data-blocked": String(Boolean(props.pendingPatchBlocked)),
                  onClick: props.onApplyPendingPatch,
                },
                `Apply update: ${props.pendingPatch.summary}`
              )
            : null,
          props.conflict
            ? React.createElement(
                "div",
                { key: "conflict", role: "alert" },
                `Changed elsewhere: revision ${props.conflict.revision}`,
                React.createElement(
                  "button",
                  { type: "button", onClick: props.onKeepLocalChanges },
                  "Keep my version"
                ),
                React.createElement(
                  "button",
                  {
                    type: "button",
                    disabled: !props.conflict.canTakeLatest,
                    onClick: props.onTakeLatestVersion,
                  },
                  "Use latest version"
                )
              )
            : null,
        ],
        props.showCloseButton !== false
          ? React.createElement(
              "button",
              { type: "button", onClick: props.onClose },
              "Close builder"
            )
          : null
      );
    },
  };
}

export function sseFrame(event: string, data: unknown) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function streamingResponse(params: {
  beforeWait: unknown[];
  afterWait: unknown[];
  wait: Promise<void>;
}) {
  const encoder = new TextEncoder();
  return {
    ok: true,
    headers: {
      get: (name: string) =>
        name.toLowerCase() === "content-type"
          ? "text/event-stream; charset=utf-8"
          : null,
    },
    body: new ReadableStream<Uint8Array>({
      async start(controller) {
        for (const event of params.beforeWait) {
          controller.enqueue(
            encoder.encode(sseFrame((event as { type: string }).type, event))
          );
        }
        await params.wait;
        for (const event of params.afterWait) {
          controller.enqueue(
            encoder.encode(sseFrame((event as { type: string }).type, event))
          );
        }
        controller.close();
      },
    }),
  } as unknown as Response;
}

export function completedMessageStream(params?: {
  metadata?: Record<string, unknown> | null;
  wait?: Promise<void>;
}) {
  const at = new Date("2026-06-12T00:00:00.000Z").toISOString();
  return streamingResponse({
    wait: params?.wait || Promise.resolve(),
    beforeWait: [
      {
        type: "thread",
        thread: {
          id: "thread-1",
          title: "New chat",
          source: "manual",
          pinnedAt: null,
          updatedAt: at,
        },
        at,
      },
      {
        type: "user_message",
        message: {
          id: "user-message-1",
          threadId: "thread-1",
          role: "user",
          content: "Update the builder",
          metadata: null,
          createdAt: at,
        },
        at,
      },
    ],
    afterWait: [
      {
        type: "assistant_message",
        message: {
          id: "assistant-message-1",
          threadId: "thread-1",
          role: "assistant",
          content: "Updated.",
          metadata: params?.metadata ?? null,
          createdAt: at,
        },
        at,
      },
      {
        type: "done",
        thread: {
          id: "thread-1",
          title: "Builder update",
          source: "manual",
          pinnedAt: null,
          updatedAt: at,
        },
        at,
      },
    ],
  });
}

export function jsonResponse(payload: unknown) {
  return {
    ok: true,
    headers: {
      get: () => "application/json",
    },
    json: async () => payload,
  } as unknown as Response;
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(resolvePromise => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

export function whatsappTemplateArtifact(params?: {
  id?: string;
  revision?: number;
  name?: string;
}) {
  return {
    id: params?.id || "artifact-1",
    kind: "whatsapp_template",
    revision: params?.revision ?? 0,
    status: "draft",
    validation: { status: "valid", issues: [] },
    snapshot: {
      templateDraft: {
        kind: "whatsapp_template",
        name: params?.name || "airi_whatsapp_template",
        language: "en",
        category: "MARKETING",
        components: [
          {
            type: "BODY",
            text: "Hi {{1}}, would you like help choosing a plan?",
          },
        ],
      },
    },
  };
}

export function expectAnyBuilderTemplateName(name: string) {
  expect(
    screen
      .getAllByTestId("builder-template-name")
      .some(element => element.textContent === name)
  ).toBe(true);
}

/** The browser APIs jsdom lacks, and fetch, for one workspace test. */
export function installAiriChatWorkspaceTestGlobals(fetchMock: jest.Mock) {
  global.ReadableStream = ReadableStream as typeof global.ReadableStream;
  global.TextDecoder = TextDecoder as unknown as typeof global.TextDecoder;
  global.TextEncoder = TextEncoder as unknown as typeof global.TextEncoder;
  global.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  window.matchMedia = jest.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: jest.fn(),
    removeListener: jest.fn(),
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
    dispatchEvent: jest.fn(),
  }));
  Element.prototype.scrollTo = jest.fn();
  window.localStorage.clear();
  // Chats, messages and a reopened run's chat are cached across mounts.
  resetAiriChatSessionCache();
  global.fetch = fetchMock;
}
