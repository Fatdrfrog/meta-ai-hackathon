/**
 * @jest-environment jsdom
 */

import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import { createRef, useState } from "react";
import type { StudioComposerDraft } from "@/lib/creative-assets/studio-composer-state";
import type { StudioSkillId } from "@/lib/creative-assets/studio-skills";

jest.mock("@/components/ui/command", () => ({
  Command: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="command">{children}</div>
  ),
  CommandList: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  CommandGroup: ({
    children,
    heading,
    ...props
  }: {
    children: React.ReactNode;
    heading?: string;
    [key: string]: unknown;
  }) => (
    <div {...props}>
      {heading ? <div>{heading}</div> : null}
      {children}
    </div>
  ),
  CommandItem: ({
    children,
    onSelect,
    disabled,
    ...props
  }: {
    children: React.ReactNode;
    onSelect?: () => void;
    disabled?: boolean;
    [key: string]: unknown;
  }) => (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onSelect?.()}
      {...props}
    >
      {children}
    </button>
  ),
  CommandEmpty: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

import {
  CreativeAssetsStudioComposer,
  detectStudioSkillFromText,
  ensureCharacterImageTags,
  stripStudioSkillTokens,
} from "./creative-assets-studio-composer";

const t = (key: string, values?: Record<string, number | string>) => {
  if (!values) return key;
  return Object.entries(values).reduce(
    (acc, [name, value]) => acc.replace(`{${name}}`, String(value)),
    key
  );
};

function createComposerProps(
  overrides: Partial<
    React.ComponentProps<typeof CreativeAssetsStudioComposer>
  > = {}
) {
  const props: React.ComponentProps<typeof CreativeAssetsStudioComposer> = {
    t,
    draft: { skill: "image", prompt: "hello" },
    onDraftChange: jest.fn(),
    skillAvailability: {
      image: true,
      banner: true,
      video: true,
      character: true,
      morph: true,
      audio: true,
      avatar: true,
    },
    onGenerate: jest.fn(),
    isGenerating: false,
    generateDisabled: false,
    generateLabel: "Generate image",
    imageAssets: [],
    audioAssets: [],
    mediaAssets: [],
    videoSourceAssetId: "",
    onVideoSourceAssetIdChange: jest.fn(),
    duration: "5",
    onDurationChange: jest.fn(),
    elevenLabsMode: "text_to_speech",
    onElevenLabsModeChange: jest.fn(),
    elevenLabsSourceAssetId: "",
    onElevenLabsSourceAssetIdChange: jest.fn(),
    elevenLabsTargetLanguage: "es",
    onElevenLabsTargetLanguageChange: jest.fn(),
    elevenLabsAvailable: true,
    wanAvatarMode: "image_script",
    onWanAvatarModeChange: jest.fn(),
    avatarImageAssetId: "",
    onAvatarImageAssetIdChange: jest.fn(),
    avatarAudioAssetId: "",
    onAvatarAudioAssetIdChange: jest.fn(),
    avatarResolution: "1080P",
    onAvatarResolutionChange: jest.fn(),
    wanAvatarAvailable: true,
    generationAvailable: true,
    characterReferenceAssetIds: [],
    onCharacterReferenceAssetIdsChange: jest.fn(),
    characterRatio: "9:16",
    onCharacterRatioChange: jest.fn(),
    characterAvailable: true,
    onUploadCharacterReference: jest.fn(),
    characterImageInputRef: createRef<HTMLInputElement>(),
    morphFirstFrameAssetId: "",
    onMorphFirstFrameAssetIdChange: jest.fn(),
    morphLastFrameAssetId: "",
    onMorphLastFrameAssetIdChange: jest.fn(),
    morphAvailable: true,
    onUploadMorphFirstFrame: jest.fn(),
    onUploadMorphLastFrame: jest.fn(),
    morphImageInputRef: createRef<HTMLInputElement>(),
    bannerAspectRatio: "16:9",
    onBannerAspectRatioChange: jest.fn(),
    bannerPresets: [],
    isUploading: false,
    onUploadSourceImage: jest.fn(),
    sourceImageInputRef: createRef<HTMLInputElement>(),
    onUploadAvatarPortrait: jest.fn(),
    avatarImageInputRef: createRef<HTMLInputElement>(),
    imagePresets: [],
    videoPresets: [],
    audioPresets: [],
    ...overrides,
  };
  return props;
}

function renderComposer(
  overrides: Partial<
    React.ComponentProps<typeof CreativeAssetsStudioComposer>
  > = {}
) {
  const props = createComposerProps(overrides);
  return { ...render(<CreativeAssetsStudioComposer {...props} />), props };
}

function renderStatefulComposer(
  initialDraft: StudioComposerDraft,
  overrides: Partial<
    React.ComponentProps<typeof CreativeAssetsStudioComposer>
  > = {}
) {
  const props = createComposerProps(overrides);

  function StudioHarness() {
    const [draft, setDraft] = useState(initialDraft);
    return (
      <CreativeAssetsStudioComposer
        {...props}
        draft={draft}
        onDraftChange={next => {
          props.onDraftChange(next);
          setDraft(next);
        }}
      />
    );
  }

  return { ...render(<StudioHarness />), props };
}

describe("creative assets studio composer helpers", () => {
  it("strips skill tokens including Banner and Character", () => {
    expect(stripStudioSkillTokens("@Banner warm offer")).toBe("warm offer");
    expect(stripStudioSkillTokens("@Character hero shot")).toBe("hero shot");
    expect(stripStudioSkillTokens("@Morph before after")).toBe("before after");
    expect(detectStudioSkillFromText("@Banner hello")).toBe("banner");
    expect(detectStudioSkillFromText("@Character hello")).toBe("character");
    expect(detectStudioSkillFromText("@Morph hello")).toBe("morph");
    expect(detectStudioSkillFromText("foo@Image.com")).toBeNull();
    expect(stripStudioSkillTokens("foo@Image.com")).toBe("foo@Image.com");
    expect(ensureCharacterImageTags("person walks", 2)).toBe(
      "person walks featuring [Image 1], [Image 2]"
    );
    expect(ensureCharacterImageTags("keep [Image 1] face", 2)).toBe(
      "keep [Image 1] face"
    );
  });
});

describe("CreativeAssetsStudioComposer", () => {
  it("does not show always-visible skill pills", () => {
    renderComposer();
    expect(screen.queryByTestId("studio-skill-pill-video")).toBeNull();
    expect(screen.getByTestId("studio-composer-skills")).toBeInTheDocument();
  });

  it("picks a skill from the @ picker and inserts a single token", () => {
    const { props } = renderComposer({
      draft: { skill: "image", prompt: "hello" },
    });
    fireEvent.click(screen.getByTestId("studio-composer-skills"));
    fireEvent.click(screen.getByRole("option", { name: /^Video/i }));
    expect(props.onDraftChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        skill: "video",
        prompt: "@Video hello",
      })
    );
  });

  it("shows banner aspect controls when skill is banner", () => {
    renderComposer({ draft: { skill: "banner", prompt: "@Banner offer" } });
    expect(screen.getByText("bannerAspectRatio")).toBeInTheDocument();
  });

  it("shows character reference controls when skill is character", () => {
    renderComposer({
      draft: { skill: "character", prompt: "@Character walk" },
      characterReferenceAssetIds: ["img-1"],
      imageAssets: [
        {
          id: "img-1",
          kind: "image",
          url: "https://example.com/a.jpg",
          fileName: "a.jpg",
        },
      ],
    });
    expect(
      screen.getByTestId("character-reference-dropzone")
    ).toBeInTheDocument();
    expect(screen.getByTestId("character-ref-chip-1")).toBeInTheDocument();
    expect(screen.getByText("characterRatio")).toBeInTheDocument();
  });

  it("shows morph first/last frame controls when skill is morph", () => {
    renderComposer({
      draft: { skill: "morph", prompt: "@Morph transition" },
      morphFirstFrameAssetId: "img-1",
      morphLastFrameAssetId: "img-2",
      imageAssets: [
        {
          id: "img-1",
          kind: "image",
          url: "https://example.com/a.jpg",
          fileName: "a.jpg",
        },
        {
          id: "img-2",
          kind: "image",
          url: "https://example.com/b.jpg",
          fileName: "b.jpg",
        },
      ],
    });
    expect(screen.getByTestId("morph-first-frame-select")).toBeInTheDocument();
    expect(screen.getByTestId("morph-last-frame-select")).toBeInTheDocument();
    expect(screen.getByText("morphFirstFrame")).toBeInTheDocument();
  });

  it("calls onGenerate from the generate button", () => {
    const { props } = renderComposer({
      draft: { skill: "image", prompt: "a product photo" },
    });
    fireEvent.click(screen.getByTestId("studio-composer-generate"));
    expect(props.onGenerate).toHaveBeenCalledTimes(1);
  });

  it("keeps empty input free of forced skill tokens in the placeholder", () => {
    renderComposer({ draft: { skill: "image", prompt: "" } });
    const input = screen.getByTestId(
      "studio-composer-input"
    ) as HTMLTextAreaElement;
    expect(input.value).toBe("");
    expect(input.placeholder).not.toMatch(/^@Image/);
  });

  it("keeps the prompt editable when generation is unavailable", () => {
    renderComposer({
      generationAvailable: false,
      generateDisabled: true,
      draft: { skill: "image", prompt: "" },
    });
    expect(screen.getByTestId("studio-composer-input")).toBeEnabled();
    expect(screen.getByTestId("studio-composer-generate")).toBeDisabled();
  });

  it("opens the skill picker below the caret when @ is typed", () => {
    const base = {
      t,
      draft: { skill: "image", prompt: "" } as StudioComposerDraft,
      onDraftChange: jest.fn(),
      skillAvailability: {
        image: true,
        banner: true,
        video: true,
        character: true,
        morph: true,
        audio: true,
        avatar: true,
      } as Record<StudioSkillId, boolean>,
      onGenerate: jest.fn(),
      isGenerating: false,
      generateDisabled: false,
      generateLabel: "Generate image",
      imageAssets: [],
      audioAssets: [],
      mediaAssets: [],
      videoSourceAssetId: "",
      onVideoSourceAssetIdChange: jest.fn(),
      duration: "5",
      onDurationChange: jest.fn(),
      elevenLabsMode: "text_to_speech" as const,
      onElevenLabsModeChange: jest.fn(),
      elevenLabsSourceAssetId: "",
      onElevenLabsSourceAssetIdChange: jest.fn(),
      elevenLabsTargetLanguage: "es",
      onElevenLabsTargetLanguageChange: jest.fn(),
      elevenLabsAvailable: true,
      wanAvatarMode: "image_script" as const,
      onWanAvatarModeChange: jest.fn(),
      avatarImageAssetId: "",
      onAvatarImageAssetIdChange: jest.fn(),
      avatarAudioAssetId: "",
      onAvatarAudioAssetIdChange: jest.fn(),
      avatarResolution: "1080P" as const,
      onAvatarResolutionChange: jest.fn(),
      wanAvatarAvailable: true,
      generationAvailable: true,
      characterReferenceAssetIds: [],
      onCharacterReferenceAssetIdsChange: jest.fn(),
      characterRatio: "9:16" as const,
      onCharacterRatioChange: jest.fn(),
      characterAvailable: true,
      onUploadCharacterReference: jest.fn(),
      characterImageInputRef: createRef<HTMLInputElement>(),
      morphFirstFrameAssetId: "",
      onMorphFirstFrameAssetIdChange: jest.fn(),
      morphLastFrameAssetId: "",
      onMorphLastFrameAssetIdChange: jest.fn(),
      morphAvailable: true,
      onUploadMorphFirstFrame: jest.fn(),
      onUploadMorphLastFrame: jest.fn(),
      morphImageInputRef: createRef<HTMLInputElement>(),
      bannerAspectRatio: "16:9" as const,
      onBannerAspectRatioChange: jest.fn(),
      bannerPresets: [],
      isUploading: false,
      onUploadSourceImage: jest.fn(),
      sourceImageInputRef: createRef<HTMLInputElement>(),
      onUploadAvatarPortrait: jest.fn(),
      avatarImageInputRef: createRef<HTMLInputElement>(),
      imagePresets: [],
      videoPresets: [],
      audioPresets: [],
    };

    function PromptHarness() {
      const [draft, setDraft] = useState<StudioComposerDraft>(base.draft);
      return (
        <CreativeAssetsStudioComposer
          {...base}
          draft={draft}
          onDraftChange={setDraft}
        />
      );
    }

    render(<PromptHarness />);
    const input = screen.getByTestId(
      "studio-composer-input"
    ) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "@" } });
    input.setSelectionRange(1, 1);
    fireEvent.keyUp(input);
    expect(screen.getByTestId("studio-skill-picker")).toHaveStyle({
      top: "20px",
      transform: "translateY(0.35rem)",
    });
  });

  it("wires avatar portrait upload to the avatar input, not video source", () => {
    const { props } = renderComposer({
      draft: { skill: "avatar", prompt: "@Avatar hello" },
    });
    const input = screen.getByTestId("avatar-portrait-image-input");
    expect(input).toBeInTheDocument();
    expect(screen.queryByTestId("video-source-image-input")).toBeNull();
    fireEvent.change(input, {
      target: {
        files: [new File(["portrait"], "portrait.png", { type: "image/png" })],
      },
    });
    expect(props.onUploadAvatarPortrait).toHaveBeenCalled();
    expect(props.onUploadSourceImage).not.toHaveBeenCalled();
  });

  it("switches to Video atomically and keeps the multiline brief", () => {
    function StudioHarness() {
      const [draft, setDraft] = useState<StudioComposerDraft>({
        skill: "image",
        prompt: "@Image First\nSecond",
      });
      return (
        <CreativeAssetsStudioComposer
          {...createComposerProps()}
          draft={draft}
          onDraftChange={setDraft}
        />
      );
    }

    render(<StudioHarness />);
    fireEvent.click(screen.getByTestId("studio-composer-skills"));
    fireEvent.click(screen.getByRole("option", { name: /^Video/i }));
    expect(
      (
        screen.getByTestId("studio-composer-input") as HTMLTextAreaElement
      ).value.replace(/\r\n/g, "\n")
    ).toBe("@Video First\nSecond");
    expect(screen.getByTestId("video-settings")).toBeInTheDocument();
  });

  it("keeps trailing multiline whitespace when the button opens the picker", () => {
    function StudioHarness() {
      const [draft, setDraft] = useState<StudioComposerDraft>({
        skill: "image",
        prompt: "@Image First\nSecond  \n",
      });
      return (
        <CreativeAssetsStudioComposer
          {...createComposerProps()}
          draft={draft}
          onDraftChange={setDraft}
        />
      );
    }

    render(<StudioHarness />);
    fireEvent.click(screen.getByTestId("studio-composer-skills"));
    fireEvent.click(screen.getByRole("option", { name: /^Video/i }));
    expect(
      (
        screen.getByTestId("studio-composer-input") as HTMLTextAreaElement
      ).value.replace(/\r\n/g, "\n")
    ).toBe("@Video First\nSecond  \n");
  });

  it("renders exact duration choices for providers with discrete limits", () => {
    const { props } = renderComposer({
      draft: { skill: "video", prompt: "@Video animate" },
      duration: "6",
      videoDurationOptions: [4, 6, 8],
    });

    expect(screen.queryByRole("spinbutton", { name: "seconds" })).toBeNull();
    const duration = screen.getByRole("combobox", { name: "seconds" });
    expect(duration).toHaveTextContent("6");
    fireEvent.click(duration);
    fireEvent.click(screen.getByRole("option", { name: "8" }));
    expect(props.onDurationChange).toHaveBeenCalledWith("8");
  });

  it("removes only the button-inserted separator after typing a picker query", () => {
    function StudioHarness() {
      const [draft, setDraft] = useState<StudioComposerDraft>({
        skill: "image",
        prompt: "@Image brief",
      });
      return (
        <CreativeAssetsStudioComposer
          {...createComposerProps()}
          draft={draft}
          onDraftChange={setDraft}
        />
      );
    }

    render(<StudioHarness />);
    fireEvent.click(screen.getByTestId("studio-composer-skills"));
    const input = screen.getByTestId("studio-composer-input");
    fireEvent.change(input, { target: { value: "@Image brief @vi" } });
    fireEvent.click(screen.getByRole("option", { name: /^Video/i }));
    expect(screen.getByTestId("studio-composer-input")).toHaveValue(
      "@Video brief"
    );
  });

  it("reuses a picker opened by a directly typed mention when the @ button is clicked", () => {
    renderStatefulComposer({ skill: "image", prompt: "brief" });
    const input = screen.getByTestId("studio-composer-input");

    fireEvent.change(input, { target: { value: "brief @vi" } });
    expect(screen.getByTestId("studio-skill-picker")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("studio-composer-skills"));

    expect(input).toHaveValue("brief @vi");
    expect(input).toHaveFocus();
    fireEvent.click(screen.getByRole("option", { name: /^Video/i }));
    expect(input).toHaveValue("@Video brief");
  });

  it("restores the exact pre-open brief after repeated button picker cancellation", () => {
    const original = "@Image First\nSecond  \n";
    renderStatefulComposer({ skill: "image", prompt: original });
    const input = screen.getByTestId("studio-composer-input");

    for (let attempt = 0; attempt < 2; attempt += 1) {
      fireEvent.click(screen.getByTestId("studio-composer-skills"));
      expect(input).not.toHaveValue(original);
      fireEvent.keyDown(input, { key: "Escape" });
      expect(input).toHaveValue(original);
      expect(screen.queryByTestId("studio-skill-picker")).toBeNull();
    }
  });

  it("restores a button-opened brief when an outside pointer cancels the picker", () => {
    const original = "brief with  spacing";
    renderStatefulComposer({ skill: "image", prompt: original });
    const input = screen.getByTestId("studio-composer-input");

    fireEvent.click(screen.getByTestId("studio-composer-skills"));
    fireEvent.change(input, { target: { value: `${original} @vid` } });
    fireEvent.pointerDown(document.body);

    expect(input).toHaveValue(original);
    expect(screen.queryByTestId("studio-skill-picker")).toBeNull();
  });

  it("restores a button-opened brief when caret movement invalidates its synthetic mention", () => {
    const original = "brief";
    renderStatefulComposer({ skill: "image", prompt: original });
    const input = screen.getByTestId(
      "studio-composer-input"
    ) as HTMLTextAreaElement;

    fireEvent.click(screen.getByTestId("studio-composer-skills"));
    expect(input).toHaveValue(`${original} @`);
    input.setSelectionRange(2, 2);
    fireEvent.select(input);

    expect(input).toHaveValue(original);
    expect(screen.queryByTestId("studio-skill-picker")).toBeNull();
  });

  it("does not remove a directly typed mention when Escape closes the picker", () => {
    renderStatefulComposer({ skill: "image", prompt: "brief" });
    const input = screen.getByTestId("studio-composer-input");

    fireEvent.change(input, { target: { value: "brief @unknown" } });
    expect(screen.getByTestId("studio-skill-picker")).toBeInTheDocument();
    fireEvent.keyDown(input, { key: "Escape" });

    expect(input).toHaveValue("brief @unknown");
  });

  it("does not generate for an empty picker result or IME Enter", () => {
    const onGenerate = jest.fn();
    function StudioHarness() {
      const [draft, setDraft] = useState<StudioComposerDraft>({
        skill: "image",
        prompt: "",
      });
      return (
        <CreativeAssetsStudioComposer
          {...createComposerProps({ onGenerate })}
          draft={draft}
          onDraftChange={setDraft}
        />
      );
    }

    render(<StudioHarness />);
    const input = screen.getByTestId("studio-composer-input");
    fireEvent.change(input, { target: { value: "@unknown" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    expect(onGenerate).not.toHaveBeenCalled();
  });

  it("does not expose an active descendant when the picker has no results", () => {
    renderStatefulComposer({ skill: "image", prompt: "" });
    const input = screen.getByTestId("studio-composer-input");

    fireEvent.change(input, { target: { value: "@unknown" } });

    expect(input).toHaveAttribute("aria-expanded", "true");
    expect(input).not.toHaveAttribute("aria-activedescendant");
  });

  it("lets no-result Tab advance focus and rolls back a synthetic picker query", () => {
    const original = "brief";
    renderStatefulComposer({ skill: "image", prompt: original });
    const input = screen.getByTestId("studio-composer-input");

    fireEvent.click(screen.getByTestId("studio-composer-skills"));
    fireEvent.change(input, { target: { value: `${original} @unknown` } });
    const wasNotCancelled = fireEvent.keyDown(input, { key: "Tab" });

    expect(wasNotCancelled).toBe(true);
    expect(input).toHaveValue(original);
    expect(screen.queryByTestId("studio-skill-picker")).toBeNull();
  });

  it("selects the highlighted picker option with the keyboard and closes on outside pointer", () => {
    const { props } = renderComposer();
    fireEvent.click(screen.getByTestId("studio-composer-skills"));
    const input = screen.getByTestId("studio-composer-input");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(screen.getByRole("option", { name: /^Banner/i })).toHaveAttribute(
      "aria-selected",
      "true"
    );
    fireEvent.keyDown(input, { key: "Enter" });
    expect(props.onDraftChange).toHaveBeenCalledWith(
      expect.objectContaining({ skill: "banner" })
    );

    fireEvent.click(screen.getByTestId("studio-composer-skills"));
    fireEvent.pointerDown(document.body);
    expect(screen.queryByTestId("studio-skill-picker")).toBeNull();
  });

  it("commits an ordinary text edit only once", () => {
    const { props } = renderComposer();
    const input = screen.getByTestId("studio-composer-input");
    fireEvent.change(input, { target: { value: "one edit" } });
    fireEvent.click(input);
    fireEvent.keyUp(input, { key: "t" });
    fireEvent.select(input);
    expect(props.onDraftChange).toHaveBeenCalledTimes(1);
  });

  it("keeps the keyboard highlight through keyup before selecting it", () => {
    const onGenerate = jest.fn();
    const onDraftChange = jest.fn();
    function StudioHarness() {
      const [draft, setDraft] = useState<StudioComposerDraft>({
        skill: "image",
        prompt: "brief",
      });
      return (
        <CreativeAssetsStudioComposer
          {...createComposerProps({ onGenerate })}
          draft={draft}
          onDraftChange={next => {
            onDraftChange(next);
            setDraft(next);
          }}
        />
      );
    }

    render(<StudioHarness />);
    fireEvent.click(screen.getByTestId("studio-composer-skills"));
    const input = screen.getByTestId("studio-composer-input");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyUp(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onDraftChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ skill: "banner" })
    );
    expect(onGenerate).not.toHaveBeenCalled();
  });

  it("describes a disabled character upload and its reference limit", () => {
    renderComposer({
      draft: { skill: "character", prompt: "@Character walk" },
      isUploading: true,
    });
    expect(
      screen.getByRole("button", { name: "characterReferenceUpload" })
    ).toHaveAttribute(
      "aria-describedby",
      "character-reference-limit character-upload-description"
    );
    expect(screen.getByText("uploadInProgressDescription")).toBeInTheDocument();
  });

  it("describes disabled video source replacement and removal", () => {
    renderComposer({
      draft: { skill: "video", prompt: "@Video animate" },
      isUploading: true,
      videoSourceAssetId: "img-1",
      imageAssets: [{ id: "img-1", kind: "image", fileName: "source.png" }],
    });
    expect(
      screen.getByRole("button", { name: "replaceSourceImage" })
    ).toHaveAttribute("aria-describedby", "video-source-upload-description");
    expect(
      screen.getByRole("button", { name: "removeSourceImage" })
    ).toHaveAttribute("aria-describedby", "video-source-upload-description");
  });

  it("describes disabled avatar portrait replacement and removal", () => {
    renderComposer({
      draft: { skill: "avatar", prompt: "@Avatar hello" },
      isUploading: true,
      avatarImageAssetId: "img-1",
      imageAssets: [{ id: "img-1", kind: "image", fileName: "portrait.png" }],
    });
    expect(
      screen.getByRole("button", { name: "replaceAvatarPortrait" })
    ).toHaveAttribute("aria-describedby", "avatar-portrait-upload-description");
    expect(
      screen.getByRole("button", { name: "removeAvatarPortrait" })
    ).toHaveAttribute("aria-describedby", "avatar-portrait-upload-description");
  });

  it("exposes picker ARIA semantics and source replace/remove actions", () => {
    const { props } = renderComposer({
      draft: { skill: "video", prompt: "@Video animated launch" },
      videoSourceAssetId: "img-1",
      imageAssets: [
        {
          id: "img-1",
          kind: "image",
          fileName: "launch.png",
          url: "https://example.com/launch.png",
        },
      ],
    });
    fireEvent.click(screen.getByTestId("studio-composer-skills"));
    const input = screen.getByTestId("studio-composer-input");
    expect(input).toHaveAttribute("aria-expanded", "true");
    expect(input).toHaveAttribute("aria-controls", "studio-skill-listbox");
    expect(
      screen.getByRole("listbox", { name: "studioSkillsGroup" })
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "replaceSourceImage" })
    ).toBeEnabled();
    expect(
      screen.getByRole("button", { name: "removeSourceImage" })
    ).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "removeSourceImage" }));
    expect(props.onVideoSourceAssetIdChange).toHaveBeenCalledWith("");
  });
});
