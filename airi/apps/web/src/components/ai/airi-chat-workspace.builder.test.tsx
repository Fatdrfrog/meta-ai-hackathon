/**
 * @jest-environment jsdom
 */

import "@testing-library/jest-dom";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type React from "react";
import { AiriChatWorkspace } from "./airi-chat-workspace";
import {
  completedMessageStream,
  expectAnyBuilderTemplateName,
  installAiriChatWorkspaceTestGlobals,
  jsonResponse,
  whatsappTemplateArtifact,
} from "./airi-chat-workspace-test-utils";

jest.mock("next-intl", () =>
  jest
    .requireActual("./airi-chat-workspace-test-utils")
    .createAiriChatNextIntlMock()
);

jest.mock("@/components/ai/airi-builder-side-panel", () =>
  jest
    .requireActual("./airi-chat-workspace-test-utils")
    .createAiriBuilderSidePanelMock()
);

// use-stick-to-bottom ships ESM only; stand in for its sticky scroller.
jest.mock("@/components/ui/conversation", () => {
  const React = jest.requireActual<typeof import("react")>("react");
  return {
    Conversation: ({ children }: { children: React.ReactNode }) =>
      React.createElement("div", { role: "log" }, children),
    ConversationContent: ({ children }: { children: React.ReactNode }) =>
      React.createElement("div", null, children),
    ConversationScrollButton: () => null,
  };
});

jest.mock("@/components/ai/airi-builder-intl-provider", () => ({
  AiriBuilderIntlProvider: ({ children }: { children: React.ReactNode }) =>
    children,
  AiriPreviewLoadFailure: () => null,
}));

const mockFetch = jest.fn();
const at = new Date("2026-06-12T00:00:00.000Z").toISOString();

// Autosave waits on a 600 ms debounce; fake timers step past it instead of
// waiting in real time, which kept these tests near Jest's 5 s limit.
beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers({ doNotFake: ["nextTick", "queueMicrotask"] });
  installAiriChatWorkspaceTestGlobals(mockFetch);
});

afterEach(() => {
  cleanup();
  jest.useRealTimers();
});

/** Moves the fake clock on, letting the work it releases settle. */
async function advance(ms: number) {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });
}

function conflictResponse(current: unknown) {
  return {
    ok: false,
    status: 409,
    headers: new Headers(),
    json: async () => ({ error: "Revision conflict", current }),
  } as Response;
}

function errorResponse(status: number, error: string) {
  return {
    ok: false,
    status,
    headers: new Headers(),
    json: async () => ({ error }),
  } as Response;
}

function existingThreadsResponse() {
  return jsonResponse({
    threads: [
      {
        id: "thread-1",
        title: "Existing chat",
        source: "manual",
        pinnedAt: null,
        updatedAt: at,
      },
    ],
  });
}

function loadedArtifactsResponse() {
  return jsonResponse({
    artifacts: [
      whatsappTemplateArtifact({
        id: "artifact-1",
        revision: 1,
        name: "loaded_template",
      }),
    ],
  });
}

/** Selects the existing chat and opens its template in the builder. */
async function openExistingChatBuilder() {
  render(<AiriChatWorkspace workspaceId="workspace-1" />);
  fireEvent.click((await screen.findAllByText("Existing chat"))[0]);
  await waitFor(() =>
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/airi-artifacts?"),
      expect.anything()
    )
  );
  fireEvent.click(
    (await screen.findAllByRole("button", { name: "Toggle side panel" }))[0]
  );
  await waitFor(() => expectAnyBuilderTemplateName("loaded_template"));
}

describe("AiriChatWorkspace incoming builder patches", () => {
  function templatePatch(params: {
    name: string;
    summary: string;
    baseRevision: number;
    artifactId?: string;
  }) {
    return {
      kind: "whatsapp_template",
      ...(params.artifactId ? { artifactId: params.artifactId } : {}),
      baseRevision: params.baseRevision,
      nextRevision: params.baseRevision + 1,
      summary: params.summary,
      snapshot: {
        templateDraft: {
          kind: "whatsapp_template",
          name: params.name,
          language: "en",
          category: "MARKETING",
          components: [{ type: "BODY", text: "Patched body" }],
        },
      },
    };
  }

  type SavedBody = {
    baseRevision: number;
    snapshot: { templateDraft: { name: string } };
  };

  let creates: Array<{ threadId: string; kind: string; name: string }> = [];
  let createFails = false;
  // Stands in for the server's answer to a builder save, when a test needs
  // something other than success.
  let saveResponse: ((id: string, body: SavedBody) => Response) | null = null;
  // Every builder write, in order: "PATCH <id> <name>" or "POST <name>".
  let writes: string[] = [];

  function mockOpenArtifactThread(assistantMetadata: Record<string, unknown>) {
    const saves: string[] = [];
    creates = [];
    createFails = false;
    saveResponse = null;
    writes = [];
    mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/airi-artifacts") && init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        creates.push({
          threadId: body.threadId,
          kind: body.kind,
          name: body.snapshot.templateDraft.name,
        });
        writes.push(`POST ${body.snapshot.templateDraft.name}`);
        if (createFails) return errorResponse(500, "Internal error");
        return jsonResponse({
          artifact: whatsappTemplateArtifact({
            id: "artifact-new",
            revision: 1,
            name: body.snapshot.templateDraft.name,
          }),
        });
      }
      if (url.includes("/airi-chats/sources"))
        return jsonResponse({ sources: [] });
      if (url.endsWith("/airi-chats")) return existingThreadsResponse();
      if (url.endsWith("/airi-chats/thread-1/messages"))
        return jsonResponse({ messages: [] });
      if (url.includes("/airi-artifacts?")) return loadedArtifactsResponse();
      if (url.endsWith("/airi-chats/thread-1/messages/stream"))
        return completedMessageStream({ metadata: assistantMetadata });
      const saved = url.match(/\/airi-artifacts\/([^/?]+)$/);
      if (saved && init?.method === "PATCH") {
        saves.push(saved[1]);
        const body = JSON.parse(String(init.body)) as SavedBody;
        writes.push(`PATCH ${saved[1]} ${body.snapshot.templateDraft.name}`);
        if (saveResponse) return saveResponse(saved[1], body);
        return jsonResponse({
          artifact: whatsappTemplateArtifact({
            id: saved[1],
            revision: body.baseRevision + 1,
            name: body.snapshot.templateDraft.name,
          }),
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    return saves;
  }

  async function openBuilderAndSend() {
    await openExistingChatBuilder();
    const input = screen.getAllByRole("combobox", { name: "Ask Airi" })[0];
    fireEvent.change(input, { target: { value: "Plan a campaign" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Send message" })[0]);
    expect((await screen.findAllByText("Updated."))[0]).toBeInTheDocument();
  }

  function applyButton(summary: string) {
    return screen.getAllByRole("button", {
      name: `Apply update: ${summary}`,
    })[0];
  }

  const otherArtifactPatch = {
    airiArtifact: whatsappTemplateArtifact({
      id: "artifact-2",
      revision: 0,
      name: "other_template",
    }),
    airiBuilderPatch: templatePatch({
      name: "other_template",
      summary: "Other template",
      baseRevision: 1,
      artifactId: "artifact-2",
    }),
  };

  const campaignDraftPatch = {
    airiBuilderPatch: templatePatch({
      name: "campaign_template",
      summary: "Campaign template",
      baseRevision: 1,
    }),
  };

  it("offers a campaign's id-less template draft instead of writing it into the open artifact", async () => {
    const saves = mockOpenArtifactThread(campaignDraftPatch);

    await openBuilderAndSend();

    expectAnyBuilderTemplateName("loaded_template");
    expect(applyButton("Campaign template")).toHaveAttribute(
      "data-target",
      "new"
    );
    expect(saves).toEqual([]);
  });

  it("opens an applied id-less draft as a new artifact and never saves it over the open one", async () => {
    const saves = mockOpenArtifactThread(campaignDraftPatch);

    await openBuilderAndSend();
    fireEvent.click(applyButton("Campaign template"));

    await waitFor(() => expectAnyBuilderTemplateName("campaign_template"));
    expect(creates).toEqual([
      {
        threadId: "thread-1",
        kind: "whatsapp_template",
        name: "campaign_template",
      },
    ]);
    fireEvent.click(
      screen.getAllByRole("button", { name: "Edit local template" })[0]
    );

    await waitFor(() => expect(saves).toEqual(["artifact-new"]));
    expect(saves).not.toContain("artifact-1");
  });

  it("keeps the open artifact and says so when an id-less draft cannot be opened", async () => {
    const saves = mockOpenArtifactThread(campaignDraftPatch);

    await openBuilderAndSend();
    createFails = true;
    fireEvent.click(applyButton("Campaign template"));

    expect(
      (await screen.findAllByText("Could not open the draft. Try again."))[0]
    ).toBeInTheDocument();
    expect(creates).toHaveLength(1);
    expectAnyBuilderTemplateName("loaded_template");
    expect(applyButton("Campaign template")).toHaveAttribute(
      "data-target",
      "new"
    );
    fireEvent.click(
      screen.getAllByRole("button", { name: "Edit local template" })[0]
    );
    await waitFor(() => expect(saves).toEqual(["artifact-1"]));
  });

  it("switches to the patch's own artifact when the user applies it", async () => {
    const saves = mockOpenArtifactThread(otherArtifactPatch);

    await openBuilderAndSend();
    expectAnyBuilderTemplateName("loaded_template");
    expect(applyButton("Other template")).toHaveAttribute(
      "data-target",
      "other"
    );

    fireEvent.click(applyButton("Other template"));
    await waitFor(() => expectAnyBuilderTemplateName("other_template"));
    fireEvent.click(
      screen.getAllByRole("button", { name: "Edit local template" })[0]
    );

    await waitFor(() => expect(saves).toEqual(["artifact-2"]));
  });

  it("applies a patch that names the open artifact at once", async () => {
    mockOpenArtifactThread({
      airiBuilderPatch: templatePatch({
        name: "patched_template",
        summary: "Patched template",
        baseRevision: 1,
        artifactId: "artifact-1",
      }),
    });

    await openBuilderAndSend();

    await waitFor(() => expectAnyBuilderTemplateName("patched_template"));
    expect(
      screen.queryByRole("button", { name: "Apply update: Patched template" })
    ).not.toBeInTheDocument();
  });

  it("saves an edit made inside the autosave delay before switching to the patch's artifact", async () => {
    mockOpenArtifactThread(otherArtifactPatch);

    await openBuilderAndSend();
    fireEvent.click(
      screen.getAllByRole("button", { name: "Edit local template" })[0]
    );
    // The autosave delay has not passed: nothing is saved yet.
    expect(writes).toEqual([]);
    fireEvent.click(applyButton("Other template"));

    await waitFor(() => expectAnyBuilderTemplateName("other_template"));
    expect(writes).toEqual(["PATCH artifact-1 local_template"]);
    await advance(2000);
    expect(writes).toEqual(["PATCH artifact-1 local_template"]);
  });

  it("saves the open artifact before opening an id-less draft as a new one", async () => {
    mockOpenArtifactThread(campaignDraftPatch);

    await openBuilderAndSend();
    fireEvent.click(
      screen.getAllByRole("button", { name: "Edit local template" })[0]
    );
    fireEvent.click(applyButton("Campaign template"));

    await waitFor(() => expectAnyBuilderTemplateName("campaign_template"));
    expect(writes).toEqual([
      "PATCH artifact-1 local_template",
      "POST campaign_template",
    ]);
  });

  it("holds the switch while the open artifact is in conflict and makes it once the user decides", async () => {
    const saves = mockOpenArtifactThread(campaignDraftPatch);
    saveResponse = (_id, body) =>
      body.baseRevision === 1
        ? conflictResponse(
            whatsappTemplateArtifact({
              id: "artifact-1",
              revision: 2,
              name: "foreign_template",
            })
          )
        : jsonResponse({
            artifact: whatsappTemplateArtifact({
              id: "artifact-1",
              revision: body.baseRevision + 1,
              name: body.snapshot.templateDraft.name,
            }),
          });

    await openBuilderAndSend();
    fireEvent.click(
      screen.getAllByRole("button", { name: "Edit local template" })[0]
    );
    expect(
      (await screen.findAllByText("Changed elsewhere: revision 2"))[0]
    ).toBeInTheDocument();
    expect(applyButton("Campaign template")).toHaveAttribute(
      "data-blocked",
      "true"
    );

    // Even a click that reaches the workspace does not switch.
    fireEvent.click(applyButton("Campaign template"));
    await advance(1000);
    expect(creates).toEqual([]);
    expect(saves).toEqual(["artifact-1"]);
    expectAnyBuilderTemplateName("local_template");
    expect(
      screen.getAllByText("Changed elsewhere: revision 2")[0]
    ).toBeInTheDocument();

    fireEvent.click(
      screen.getAllByRole("button", { name: "Keep my version" })[0]
    );
    await waitFor(() => expect(saves).toEqual(["artifact-1", "artifact-1"]));
    await waitFor(() =>
      expect(applyButton("Campaign template")).toHaveAttribute(
        "data-blocked",
        "false"
      )
    );

    fireEvent.click(applyButton("Campaign template"));
    await waitFor(() => expectAnyBuilderTemplateName("campaign_template"));
    expect(writes).toEqual([
      "PATCH artifact-1 local_template",
      "PATCH artifact-1 local_template",
      "POST campaign_template",
    ]);
  });

  it("keeps the patch pending and shows the error when the open artifact cannot be saved", async () => {
    mockOpenArtifactThread(otherArtifactPatch);
    saveResponse = () => errorResponse(500, "Could not save the template");

    await openBuilderAndSend();
    fireEvent.click(
      screen.getAllByRole("button", { name: "Edit local template" })[0]
    );
    fireEvent.click(applyButton("Other template"));

    expect(
      (await screen.findAllByText("Could not save the template"))[0]
    ).toBeInTheDocument();
    expectAnyBuilderTemplateName("local_template");
    await waitFor(() =>
      expect(applyButton("Other template")).toHaveAttribute(
        "data-busy",
        "false"
      )
    );
    expect(writes).toEqual(["PATCH artifact-1 local_template"]);
  });
});

describe("AiriChatWorkspace builder autosave conflicts", () => {
  function mockBuilderThread(
    onPatch: (
      body: {
        baseRevision: number;
        snapshot: { templateDraft: { name: string } };
      },
      init: RequestInit
    ) => Response | Promise<Response>
  ) {
    const patches: Array<{
      baseRevision: number;
      snapshot: { templateDraft: { name: string } };
    }> = [];
    mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes("/airi-chats/sources"))
        return jsonResponse({ sources: [] });
      if (url.endsWith("/airi-chats")) return existingThreadsResponse();
      if (url.endsWith("/airi-chats/thread-1/messages"))
        return jsonResponse({ messages: [] });
      if (url.includes("/airi-artifacts?")) return loadedArtifactsResponse();
      if (url.endsWith("/airi-artifacts/artifact-1") && init?.method) {
        const body = JSON.parse(String(init.body));
        patches.push(body);
        return onPatch(body, init);
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    return patches;
  }

  async function openBuilderAndEdit() {
    await openExistingChatBuilder();
    fireEvent.click(
      screen.getAllByRole("button", { name: "Edit local template" })[0]
    );
  }

  it("pauses autosave on a foreign edit and overwrites only when the user keeps their version", async () => {
    const patches = mockBuilderThread(body =>
      body.baseRevision === 1
        ? conflictResponse(
            whatsappTemplateArtifact({
              id: "artifact-1",
              revision: 2,
              name: "foreign_template",
            })
          )
        : jsonResponse({
            artifact: whatsappTemplateArtifact({
              id: "artifact-1",
              revision: body.baseRevision + 1,
              name: body.snapshot.templateDraft.name,
            }),
          })
    );

    await openBuilderAndEdit();

    expect(
      (await screen.findAllByText("Changed elsewhere: revision 2"))[0]
    ).toBeInTheDocument();
    await advance(1000);
    expect(patches).toHaveLength(1);
    expectAnyBuilderTemplateName("local_template");

    fireEvent.click(
      screen.getAllByRole("button", { name: "Keep my version" })[0]
    );

    await waitFor(() => expect(patches).toHaveLength(2));
    expect(patches[1]).toEqual(
      expect.objectContaining({
        baseRevision: 2,
        snapshot: {
          templateDraft: expect.objectContaining({ name: "local_template" }),
        },
      })
    );
    await waitFor(() =>
      expect(
        screen.queryByText("Changed elsewhere: revision 2")
      ).not.toBeInTheDocument()
    );
    await advance(900);
    expect(patches).toHaveLength(2);
  });

  it("loads the newer revision when the user takes the latest version", async () => {
    const patches = mockBuilderThread(() =>
      conflictResponse(
        whatsappTemplateArtifact({
          id: "artifact-1",
          revision: 2,
          name: "foreign_template",
        })
      )
    );

    await openBuilderAndEdit();
    fireEvent.click(
      (await screen.findAllByRole("button", { name: "Use latest version" }))[0]
    );

    await waitFor(() => expectAnyBuilderTemplateName("foreign_template"));
    expect(
      screen.queryByText("Changed elsewhere: revision 2")
    ).not.toBeInTheDocument();
    await advance(900);
    expect(patches).toHaveLength(1);
  });

  it("treats a 409 for this tab's own committed save as a rebase, not a conflict", async () => {
    const patches = mockBuilderThread(body =>
      conflictResponse(
        whatsappTemplateArtifact({
          id: "artifact-1",
          revision: 2,
          name: body.snapshot.templateDraft.name,
        })
      )
    );

    await openBuilderAndEdit();
    await waitFor(() => expect(patches).toHaveLength(1));
    await advance(900);

    expect(
      screen.queryByText("Changed elsewhere: revision 2")
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(patches).toHaveLength(1);
    expectAnyBuilderTemplateName("local_template");
  });

  it("rebases onto an earlier aborted save the server committed and saves the newer edit on top", async () => {
    let serverRevision = 1;
    let serverName = "loaded_template";
    const patches = mockBuilderThread((body, init) => {
      if (body.baseRevision !== serverRevision) {
        return conflictResponse(
          whatsappTemplateArtifact({
            id: "artifact-1",
            revision: serverRevision,
            name: serverName,
          })
        );
      }
      serverRevision += 1;
      serverName = body.snapshot.templateDraft.name;
      const saved = jsonResponse({
        artifact: whatsappTemplateArtifact({
          id: "artifact-1",
          revision: serverRevision,
          name: serverName,
        }),
      });
      if (serverRevision > 2) return saved;
      // The first save commits, but its response never arrives before the
      // next edit aborts the request.
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () =>
          reject(new DOMException("The request was aborted", "AbortError"))
        );
      });
    });

    await openBuilderAndEdit();
    await waitFor(() => expect(patches).toHaveLength(1));
    fireEvent.click(
      screen.getAllByRole("button", { name: "Edit template again" })[0]
    );

    // Two debounced saves follow: the newer edit, then (after the 409
    // rebases onto the committed first save) the same edit on top.
    await advance(1500);
    await waitFor(() => expect(patches).toHaveLength(3));
    expect(patches[1]).toEqual(
      expect.objectContaining({
        baseRevision: 1,
        snapshot: {
          templateDraft: expect.objectContaining({ name: "newer_template" }),
        },
      })
    );
    expect(patches[2]).toEqual(
      expect.objectContaining({
        baseRevision: 2,
        snapshot: {
          templateDraft: expect.objectContaining({ name: "newer_template" }),
        },
      })
    );
    expect(screen.queryByText(/Changed elsewhere/)).not.toBeInTheDocument();
    expect(serverName).toBe("newer_template");
    expectAnyBuilderTemplateName("newer_template");
  });
});
