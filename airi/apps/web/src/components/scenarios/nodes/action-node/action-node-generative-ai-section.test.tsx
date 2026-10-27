/** @jest-environment jsdom */
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { useState } from "react";
import type {
  GenerativeAIActionConfig,
  ScenarioActionAttachment,
} from "@icecore/scenario-contracts";
import { ActionNodeGenerativeAISection } from "./action-node-generative-ai-section";
import type {
  ScenarioFormAnswerChoice,
  ScenarioPickedOptionChoice,
} from "../../view/node-enrichment/scenario-node-graph-index";
import type { ScenarioVariableExtraField } from "../../view/scenario-variable-inserter";
import { installResizeObserver } from "@/test-support/dom-test-utils";

const sourceId = "11111111-1111-4111-8111-111111111111";
let mockIntegrations = {
  sources: [
    {
      id: sourceId,
      type: "google_ai",
      workspace_id: "workspace-1",
      credentials: { has_api_key: true },
    },
  ],
  isLoading: false,
  isError: undefined as unknown,
  mutate: jest.fn(),
};
jest.mock("@/hooks/use-integrations", () => ({
  useIntegrations: () => mockIntegrations,
}));
const imageConfig = () =>
  ({
    version: 1,
    mode: "text_to_image",
    prompt:
      "Keep the medal holder shape. Personalize using the customer message.",
    image: {
      provider: "google",
      sourceId,
      modelId: "gemini-3.1-flash-image",
      aspectRatio: "16:9",
      referenceImages: [],
      includeInboundText: true,
    },
  }) as GenerativeAIActionConfig;
// Values show up in the text so options and counts can be told apart.
const t = (key: string, values?: Record<string, string | number | Date>) =>
  values ? `${key}(${Object.values(values).join(",")})` : key;
function Harness({
  initial = imageConfig(),
  upload = jest.fn(),
  onPatch = jest.fn(),
  pickedOptionSources,
  promptInputFields,
  formAnswerSources,
}: {
  initial?: GenerativeAIActionConfig;
  upload?: (
    file: File,
    options?: { persist?: boolean }
  ) => Promise<ScenarioActionAttachment | undefined>;
  onPatch?: (patch: unknown) => void;
  pickedOptionSources?: ScenarioPickedOptionChoice[];
  promptInputFields?: ScenarioVariableExtraField[];
  formAnswerSources?: ScenarioFormAnswerChoice[];
}) {
  const [config, setConfig] = useState(initial);
  return (
    <>
      <ActionNodeGenerativeAISection
        config={config}
        workspaceId="workspace-1"
        upload={upload}
        t={t}
        pickedOptionSources={pickedOptionSources}
        promptInputFields={promptInputFields}
        formAnswerSources={formAnswerSources}
        patchNode={patch => {
          onPatch(patch);
          setConfig(patch.actionGenerativeAIConfig);
        }}
      />
      <output data-testid="saved">{JSON.stringify(config)}</output>
    </>
  );
}
const saved = () => JSON.parse(screen.getByTestId("saved").textContent || "{}");
const carousel: ScenarioPickedOptionChoice = {
  nodeId: "carousel-1",
  kind: "media_carousel",
  cardImagesUsable: true,
  label: "Pick a frame",
};
const confirm: ScenarioPickedOptionChoice = {
  nodeId: "confirm",
  kind: "reply_buttons",
  cardImagesUsable: false,
  label: "Ready?",
};
const withPick = (
  sourceActionNodeId: string,
  includeCardImage = false,
  extra: Partial<GenerativeAIActionConfig> = {}
): GenerativeAIActionConfig => ({
  ...imageConfig(),
  ...extra,
  pickedOption: { sourceActionNodeId, includeCardImage },
});
const reference = (name: string) =>
  ({
    url: `https://example.test/${name}`,
    mediaType: "image",
    mimeType: "image/jpeg",
    fileSize: 3,
    bucket: "media",
    path: `workspace-1/${name}`,
  }) as ScenarioActionAttachment;
const chooseOption = (combobox: string, option: RegExp | string) => {
  fireEvent.keyDown(screen.getByRole("combobox", { name: combobox }), {
    key: "ArrowDown",
  });
  fireEvent.keyDown(screen.getByRole("option", { name: option }), {
    key: "Enter",
  });
};
const cardImageTile = () =>
  screen.getByTestId("generative-ai-picked-card-slot");
const openVariables = () =>
  fireEvent.click(screen.getByTestId("whatsapp-service-message-variables"));
const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
const originalResizeObserver = globalThis.ResizeObserver;
beforeAll(() => {
  // cmdk measures and scrolls its list; jsdom has neither API.
  HTMLElement.prototype.scrollIntoView = jest.fn();
  installResizeObserver();
});
afterAll(() => {
  HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
  globalThis.ResizeObserver = originalResizeObserver;
});
beforeEach(() => {
  mockIntegrations = {
    sources: [
      {
        id: sourceId,
        type: "google_ai",
        workspace_id: "workspace-1",
        credentials: { has_api_key: true },
      },
    ],
    isLoading: false,
    isError: undefined,
    mutate: jest.fn(),
  };
});

describe("what to create", () => {
  it("lists the supported modes first and groups the rest as coming soon", () => {
    render(<Harness />);
    fireEvent.keyDown(
      screen.getByRole("combobox", { name: "generativeAIModeLabel" }),
      { key: "ArrowDown" }
    );
    const listbox = screen.getByRole("listbox");
    expect(
      within(listbox)
        .getAllByRole("option")
        .map(option => [
          option.getAttribute("data-testid"),
          option.getAttribute("aria-disabled") === "true",
        ])
    ).toEqual([
      ["generative-ai-mode-text_to_image", false],
      ["generative-ai-mode-text_to_video", false],
      ["generative-ai-mode-image_to_video", false],
      ["generative-ai-mode-audio", true],
      ["generative-ai-mode-avatar", true],
      ["generative-ai-mode-text", true],
    ]);
    expect(within(listbox).getAllByText("generativeAIComingSoon")).toHaveLength(
      1
    );
  });

  it.each([
    ["text_to_video", "generativeAIWaitingForText"],
    ["image_to_video", "generativeAIWaitingForImage"],
  ] as const)("says what %s uses and what happens without it", (mode, hint) => {
    render(<Harness initial={{ version: 1, mode, prompt: "Animate" }} />);
    const description = screen.getByText(hint);
    expect(
      screen
        .getByRole("combobox", { name: "generativeAIModeLabel" })
        .getAttribute("aria-describedby")
    ).toBe(description.id);
  });

  it("adds no input line for images", () => {
    render(<Harness />);
    expect(screen.queryByText("generativeAIWaitingForText")).toBeNull();
    expect(screen.queryByText("generativeAIImageInputHint")).toBeNull();
    expect(
      screen
        .getByRole("combobox", { name: "generativeAIModeLabel" })
        .hasAttribute("aria-describedby")
    ).toBe(false);
  });

  it("ends with what the customer receives when creation fails", () => {
    render(<Harness />);
    const editor = screen.getByTestId("generative-ai-editor");
    expect(editor.lastElementChild?.textContent).toBe(
      "generativeAIFailureRouteHint"
    );
  });

  it("drops its own box and separates groups in the settings panel", () => {
    const view = render(
      <ActionNodeGenerativeAISection
        config={imageConfig()}
        workspaceId="workspace-1"
        t={t}
        patchNode={jest.fn()}
      />
    );
    const editor = screen.getByTestId("generative-ai-editor");
    expect(editor.className).toContain("border");
    expect(editor.querySelectorAll('[data-slot="separator"]')).toHaveLength(0);

    view.rerender(
      <ActionNodeGenerativeAISection
        config={imageConfig()}
        workspaceId="workspace-1"
        t={t}
        patchNode={jest.fn()}
        layout="panel"
      />
    );
    expect(editor.className).not.toContain("border");
    expect(editor.querySelectorAll('[data-slot="separator"]')).toHaveLength(2);
  });
});

describe("instructions", () => {
  it("edits image instructions without losing provider, model, shape or references", () => {
    render(<Harness />);
    fireEvent.change(screen.getByLabelText("generativeAIPromptLabel"), {
      target: { value: "Use {{customer_name}} exactly" },
    });
    expect(saved()).toMatchObject({
      prompt: "Use {{customer_name}} exactly",
      image: imageConfig().image,
    });
    fireEvent.click(
      screen.getByRole("checkbox", { name: "generativeAIIncludeInboundText" })
    );
    expect(saved().image.includeInboundText).toBe(false);
  });

  it("puts the last-message checkbox right after the instructions", () => {
    render(<Harness />);
    const prompt = screen.getByLabelText("generativeAIPromptLabel");
    const inbound = screen.getByRole("checkbox", {
      name: "generativeAIIncludeInboundText",
    });
    const references = screen.getByTestId("generative-ai-reference-images");
    expect(
      prompt.compareDocumentPosition(inbound) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(
      inbound.compareDocumentPosition(references) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(screen.queryByText("generativeAIInboundTextHint")).toBeNull();
  });

  it("uses an example placeholder for each mode", () => {
    const view = render(<Harness />);
    const placeholder = () =>
      screen
        .getByLabelText("generativeAIPromptLabel")
        .getAttribute("placeholder");
    expect(placeholder()).toBe("generativeAIImagePromptPlaceholder");
    view.unmount();
    render(
      <Harness initial={{ version: 1, mode: "image_to_video", prompt: "" }} />
    );
    expect(placeholder()).toBe("generativeAIPromptPhotoPlaceholder");
  });

  it("limits typed image instructions and explains the final-text limit behind an info button", () => {
    render(<Harness />);
    const prompt = screen.getByLabelText("generativeAIPromptLabel");
    expect(prompt.getAttribute("maxlength")).toBe("16000");
    expect(
      screen.getByRole("button", {
        name: "infoHintLabel(generativeAIPromptLabel)",
      })
    ).toBeTruthy();
    const limit = screen.getByText("generativeAIPromptLimitInfo(16000)");
    expect(prompt.getAttribute("aria-describedby")).toContain(limit.id);
    expect(screen.queryByTestId("generative-ai-prompt-counter")).toBeNull();
    expect(screen.queryByText(/generativeAIImagePromptLimitHint/)).toBeNull();
  });

  it("counts characters once the instructions near the image limit", () => {
    const config = imageConfig();
    config.prompt = "a".repeat(14401);
    render(<Harness initial={config} />);
    const counter = screen.getByTestId("generative-ai-prompt-counter");
    expect(counter.textContent).toBe("generativeAIPromptCounter(14401,16000)");
    expect(
      screen
        .getByLabelText("generativeAIPromptLabel")
        .getAttribute("aria-describedby")
    ).toContain(counter.id);
  });

  it("keeps imported overlong image drafts editable and shows an accessible error", () => {
    const config = imageConfig();
    config.prompt = "a".repeat(16001);
    const patchNode = jest.fn();
    render(
      <ActionNodeGenerativeAISection
        config={config}
        workspaceId="workspace-1"
        t={t}
        patchNode={patchNode}
        validationMode="draft"
      />
    );
    const prompt = screen.getByLabelText(
      "generativeAIPromptLabel"
    ) as HTMLTextAreaElement;
    expect(prompt.value).toBe(config.prompt);
    expect(prompt.getAttribute("aria-invalid")).toBe("true");
    const error = screen.getByRole("alert");
    expect(error.textContent).toBe("generativeAIImagePromptTooLong(16000)");
    expect(prompt.getAttribute("aria-describedby")).toContain(error.id);
    expect(patchNode).not.toHaveBeenCalled();
  });

  it("preserves complete inserted variables and flags instructions exceeding the image limit", () => {
    const config = imageConfig();
    config.prompt = "a".repeat(15999);
    render(<Harness initial={config} />);
    openVariables();
    fireEvent.click(screen.getByTestId("service-message-variable-first_name"));
    expect(saved().prompt).toBe(`${config.prompt} {{first_name}}`);
    expect(screen.getByRole("alert").textContent).toBe(
      "generativeAIImagePromptTooLong(16000)"
    );
    fireEvent.change(screen.getByLabelText("generativeAIPromptLabel"), {
      target: { value: "Use {{first_name}}" },
    });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("preserves the existing video prompt behavior without the image limit", () => {
    render(
      <Harness
        initial={{
          version: 1,
          mode: "text_to_video",
          prompt: "a".repeat(16001),
        }}
      />
    );
    expect(
      screen.getByLabelText("generativeAIPromptLabel").hasAttribute("maxlength")
    ).toBe(false);
    expect(
      screen.queryByRole("button", {
        name: "infoHintLabel(generativeAIPromptLabel)",
      })
    ).toBeNull();
    expect(screen.queryByTestId("generative-ai-prompt-counter")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("requires instructions before the step can run", () => {
    render(
      <ActionNodeGenerativeAISection
        config={{ version: 1, mode: "text_to_video", prompt: " " }}
        t={t}
        patchNode={jest.fn()}
      />
    );
    const error = screen.getByRole("alert");
    expect(error.textContent).toBe("generativeAIPromptRequired");
    expect(
      screen
        .getByLabelText("generativeAIPromptLabel")
        .getAttribute("aria-describedby")
    ).toBe(error.id);
  });

  it("flags prompt variables the runtime renders empty, such as a wrong case (B4)", () => {
    render(<Harness />);
    const prompt = screen.getByLabelText("generativeAIPromptLabel");
    fireEvent.change(prompt, {
      target: { value: "Medal for {{input.name}}, {{customer.firstName}}" },
    });
    expect(screen.queryByText(/^variablesUnsupported/)).toBeNull();
    fireEvent.change(prompt, {
      target: { value: "Medal for {{input.Name}}, {{customer.firstname}}" },
    });
    expect(
      screen.getByText("variablesUnsupported(input.Name, customer.firstname)")
    ).toBeTruthy();
  });
});

const elevenLabsSourceId = "33333333-3333-4333-8333-333333333333";
const connectElevenLabs = () =>
  mockIntegrations.sources.push({
    id: elevenLabsSourceId,
    type: "elevenlabs",
    workspace_id: "workspace-1",
    credentials: { has_api_key: true },
  });

describe("image source", () => {
  it("shows a connected source as one line with the billing note", () => {
    render(<Harness />);
    const source = screen.getByTestId("generative-ai-image-source");
    expect(
      within(source).getByText(
        "generativeAIProviderConnected(generativeAIProviderGoogle)"
      )
    ).toBeTruthy();
    expect(
      within(source).getByText("generativeAIImageBillingHint")
    ).toBeTruthy();
    expect(within(source).queryByRole("button")).toBeNull();
    expect(within(source).queryByRole("combobox")).toBeNull();
  });

  it("pins a connected workspace source only when the image config has no source", async () => {
    const config = imageConfig();
    config.image!.sourceId = "";
    render(<Harness initial={config} />);
    await waitFor(() => expect(saved().image.sourceId).toBe(sourceId));
  });

  it("requires explicit selection when the saved source was replaced", () => {
    const config = imageConfig();
    config.image!.sourceId = "22222222-2222-4222-8222-222222222222";
    render(<Harness initial={config} />);
    expect(saved().image.sourceId).toBe(config.image!.sourceId);
    expect(
      screen.getByText("generativeAISourceChanged(generativeAIProviderGoogle)")
    ).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "generativeAIUseConnectedSource" })
    );
    expect(saved().image.sourceId).toBe(sourceId);
  });

  it("links to both integrations in a new tab and preserves a missing pinned source", () => {
    mockIntegrations.sources = [];
    render(<Harness />);
    expect(screen.getByText("generativeAISourceRequired")).toBeTruthy();
    const google = screen.getByRole("link", {
      name: "generativeAIConnectProvider(generativeAIProviderGoogle)",
    });
    expect(google.getAttribute("href")).toBe(
      "/panel/w/workspace-1/settings/integrations?integration=google_ai"
    );
    expect(google.getAttribute("target")).toBe("_blank");
    expect(google.getAttribute("rel")).toContain("noopener");
    expect(
      screen
        .getByRole("link", {
          name: "generativeAIConnectProvider(generativeAIProviderElevenLabs)",
        })
        .getAttribute("href")
    ).toBe("/panel/w/workspace-1/settings/integrations?integration=elevenlabs");
    expect(saved().image.sourceId).toBe(sourceId);
  });

  it("does not pin a source from another workspace", () => {
    mockIntegrations.sources[0].workspace_id = "other-workspace";
    const config = imageConfig();
    config.image!.sourceId = "";
    render(<Harness initial={config} />);
    expect(saved().image.sourceId).toBe("");
    expect(
      screen.getByRole("link", {
        name: "generativeAIConnectProvider(generativeAIProviderGoogle)",
      })
    ).toBeTruthy();
  });

  it("switches to ElevenLabs when both are connected, keeping a model it runs", () => {
    connectElevenLabs();
    render(<Harness />);
    chooseOption("generativeAIImageSource", "generativeAIProviderElevenLabs");
    expect(saved().image).toMatchObject({
      provider: "elevenlabs",
      sourceId: elevenLabsSourceId,
      modelId: "gemini-3.1-flash-image",
    });
    expect(
      screen.getByText(
        "generativeAIProviderConnected(generativeAIProviderElevenLabs)"
      )
    ).toBeTruthy();
    expect(
      screen.getByText("generativeAIImageBillingHintElevenLabs")
    ).toBeTruthy();
    // ElevenLabs' own models are offered, not Google's.
    fireEvent.click(
      screen.getByRole("button", { name: "generativeAIMoreSettings" })
    );
    chooseOption("generativeAIImageModel", "GPT Image 2.5 Flare");
    expect(saved().image.modelId).toBe("gpt-image-2.5-flare");
  });

  it("resets a model the new provider does not run", () => {
    connectElevenLabs();
    const config = imageConfig();
    config.image!.modelId = "gemini-2.5-flash-image";
    render(<Harness initial={config} />);
    chooseOption("generativeAIImageSource", "generativeAIProviderElevenLabs");
    expect(saved().image.modelId).toBe("gemini-3.1-flash-image");
  });

  it("takes the only connected ElevenLabs source for a step without one", async () => {
    mockIntegrations.sources = [];
    connectElevenLabs();
    const config = imageConfig();
    config.image!.sourceId = "";
    render(<Harness initial={config} />);
    await waitFor(() =>
      expect(saved().image).toMatchObject({
        provider: "elevenlabs",
        sourceId: elevenLabsSourceId,
      })
    );
  });

  it("offers the other connected service when the step's one is disconnected", () => {
    const config = imageConfig();
    config.image = {
      ...config.image!,
      provider: "elevenlabs",
      sourceId: elevenLabsSourceId,
      modelId: "gpt-image-2.5-flare",
    };
    render(<Harness initial={config} />);
    expect(
      screen.getByText(
        "generativeAIProviderRequired(generativeAIProviderElevenLabs)"
      )
    ).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", {
        name: "generativeAIUseProvider(generativeAIProviderGoogle)",
      })
    );
    expect(saved().image).toMatchObject({
      provider: "google",
      sourceId,
      modelId: "gemini-3.1-flash-image",
    });
  });

  it("shows loading and retryable status errors separately from disconnected", () => {
    mockIntegrations.isLoading = true;
    const view = render(<Harness />);
    expect(
      within(screen.getByTestId("generative-ai-image-source")).getByRole(
        "status"
      ).textContent
    ).toBe("generativeAISourceLoading");
    mockIntegrations.isLoading = false;
    mockIntegrations.isError = new Error("Offline");
    view.rerender(<Harness />);
    expect(screen.getByText("generativeAISourceUnavailable")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "generativeAISourceRetry" })
    );
    expect(mockIntegrations.mutate).toHaveBeenCalled();
  });
});

describe("image format", () => {
  it("offers named common shapes first and keeps the model under More settings", () => {
    render(<Harness />);
    const shape = screen.getByRole("combobox", {
      name: "generativeAIImageAspectRatio",
    });
    expect(shape.textContent).toBe("16:9 generativeAIShapeWide");
    expect(
      screen.queryByRole("combobox", { name: "generativeAIImageModel" })
    ).toBeNull();
    expect(screen.queryByText("generativeAIImageModelHint")).toBeNull();

    fireEvent.keyDown(shape, { key: "ArrowDown" });
    expect(
      screen
        .getAllByRole("option")
        .slice(0, 5)
        .map(option => option.textContent)
    ).toEqual([
      "1:1 generativeAIShapeSquare",
      "4:5 generativeAIShapePortrait",
      "9:16 generativeAIShapeVertical",
      "16:9 generativeAIShapeWide",
      "4:3",
    ]);
  });

  it("lets the merchant choose an image model and shape using the keyboard", () => {
    render(<Harness />);
    fireEvent.click(
      screen.getByRole("button", { name: "generativeAIMoreSettings" })
    );
    fireEvent.keyDown(
      screen.getByRole("combobox", { name: "generativeAIImageModel" }),
      { key: "ArrowDown" }
    );
    fireEvent.keyDown(
      screen.getByRole("option", { name: "Gemini 3 Pro Image" }),
      { key: "Enter" }
    );
    expect(saved().image.modelId).toBe("gemini-3-pro-image");
    chooseOption("generativeAIImageAspectRatio", "21:9");
    expect(saved().image.aspectRatio).toBe("21:9");
  });
});

describe("reference images", () => {
  it("uploads dropped references through the existing non-persisting media callback and removes one", async () => {
    const upload = jest.fn(async (file: File) => ({
      url: `https://example.test/${file.name}`,
      mediaType: "image" as const,
      mimeType: file.type,
      fileName: file.name,
      fileSize: file.size,
      bucket: "media",
      path: `workspace-1/${file.name}`,
    }));
    render(<Harness upload={upload} />);
    const file = new File(["jpg"], "medal.jpg", { type: "image/jpeg" });
    fireEvent.drop(screen.getByTestId("generative-ai-reference-dropzone"), {
      dataTransfer: { files: [file] },
    });
    await waitFor(() => expect(saved().image.referenceImages).toHaveLength(1));
    expect(upload).toHaveBeenCalledWith(file, { persist: false });
    expect(
      screen.getByRole("img", { name: "generativeAIReferencePreview(1)" })
    ).toBeTruthy();
    expect(screen.queryByText("medal.jpg")).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "generativeAIRemoveReference(1)" })
    );
    expect(saved().image.referenceImages).toEqual([]);
  });

  it("holds the place of a reference image whose display URL has not arrived", () => {
    const config = imageConfig();
    const { container } = render(
      <Harness
        initial={{
          ...config,
          image: {
            ...config.image!,
            referenceImages: [
              {
                url: "gcs://bucket/workspace/medal.png",
                bucket: "bucket",
                path: "workspace/medal.png",
                mediaType: "image",
                fileName: "medal.png",
              },
            ],
          },
        }}
      />
    );

    expect(
      screen.getByRole("img", { name: "generativeAIReferencePreview(1)" })
    ).toBeTruthy();
    expect(container.querySelector("img[src^='gcs:']")).toBeNull();
  });

  it("opens the file picker from the add tile", () => {
    render(<Harness />);
    const input = screen
      .getByTestId("generative-ai-reference-images")
      .querySelector<HTMLInputElement>('input[type="file"]');
    const click = jest.spyOn(input!, "click");
    fireEvent.click(screen.getByTestId("generative-ai-reference-add"));
    expect(click).toHaveBeenCalled();
    expect(screen.getByText("generativeAIReferenceUpload")).toBeTruthy();
  });

  it("rejects unsupported and oversized reference files before uploading", async () => {
    const upload = jest.fn();
    render(<Harness upload={upload} />);
    fireEvent.drop(screen.getByTestId("generative-ai-reference-dropzone"), {
      dataTransfer: {
        files: [new File(["pdf"], "document.pdf", { type: "application/pdf" })],
      },
    });
    expect(screen.getByRole("alert").textContent).toContain(
      "generativeAIReferenceInvalid"
    );
    const large = new File(["jpg"], "large.jpg", { type: "image/jpeg" });
    Object.defineProperty(large, "size", { value: 5 * 1024 * 1024 + 1 });
    fireEvent.drop(screen.getByTestId("generative-ai-reference-dropzone"), {
      dataTransfer: { files: [large] },
    });
    expect(screen.getByRole("alert").textContent).toContain(
      "generativeAIReferenceTooLarge"
    );
    expect(upload).not.toHaveBeenCalled();
  });

  it("caps references at three, says so, and hides the add tile", async () => {
    const upload = jest.fn(async (file: File) => ({
      url: `https://example.test/${file.name}`,
      mediaType: "image" as const,
      mimeType: file.type,
      fileSize: file.size,
      bucket: "media",
      path: `workspace-1/${file.name}`,
    }));
    render(<Harness upload={upload} />);
    fireEvent.drop(screen.getByTestId("generative-ai-reference-dropzone"), {
      dataTransfer: {
        files: Array.from(
          { length: 4 },
          (_, i) => new File(["jpg"], `${i}.jpg`, { type: "image/jpeg" })
        ),
      },
    });
    await waitFor(() => expect(saved().image.referenceImages).toHaveLength(3));
    expect(upload).toHaveBeenCalledTimes(3);
    expect(screen.getByRole("alert").textContent).toBe(
      "generativeAIReferenceLimit(3)"
    );
    expect(screen.queryByTestId("generative-ai-reference-add")).toBeNull();
    expect(screen.getByText("3/3")).toBeTruthy();
  });

  it("rejects a combined reference payload above 12 MB before uploading", () => {
    const upload = jest.fn();
    render(<Harness upload={upload} />);
    const files = Array.from({ length: 3 }, (_, index) => {
      const file = new File(["jpg"], `${index}.jpg`, { type: "image/jpeg" });
      Object.defineProperty(file, "size", { value: 5 * 1024 * 1024 });
      return file;
    });
    fireEvent.drop(screen.getByTestId("generative-ai-reference-dropzone"), {
      dataTransfer: { files },
    });
    expect(screen.getByRole("alert").textContent).toContain(
      "generativeAIReferenceTotalTooLarge"
    );
    expect(upload).not.toHaveBeenCalled();
  });

  it("keeps instructions edited while a reference upload is in flight", async () => {
    let finish!: (value: ScenarioActionAttachment) => void;
    const upload = jest.fn(
      () =>
        new Promise<ScenarioActionAttachment>(resolve => {
          finish = resolve;
        })
    );
    render(<Harness upload={upload} />);
    fireEvent.drop(screen.getByTestId("generative-ai-reference-dropzone"), {
      dataTransfer: {
        files: [new File(["jpg"], "medal.jpg", { type: "image/jpeg" })],
      },
    });
    fireEvent.change(screen.getByLabelText("generativeAIPromptLabel"), {
      target: { value: "Updated instructions during upload" },
    });
    await act(async () =>
      finish({
        url: "https://example.test/medal.jpg",
        mediaType: "image",
        mimeType: "image/jpeg",
        fileSize: 3,
        bucket: "media",
        path: "workspace-1/medal.jpg",
      })
    );
    expect(saved().prompt).toBe("Updated instructions during upload");
    expect(saved().image.referenceImages).toHaveLength(1);
  });

  it("does not restore late upload results after switching away from image mode", async () => {
    let finish!: (value: ScenarioActionAttachment) => void;
    const upload = jest.fn(
      () =>
        new Promise<ScenarioActionAttachment>(resolve => {
          finish = resolve;
        })
    );
    const patchNode = jest.fn();
    const view = render(
      <ActionNodeGenerativeAISection
        config={imageConfig()}
        workspaceId="workspace-1"
        upload={upload}
        t={t}
        patchNode={patchNode}
      />
    );
    fireEvent.drop(screen.getByTestId("generative-ai-reference-dropzone"), {
      dataTransfer: {
        files: [new File(["jpg"], "medal.jpg", { type: "image/jpeg" })],
      },
    });
    expect(screen.getByText("generativeAIReferenceUploading")).toBeTruthy();
    view.rerender(
      <ActionNodeGenerativeAISection
        config={{ version: 1, mode: "text_to_video", prompt: "Video" }}
        workspaceId="workspace-1"
        upload={upload}
        t={t}
        patchNode={patchNode}
      />
    );
    await act(async () =>
      finish({
        url: "https://example.test/late.jpg",
        mediaType: "image",
        mimeType: "image/jpeg",
      })
    );
    expect(patchNode).not.toHaveBeenCalled();
  });

  it("discards a pending upload when the editor switches to a different scenario", async () => {
    let finish!: (value: ScenarioActionAttachment) => void;
    const upload = jest.fn(
      () =>
        new Promise<ScenarioActionAttachment>(resolve => {
          finish = resolve;
        })
    );
    const patchNode = jest.fn();
    const view = render(
      <ActionNodeGenerativeAISection
        key="scenario-a:node-1"
        config={imageConfig()}
        workspaceId="workspace-1"
        upload={upload}
        t={t}
        patchNode={patchNode}
      />
    );
    fireEvent.drop(screen.getByTestId("generative-ai-reference-dropzone"), {
      dataTransfer: {
        files: [new File(["jpg"], "medal.jpg", { type: "image/jpeg" })],
      },
    });
    view.rerender(
      <ActionNodeGenerativeAISection
        key="scenario-b:node-1"
        config={imageConfig()}
        workspaceId="workspace-1"
        upload={upload}
        t={t}
        patchNode={patchNode}
      />
    );
    await act(async () =>
      finish({
        url: "https://example.test/late.jpg",
        mediaType: "image",
        mimeType: "image/jpeg",
        fileSize: 3,
        bucket: "media",
        path: "workspace-1/late.jpg",
      })
    );
    expect(patchNode).not.toHaveBeenCalled();
  });
});

describe("the customer's choice", () => {
  it("toggles a carousel pick's card image from its reference tile", () => {
    render(<Harness pickedOptionSources={[carousel, confirm]} />);
    chooseOption("generativeAIPickedOptionLabel", /Pick a frame/);

    expect(saved().pickedOption).toEqual({
      sourceActionNodeId: "carousel-1",
      includeCardImage: true,
    });
    expect(cardImageTile().getAttribute("aria-pressed")).toBe("true");
    expect(cardImageTile().textContent).toBe("generativeAIPickedCardImage");
    expect(screen.getByText("1/3")).toBeTruthy();
    expect(
      screen.queryByRole("checkbox", { name: /PickedCardImage/ })
    ).toBeNull();

    fireEvent.click(cardImageTile());
    expect(saved().pickedOption.includeCardImage).toBe(false);
    expect(cardImageTile().getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByText("0/3")).toBeTruthy();
  });

  it("keeps the card image off when a card cannot be a reference", () => {
    render(
      <Harness
        initial={withPick("carousel-1")}
        pickedOptionSources={[{ ...carousel, cardImagesUsable: false }]}
      />
    );
    const reason = screen.getByText("generativeAIPickedCardImageUnavailable");
    expect(cardImageTile().hasAttribute("disabled")).toBe(true);
    expect(cardImageTile().getAttribute("aria-describedby")).toBe(reason.id);
  });

  it("lets a saved card image the cards cannot provide be turned off", () => {
    render(
      <Harness
        initial={withPick("carousel-1", true)}
        pickedOptionSources={[{ ...carousel, cardImagesUsable: false }]}
      />
    );
    expect(
      screen.getByText("generativeAIPickedCardImageUnavailable").className
    ).toContain("text-destructive");
    fireEvent.click(cardImageTile());
    expect(saved().pickedOption.includeCardImage).toBe(false);
  });

  it("says why the card image cannot join a full reference grid", () => {
    const config = withPick("carousel-1");
    config.image!.referenceImages = ["a.jpg", "b.jpg", "c.jpg"].map(reference);
    render(<Harness initial={config} pickedOptionSources={[carousel]} />);
    const reason = screen.getByText("generativeAIPickedCardImageNoSlot(3)");
    expect(cardImageTile().hasAttribute("disabled")).toBe(true);
    expect(cardImageTile().getAttribute("aria-describedby")).toBe(reason.id);
  });

  it("uses a buttons pick as text only", () => {
    render(<Harness pickedOptionSources={[carousel, confirm]} />);
    chooseOption("generativeAIPickedOptionLabel", /Ready\?/);

    expect(saved().pickedOption).toEqual({
      sourceActionNodeId: "confirm",
      includeCardImage: false,
    });
    expect(screen.queryByTestId("generative-ai-picked-card-slot")).toBeNull();
  });

  it("names an unnamed message by its kind only once", () => {
    render(
      <Harness pickedOptionSources={[{ ...carousel, label: "" }, confirm]} />
    );
    fireEvent.keyDown(
      screen.getByRole("combobox", { name: "generativeAIPickedOptionLabel" }),
      { key: "ArrowDown" }
    );
    expect(
      screen.getAllByRole("option").map(option => option.textContent)
    ).toEqual([
      "generativeAIPickedOptionNone",
      "generativeAIPickedOptionKindCarousel",
      "Ready?generativeAIPickedOptionKindButtons",
    ]);
  });

  it("flags a message that no longer comes before this step and clears it", () => {
    render(
      <Harness initial={withPick("gone")} pickedOptionSources={[carousel]} />
    );
    const error = screen.getByText("generativeAIPickedOptionMissing");
    const trigger = screen.getByRole("combobox", {
      name: "generativeAIPickedOptionLabel",
    });
    expect(trigger.getAttribute("aria-invalid")).toBe("true");
    expect(trigger.getAttribute("aria-describedby")).toBe(error.id);
    chooseOption(
      "generativeAIPickedOptionLabel",
      "generativeAIPickedOptionNone"
    );
    expect(saved().pickedOption).toBeUndefined();
    expect(screen.queryByText("generativeAIPickedOptionMissing")).toBeNull();
  });

  it("stays hidden until a choice message comes before the step", () => {
    render(<Harness />);
    expect(screen.queryByTestId("generative-ai-picked-option")).toBeNull();
    expect(screen.queryByText(/generativeAIPickedOptionEmpty/)).toBeNull();
  });
});

describe("one-click additions", () => {
  const answers: ScenarioVariableExtraField[] = [
    { token: "input.name", label: "Name", description: "What is your name?" },
    { token: "input.sport", label: "Sport", description: "Which sport?" },
  ];
  const token = (name: string) =>
    screen.getByTestId(`generative-ai-data-flow-token-${name}`);
  const configWith = (
    next: Partial<GenerativeAIActionConfig>
  ): GenerativeAIActionConfig => ({ ...imageConfig(), ...next });

  it("adds the customer's pick in one click and stops warning that it is unused", () => {
    render(
      <Harness
        initial={withPick("carousel-1", false, { prompt: "A medal holder" })}
        pickedOptionSources={[carousel]}
      />
    );
    expect(screen.getByText("generativeAIUsesPickUnused")).toBeTruthy();
    expect(screen.queryByText(/generativeAIUses(Label|Nothing)/)).toBeNull();
    expect(token("picked.text").getAttribute("data-in-prompt")).toBe("false");
    expect(token("picked.text").getAttribute("aria-label")).toBe(
      "generativeAIAddTokenAria(Picked Card Text)"
    );
    expect(token("picked.text").hasAttribute("title")).toBe(false);

    fireEvent.click(token("picked.text"));

    expect(saved().prompt).toBe("A medal holder {{picked.text}}");
    expect(token("picked.text").getAttribute("data-in-prompt")).toBe("true");
    expect(token("picked.text").getAttribute("aria-label")).toBe(
      "generativeAITokenAddedAria(Picked Card Text)"
    );
    expect(screen.queryByText("generativeAIUsesPickUnused")).toBeNull();
  });

  it("offers the collected answers and marks the ones in the instructions", () => {
    render(
      <Harness
        initial={configWith({ prompt: "Medal for {{input.name}}" })}
        promptInputFields={answers}
      />
    );
    const group = screen.getByRole("group", {
      name: "generativeAIUsesAddToken",
    });
    expect(within(group).getAllByRole("button")).toHaveLength(2);
    expect(token("input.name").getAttribute("data-in-prompt")).toBe("true");

    fireEvent.click(token("input.sport"));

    expect(saved().prompt).toBe("Medal for {{input.name}} {{input.sport}}");
    expect(token("input.sport").getAttribute("data-in-prompt")).toBe("true");
  });

  it("adds an earlier form's answer in one click and offers every form in Variables", () => {
    const order: ScenarioFormAnswerChoice = {
      nodeId: "order",
      formKey: "order",
      formLabel: "Order",
      label: "Order details",
      availability: "some_paths",
      schema: "known",
      fields: [
        {
          key: "size",
          responseKey: "size",
          label: "Size",
          description: "Pick a size",
          fieldType: "Dropdown",
          required: true,
          screenIndex: 0,
          options: [],
          mayBeEmpty: true,
        },
      ],
    };
    const linked: ScenarioFormAnswerChoice = {
      ...order,
      nodeId: "linked",
      formKey: "survey",
      label: "Survey",
      schema: "unknown",
      fields: [],
    };
    render(
      <Harness
        initial={configWith({ prompt: "A medal" })}
        promptInputFields={answers}
        formAnswerSources={[order, linked]}
      />
    );
    expect(token("form.order.size").textContent).toBe("Size · Order details");
    // The customer can skip the form, so the chip says it may be empty.
    expect(token("form.order.size").getAttribute("data-may-be-empty")).toBe(
      "true"
    );
    expect(token("form.order.size").getAttribute("aria-label")).toBe(
      "generativeAIAddTokenAria(generativeAITokenMayBeEmpty(Size · Order details))"
    );
    expect(screen.queryByTestId("form-answers-may-be-empty")).toBeNull();

    fireEvent.click(token("form.order.size"));

    expect(saved().prompt).toBe("A medal {{form.order.size}}");
    expect(token("form.order.size").getAttribute("data-in-prompt")).toBe(
      "true"
    );
    // The customer can skip the form, so the step can follow Not created.
    expect(
      screen.getByTestId("form-answers-may-be-empty").textContent
    ).toContain("formAnswersMaySkipForm");

    fireEvent.click(screen.getByTestId("whatsapp-service-message-variables"));
    const menu = screen.getByTestId("service-message-variables-menu");
    expect(within(menu).getAllByText(/^variableGroupForm/)).toHaveLength(2);
    expect(
      screen.getByTestId("service-message-variable-form.order.size")
    ).toBeTruthy();
    // Collected details stay one-click chips only.
    expect(
      screen.queryByTestId("service-message-variable-input.name")
    ).toBeNull();
    expect(
      screen
        .getByTestId("service-message-variable-form.survey")
        .getAttribute("data-note")
    ).toBe("true");
  });

  it("warns about a form answer no earlier form has", () => {
    render(
      <Harness initial={configWith({ prompt: "A {{form.gone.size}}" })} />
    );
    expect(
      screen.getByTestId("form-answers-unavailable").textContent
    ).toContain("formAnswersUnavailableNotice(1,{{form.gone.size}})");
  });

  it("counts the card image as using the pick", () => {
    render(
      <Harness
        initial={withPick("carousel-1", true, { prompt: "A frame" })}
        pickedOptionSources={[carousel]}
      />
    );
    expect(screen.queryByText("generativeAIUsesPickUnused")).toBeNull();
  });

  it("warns when the only use is a card image the cards cannot provide", () => {
    render(
      <Harness
        initial={withPick("carousel-1", true, { prompt: "A medal holder" })}
        pickedOptionSources={[{ ...carousel, cardImagesUsable: false }]}
      />
    );
    expect(screen.getByText("generativeAIUsesPickUnused")).toBeTruthy();
  });

  it("offers only the tapped option for a buttons message", () => {
    render(
      <Harness
        initial={withPick("confirm", false, { prompt: "Medal" })}
        pickedOptionSources={[confirm]}
      />
    );
    expect(
      screen.queryByTestId("generative-ai-data-flow-token-picked.text")
    ).toBeNull();
    expect(screen.getByText("generativeAIUsesChoiceUnused")).toBeTruthy();

    fireEvent.click(token("picked.label"));

    expect(screen.queryByText("generativeAIUsesChoiceUnused")).toBeNull();
  });

  it("shows only the Variables menu without a pick or collected answers", () => {
    render(<Harness initial={configWith({ prompt: "A gold medal" })} />);
    expect(
      screen.queryByRole("group", { name: "generativeAIUsesAddToken" })
    ).toBeNull();
    expect(
      screen.getByTestId("whatsapp-service-message-variables")
    ).toBeTruthy();
  });

  it("keeps the chips' tokens and the reply window out of the Variables menu", () => {
    render(
      <Harness
        initial={withPick("carousel-1", false, { prompt: "A frame" })}
        pickedOptionSources={[carousel]}
        promptInputFields={answers}
      />
    );
    openVariables();
    expect(
      screen.getByTestId("service-message-variable-first_name")
    ).toBeTruthy();
    for (const hidden of ["picked.label", "countdown", "input.name"]) {
      expect(
        screen.queryByTestId(`service-message-variable-${hidden}`)
      ).toBeNull();
    }
  });
});

describe("protection", () => {
  const openProtection = () =>
    fireEvent.click(
      screen.getByRole("button", { name: "generativeAISafetyTitle" })
    );
  const limit = () =>
    screen.getByRole("combobox", { name: "generativeAIDailyLimit" });

  it("stays closed and summarizes the check and the daily limit", () => {
    render(<Harness />);
    expect(screen.getByText("generativeAISafetySummary(on,3)")).toBeTruthy();
    expect(
      screen.queryByRole("checkbox", { name: "generativeAIScreenCustomerText" })
    ).toBeNull();
  });

  it("checks the customer's words and allows three a day by default", () => {
    render(<Harness />);
    openProtection();
    expect(
      screen
        .getByRole("checkbox", { name: "generativeAIScreenCustomerText" })
        .getAttribute("aria-checked")
    ).toBe("true");
    expect(limit().textContent).toBe("generativeAIDailyLimitOption(3)");
    expect(
      screen.getByRole("button", {
        name: "infoHintLabel(generativeAIScreenCustomerText)",
      })
    ).toBeTruthy();
    const limitHint = screen.getByText("generativeAIDailyLimitHint");
    expect(limit().getAttribute("aria-describedby")).toBe(limitHint.id);
  });

  it("saves both settings together as they change", () => {
    render(<Harness />);
    openProtection();
    fireEvent.click(
      screen.getByRole("checkbox", { name: "generativeAIScreenCustomerText" })
    );
    expect(saved().safety).toEqual({
      screenCustomerText: false,
      dailyLimit: 3,
    });

    chooseOption("generativeAIDailyLimit", "generativeAIDailyLimitNone");
    expect(saved().safety).toEqual({
      screenCustomerText: false,
      dailyLimit: null,
    });
    chooseOption("generativeAIDailyLimit", "generativeAIDailyLimitOption(10)");
    expect(saved().safety).toEqual({
      screenCustomerText: false,
      dailyLimit: 10,
    });
    openProtection();
    expect(screen.getByText("generativeAISafetySummary(off,10)")).toBeTruthy();
  });

  it("summarizes a step without a daily limit", () => {
    render(
      <Harness
        initial={{
          ...imageConfig(),
          safety: { screenCustomerText: true, dailyLimit: null },
        }}
      />
    );
    expect(screen.getByText("generativeAISafetySummary(on,none)")).toBeTruthy();
  });

  it("offers a saved limit outside the usual choices", () => {
    render(
      <Harness
        initial={{
          ...imageConfig(),
          safety: { screenCustomerText: true, dailyLimit: 7 },
        }}
      />
    );
    openProtection();
    expect(limit().textContent).toBe("generativeAIDailyLimitOption(7)");
  });
});
