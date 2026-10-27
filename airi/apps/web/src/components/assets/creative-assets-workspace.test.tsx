/**
 * @jest-environment jsdom
 */

import "@testing-library/jest-dom";
import {
  act,
  fireEvent,
  render as rtlRender,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { toast } from "sonner";
import { SWRConfig } from "swr";
import {
  CreativeAssetsWorkspace,
  type CreativeAsset,
} from "./creative-assets-workspace";
import {
  installMatchMedia,
  installResizeObserver,
} from "@/test-support/dom-test-utils";

jest.setTimeout(40000);

const mockMarketingTemplatesProps = jest.fn();

jest.mock("@/components/assets/creative-assets-marketing-templates", () => {
  const actual = jest.requireActual(
    "@/components/assets/creative-assets-marketing-templates"
  );
  const React = jest.requireActual("react");

  return {
    ...actual,
    CreativeAssetsMarketingTemplates: (props: unknown) => {
      mockMarketingTemplatesProps(props);
      return React.createElement(
        actual.CreativeAssetsMarketingTemplates,
        props
      );
    },
  };
});

installMatchMedia();

jest.mock("sonner", () => ({
  toast: {
    error: jest.fn(),
    success: jest.fn(),
  },
}));

jest.mock("next-intl", () => ({
  useLocale: () => "en",
  useTranslations: () => (key: string) =>
    (
      ({
        loadingAssets: "Loading assets",
        title: "Assets",
        subtitle:
          "Images, videos, audio, and captions for campaigns, templates, and Airi Create",
        studioTab: "Studio",
        libraryTab: "Library",
        avatarPortraitUpload: "Upload portrait",
        noAssetsFound: "No assets found",
        emptyAssetsTitle: "No assets yet",
        emptyAssetsDescription:
          "Upload media, drop files onto this page, or generate campaign-ready images and videos.",
        emptySearchDescription:
          "Try a different search term, media type, or status filter.",
        clearSearch: "Clear search",
        searchAssets: "Search assets",
        uploadAsset: "Upload",
        assetUploaded: "Asset uploaded",
        assetUploadTooLarge:
          "File is larger than the current creative asset upload limit.",
        assetUrlCopied: "Asset URL copied",
        assetUrlCopyFailed: "assetUrlCopyFailed",
        assetsLoadFailed: "assetsLoadFailed",
        retry: "retry",
        sourceImagesLoading: "sourceImagesLoading",
        sourceImagesLoadFailed: "sourceImagesLoadFailed",
        sourceMediaLoading: "sourceMediaLoading",
        sourceMediaLoadFailed: "sourceMediaLoadFailed",
        justNow: "justNow",
        minutesAgo: "minutesAgo",
        dropToUpload: "Drop to upload",
        refreshAssets: "Refresh assets",
        summaryReady: "{count} ready",
        summaryGenerating: "{count} generating",
        summaryVideos: "{count} videos",
        shownCount: "{shown} of {total} shown",
        allMedia: "All media",
        images: "Images",
        videos: "Videos",
        audio: "Audio",
        textAssets: "Text",
        allStates: "All states",
        complete: "Complete",
        queued: "Queued",
        inProgress: "Processing",
        failed: "Failed",
        nsfw: "NSFW",
        imageKind: "image",
        videoKind: "video",
        audioKind: "audio",
        textKind: "text",
        sourceUpload: "Upload",
        sourceHiggsfield: "Higgsfield",
        sourceGoogle: "Google",
        sourceElevenLabs: "ElevenLabs",
        sourceWan: "Wan Avatar",
        sourceHappyHorse: "HappyHorse",
        sourceAlibaba: "Alibaba",
        sourceEdited: "Edited",
        videoTextToVideoHint:
          "No image → text-to-video (9:16). Add an image for image-to-video.",
        imageTab: "Image",
        videoTab: "Video",
        characterTab: "Character",
        audioTab: "Voice",
        avatarTab: "Avatar",
        studioSkillsGroup: "Skills",
        studioSkillsEmpty: "No skills found.",
        studioSkillAlreadySelected: "Active",
        studioSkillImageDescription: "Generate an image from a text prompt",
        studioSkillBannerDescription:
          "Create ad banners with aspect ratio and copy-safe framing",
        studioSkillVideoDescription: "Animate a source image into video",
        studioSkillCharacterDescription:
          "Lock character consistency with reference images",
        studioSkillVoiceDescription:
          "Create voice, SFX, transcript, subtitles, or dub",
        studioSkillAvatarDescription:
          "Create a talking avatar from portrait + script/audio",
        bannerTab: "Banner",
        bannerAspectRatio: "Aspect ratio",
        bannerPromptPlaceholder: "Describe the banner",
        generateBanner: "Generate banner",
        bannerGenerationQueued: "Banner generation queued",
        characterPromptPlaceholder: "Describe the scene",
        characterRatio: "Aspect ratio",
        characterAddFromLibrary: "Add reference",
        characterReferenceHint: "{count}/{max} references",
        characterImageLabel: "Img {n}",
        characterMoveLeft: "Move left",
        characterMoveRight: "Move right",
        characterRemoveReference: "Remove reference",
        characterReferenceUploaded: "Reference uploaded",
        generateCharacter: "Generate character video",
        characterGenerationQueued: "Character video queued",
        characterGenerationFailed: "Failed",
        characterUnavailableTitle: "Unavailable",
        characterUnavailableDescription: "Not configured",
        morphTab: "Morph",
        studioSkillMorphDescription: "Before/after morph",
        morphPromptPlaceholder: "Describe the transition",
        morphFirstFrame: "First frame",
        morphLastFrame: "Last frame",
        morphUploadFirst: "Upload before",
        morphUploadLast: "Upload after",
        morphReplaceFirst: "Replace before",
        morphReplaceLast: "Replace after",
        generateMorph: "Generate morph",
        morphGenerationQueued: "Morph queued",
        morphGenerationFailed: "Failed",
        morphUnavailableTitle: "Unavailable",
        morphUnavailableDescription: "Not configured",
        studioProductSlot: "Product",
        avatarMode: "Avatar mode",
        avatarModeScript: "Image + script (TTS)",
        avatarModeAudio: "Image + audio",
        avatarPortrait: "Portrait image",
        avatarAudio: "Speech audio",
        avatarSelectAudio: "Select audio under 15s",
        avatarAudioLimitHint: "Audio under 15s",
        avatarScript: "Script",
        avatarScriptPlaceholder: "Write script",
        avatarNeedsElevenLabs: "Needs ElevenLabs",
        avatarResolution: "Resolution",
        avatarUnavailableTitle: "Unavailable",
        avatarUnavailableDescription: "Not configured",
        generateAvatar: "Generate talking avatar",
        avatarGenerationQueued: "Queued",
        avatarGenerationFailed: "Failed",
        prompt: "Prompt",
        motion: "Motion",
        seconds: "seconds",
        imagePromptPlaceholder:
          "Describe the final image: product, scene, lighting, style, and composition.",
        videoPromptPlaceholder:
          "Describe camera movement, subject motion, pacing, and mood.",
        generateImage: "Generate image",
        generateVideo: "Generate video",
        sourceImageDropTitle: "Drop source image here",
        sourceImageDropDescription:
          "Upload or drop an image to use it as the first frame.",
        uploadSourceImage: "Upload image",
        replaceSourceImage: "Replace image",
        selectLibraryImage: "Select from library",
        sourceImageSelected: "Image selected for video",
        sourceImageOnly: "Upload an image to use as the video source.",
        sourceImageUploaded: "Source image uploaded",
        sourceImageReady: "Ready for video",
        useForVideo: "Use for video",
        selectedForVideo: "Selected for video",
        makeGreenScreen: "Make green screen",
        greenScreenAlreadyExistsTooltip:
          "A green-screen copy already exists. Retry or delete that copy before creating another.",
        greenScreenQueued: "Green-screen edit queued",
        greenScreenFailed: "Green-screen edit failed",
        copyUrl: "Copy URL",
        tryAgain: "Try again",
        retryQueued: "Retry queued",
        retryUnavailable: "This asset cannot be retried.",
        retryPossibleDuplicateTitle: "Retry may create a second paid video",
        retryPossibleDuplicateDescription:
          "The provider may have accepted the original job.",
        retryPossibleDuplicateCancel: "Keep waiting",
        retryPossibleDuplicateConfirm: "Retry anyway",
        deleteAsset: "Delete asset",
        deleteAssetConfirm: "Delete this asset?",
        assetDeleted: "Asset deleted",
        deleteFailed: "Delete failed",
        imageGenerationQueued: "Image generation queued",
        videoGenerationQueued: "Video generation queued",
        googleFreeProvider: "Google customer account",
        higgsfieldProvider: "Higgsfield source",
        higgsfieldSourceConnected:
          "Using your connected Higgsfield source for generation.",
        higgsfieldSourceRequiredTitle:
          "Connect a generation source to continue",
        higgsfieldSourceRequiredDescription:
          "Connect your Google AI or Higgsfield credentials in Settings > Integrations to generate images and video.",
        generationUnavailableTitle: "Image generation unavailable",
        generationUnavailableDescription:
          "Connect your Google AI or Higgsfield credentials in Settings > Integrations to generate images and video. Provider charges are billed to your account.",
        providerStatusImage: "Image: {provider}",
        providerStatusVideo: "Video: {provider}",
        providerStatusCharacter: "Character: {provider}",
        providerStatusMorph: "Morph: {provider}",
        providerStatusAvatar: "Avatar: {provider}",
        sourceCanva: "Canva",
        openEditor: "Open editor",
        avatarPortraitUploaded: "Portrait uploaded",
        openIntegrations: "Open integrations",
        openElevenLabsIntegration: "Connect ElevenLabs",
        elevenLabsConnectHint:
          "Connect ElevenLabs to keep creating voiceovers, sound effects, subtitles, transcripts, and dubs.",
        elevenLabsPlatformHint:
          "ElevenLabs platform generation is not configured.",
        elevenLabsMode: "ElevenLabs action",
        elevenLabsVoiceover: "Voiceover",
        elevenLabsSoundEffect: "Sound effect",
        elevenLabsTranscript: "Transcript",
        elevenLabsSubtitles: "Subtitles",
        elevenLabsDub: "Dub",
        elevenLabsScript: "Script",
        elevenLabsPrompt: "Sound prompt",
        elevenLabsScriptPlaceholder:
          "Write the short voiceover that should be generated.",
        elevenLabsPromptPlaceholder:
          "Describe the sound effect, ambience, timing, and style.",
        elevenLabsSourceMedia: "Source media",
        elevenLabsSelectSourceMedia: "Select audio or video",
        sourceMediaReady: "Ready",
        elevenLabsTargetLanguage: "Target language",
        elevenLabsUnavailableTitle: "Connect ElevenLabs to use voice tools",
        elevenLabsUnavailableDescription:
          "Connect your ElevenLabs API key in Settings > Integrations. Provider charges are billed to your account.",
        elevenLabsGenerate: "Generate",
        elevenLabsGenerationQueued: "ElevenLabs asset queued",
        elevenLabsGenerationFailed: "Failed to create ElevenLabs asset",
        canvaConnectHint:
          "Connect Canva in Integrations to show brand templates here.",
        canvaTemplatesTitle: "Canva brand templates",
        canvaTemplatesDescription:
          "Templates from your connected Canva source that can inspire WhatsApp follow-ups.",
        openCanvaTemplate: "Open in Canva",
        airiDraftTitle: "Airi creative draft",
        airiDraftDescription:
          "Review the draft from Airi, then generate or open the matching provider tool.",
        airiDraftProvider: "Provider: {provider}",
        airiDraftUse: "Use draft",
        airiDraftActive: "Active",
        marketingTemplatesTitle: "Marketing templates",
        marketingTemplatesDescription:
          "Start from a ready prompt for UGC, product, avatar, and voice creatives.",
        marketingTemplatesCount: "{count} templates",
        marketingTemplatesUse: "Use",
        marketingTemplatesApplied: "Loaded “{title}” into Studio",
        marketingTemplatesCategoryAll: "All",
        marketingTemplatesCategoryUgc: "UGC",
        marketingTemplatesCategoryProduct: "Product",
        marketingTemplatesCategoryAvatar: "Avatar",
        marketingTemplatesCategoryVoice: "Voice",
        marketingTemplatesCategoryStory: "Story",
        marketingTemplatesCollectionAiri: "airi.chat templates",
        marketingTemplatesCollectionTikTok: "TikTok trends",
      }) as Record<string, string>
    )[key] || key,
}));

installResizeObserver();

Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
  configurable: true,
  value: jest.fn(),
});

Object.defineProperties(HTMLElement.prototype, {
  hasPointerCapture: { configurable: true, value: jest.fn(() => false) },
  setPointerCapture: { configurable: true, value: jest.fn() },
  releasePointerCapture: { configurable: true, value: jest.fn() },
});

function jsonResponse(payload: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  } as Response;
}

function render(ui: ReactElement) {
  return rtlRender(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      {ui}
    </SWRConfig>
  );
}

function switchToLibraryTab() {
  const tab = screen.getByRole("tab", { name: "Library" });
  // Radix Tabs selects on pointer/mouse down, not click alone.
  fireEvent.mouseDown(tab);
  fireEvent.click(tab);
}

function switchToStudioTab() {
  const tab = screen.getByRole("tab", { name: "Studio" });
  fireEvent.mouseDown(tab);
  fireEvent.click(tab);
}

function renderWorkspace() {
  return render(
    <CreativeAssetsWorkspace
      workspaceId="workspace-1"
      higgsfieldConfigured
      happyHorseConfigured
      wanMorphConfigured
    />
  );
}

describe("CreativeAssetsWorkspace", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    jest.useRealTimers();
    global.fetch = originalFetch;
    window.localStorage.clear();
    jest.clearAllMocks();
  });

  beforeEach(() => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  });

  it("retries a stalled status poll after its deadline without overlap", async () => {
    jest.useFakeTimers();
    const statusSignals: AbortSignal[] = [];
    const pendingAsset = {
      id: "workspace-pending-video",
      workspaceId: "workspace-1",
      kind: "video",
      source: "higgsfield",
      status: "queued",
      prompt: "Product reveal",
      fileName: "product-reveal.mp4",
    };
    const fetchMock = jest.fn(
      (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = String(input);
        if (url.includes("surface=status")) {
          const signal = init?.signal as AbortSignal;
          statusSignals.push(signal);
          return new Promise<Response>((_resolve, reject) => {
            const rejectOnAbort = () => reject(signal.reason);
            if (signal.aborted) {
              rejectOnAbort();
            } else {
              signal.addEventListener("abort", rejectOnAbort, { once: true });
            }
          });
        }
        if (url.includes("surface=picker")) {
          return Promise.resolve(jsonResponse({ assets: [] }));
        }
        return Promise.resolve(jsonResponse({ assets: [pendingAsset] }));
      }
    );
    global.fetch = fetchMock as never;

    const { unmount } = renderWorkspace();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      jest.advanceTimersByTime(4000);
      await Promise.resolve();
    });
    expect(statusSignals).toHaveLength(1);
    expect(statusSignals[0]?.aborted).toBe(false);

    await act(async () => {
      jest.advanceTimersByTime(9999);
      await Promise.resolve();
    });
    expect(statusSignals).toHaveLength(1);
    expect(statusSignals[0]?.aborted).toBe(false);

    await act(async () => {
      jest.advanceTimersByTime(1);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(statusSignals[0]?.aborted).toBe(true);

    await act(async () => {
      jest.advanceTimersByTime(3999);
      await Promise.resolve();
    });
    expect(statusSignals).toHaveLength(1);

    await act(async () => {
      jest.advanceTimersByTime(1);
      await Promise.resolve();
    });
    expect(statusSignals).toHaveLength(2);
    expect(statusSignals[1]?.aborted).toBe(false);

    unmount();
    expect(statusSignals[1]?.aborted).toBe(true);
    await act(async () => {
      jest.advanceTimersByTime(20_000);
      await Promise.resolve();
    });
    expect(statusSignals).toHaveLength(2);
  });

  it("keeps the marketing-template apply handler stable across status polls", async () => {
    jest.useFakeTimers();
    const pendingAsset = {
      id: "workspace-pending-image",
      workspaceId: "workspace-1",
      kind: "image",
      source: "higgsfield",
      status: "queued",
      prompt: "Product reveal",
      fileName: "product-reveal.png",
    };
    let statusPolls = 0;

    global.fetch = jest.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("surface=status")) {
        statusPolls += 1;
        return Promise.resolve(
          jsonResponse({
            assets: [
              {
                ...pendingAsset,
                status: "complete",
                url: "https://cdn.example.com/product-reveal.png",
              },
            ],
          })
        );
      }
      if (url.includes("surface=picker")) {
        return Promise.resolve(jsonResponse({ assets: [] }));
      }
      return Promise.resolve(jsonResponse({ assets: [pendingAsset] }));
    }) as never;

    renderWorkspace();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const initialProps = mockMarketingTemplatesProps.mock.calls.at(-1)?.[0] as {
      onApply: unknown;
    };
    const initialOnApply = initialProps.onApply;
    mockMarketingTemplatesProps.mockClear();

    await act(async () => {
      jest.advanceTimersByTime(4000);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(statusPolls).toBe(1);
    expect(mockMarketingTemplatesProps).toHaveBeenCalled();
    for (const [props] of mockMarketingTemplatesProps.mock.calls as Array<
      [{ onApply: unknown }]
    >) {
      expect(props.onApply).toBe(initialOnApply);
    }
  });

  it("keeps approved reference videos visible in the library and tracks them after the planner closes", async () => {
    jest.useFakeTimers();
    const queued: CreativeAsset = {
      id: "reference-render",
      workspaceId: "workspace-1",
      kind: "video",
      source: "edited",
      status: "queued",
      fileName: "Friday lunch.mp4",
    };
    const fetchMock = jest.fn((input: RequestInfo | URL) =>
      Promise.resolve(
        jsonResponse({
          assets: String(input).includes("surface=status")
            ? [
                {
                  ...queued,
                  status: "complete",
                  url: "https://media.example/lunch.mp4",
                },
              ]
            : [],
        })
      )
    );
    global.fetch = fetchMock as never;
    renderWorkspace();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const { onAssetCreated } = mockMarketingTemplatesProps.mock.calls.at(
      -1
    )?.[0] as { onAssetCreated: (asset: CreativeAsset) => void };
    act(() => onAssetCreated(queued));
    switchToLibraryTab();
    expect(screen.getByText("Friday lunch.mp4")).toBeVisible();
    expect(screen.getAllByText("Queued")[0]).toBeVisible();
    await act(async () => {
      jest.advanceTimersByTime(4000);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText("Complete")).toBeVisible();
    expect(
      fetchMock.mock.calls.filter(([url]) =>
        String(url).includes("surface=status")
      )
    ).toHaveLength(1);
    act(() =>
      onAssetCreated({
        ...queued,
        workspaceId: "workspace-2",
        id: "foreign-video",
        fileName: "Other workspace.mp4",
      })
    );
    expect(screen.queryByText("Other workspace.mp4")).not.toBeInTheDocument();
  });

  it("merges completed reference render updates without leaving a duplicate or polling again", async () => {
    jest.useFakeTimers();
    const fetchMock = jest.fn(() =>
      Promise.resolve(jsonResponse({ assets: [] }))
    );
    global.fetch = fetchMock as never;
    renderWorkspace();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const { onAssetCreated } = mockMarketingTemplatesProps.mock.calls.at(
      -1
    )?.[0] as { onAssetCreated: (asset: CreativeAsset) => void };
    const queued: CreativeAsset = {
      id: "reference-render-complete",
      workspaceId: "workspace-1",
      kind: "video",
      source: "edited",
      status: "queued",
      fileName: "Completed lunch.mp4",
    };
    act(() => onAssetCreated(queued));
    act(() =>
      onAssetCreated({
        ...queued,
        status: "complete",
        url: "https://media.example/lunch.mp4",
      })
    );
    switchToLibraryTab();
    expect(screen.getAllByText("Completed lunch.mp4")).toHaveLength(1);
    expect(screen.getByText("Complete")).toBeVisible();
    const requestCount = fetchMock.mock.calls.length;
    await act(async () => {
      jest.advanceTimersByTime(8000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(requestCount);
  });

  it("carries an image brief to Video and posts it to the video endpoint", async () => {
    global.fetch = jest.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/assets/generate/happyhorse")) {
        return Promise.resolve(jsonResponse({ asset: null }, 202));
      }
      return Promise.resolve(jsonResponse({ assets: [] }));
    }) as never;
    const user = userEvent.setup();

    renderWorkspace();
    await user.type(
      screen.getByTestId("studio-composer-input"),
      "Launch reveal"
    );
    await user.click(screen.getByTestId("studio-composer-skills"));
    await user.click(screen.getByRole("option", { name: /Video/i }));
    await user.click(screen.getByTestId("studio-composer-generate"));

    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining("/assets/generate/happyhorse"),
        expect.objectContaining({
          body: expect.stringContaining('"prompt":"Launch reveal"'),
        })
      )
    );
  });

  it("keeps a newer template draft when an older generation finishes", async () => {
    let resolveGeneration!: (response: Response) => void;
    const generation = new Promise<Response>(resolve => {
      resolveGeneration = resolve;
    });
    global.fetch = jest.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/assets/generate/higgsfield")) return generation;
      return Promise.resolve(jsonResponse({ assets: [] }));
    }) as never;
    const user = userEvent.setup();

    render(
      <CreativeAssetsWorkspace
        workspaceId="workspace-1"
        higgsfieldConfigured
        elevenLabsConfigured
        wanAvatarConfigured
      />
    );
    await user.type(
      screen.getByTestId("studio-composer-input"),
      "Old image brief"
    );
    await user.click(screen.getByTestId("studio-composer-generate"));
    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining("/assets/generate/higgsfield"),
        expect.objectContaining({ method: "POST" })
      )
    );

    fireEvent.click(screen.getByTestId("marketing-template-ugc-talking-head"));
    const input = screen.getByTestId(
      "studio-composer-input"
    ) as HTMLTextAreaElement;
    expect(input.value).toContain("quick update from our team");

    resolveGeneration(jsonResponse({ asset: null }, 202));
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith("Image generation queued")
    );
    expect(input.value).toContain("quick update from our team");
  });

  it("ignores an old workspace generation after a new workspace starts generating", async () => {
    function deferred<T>() {
      let resolve!: (value: T) => void;
      const promise = new Promise<T>(next => {
        resolve = next;
      });
      return { promise, resolve };
    }

    const workspaceAGeneration = deferred<Response>();
    const workspaceBGeneration = deferred<Response>();
    let workspaceABodyRead = false;
    global.fetch = jest.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("workspace-a/assets/generate/higgsfield")) {
        return workspaceAGeneration.promise;
      }
      if (url.includes("workspace-b/assets/generate/higgsfield")) {
        return workspaceBGeneration.promise;
      }
      return Promise.resolve(jsonResponse({ assets: [] }));
    }) as never;
    const user = userEvent.setup();
    const workspaceAAsset = {
      id: "workspace-a-generated",
      workspaceId: "workspace-a",
      kind: "image",
      source: "higgsfield",
      status: "queued",
      prompt: "Shared draft",
      fileName: "workspace-a-generated.png",
    };

    const cache = new Map();
    const workspaceView = (workspace: "a" | "b") => (
      <SWRConfig value={{ provider: () => cache, dedupingInterval: 0 }}>
        <CreativeAssetsWorkspace
          workspaceId={`workspace-${workspace}`}
          higgsfieldConfigured
          generationProvider={workspace === "a" ? "google" : "higgsfield"}
          freeGenerations={
            workspace === "a"
              ? {
                  configured: true,
                  limit: 10,
                  used: 1,
                  remaining: 9,
                }
              : null
          }
        />
      </SWRConfig>
    );
    const { rerender } = rtlRender(workspaceView("a"));
    await user.type(
      screen.getByTestId("studio-composer-input"),
      "Workspace A draft"
    );
    await user.click(screen.getByTestId("studio-composer-generate"));
    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining("workspace-a/assets/generate/higgsfield"),
        expect.objectContaining({ method: "POST" })
      )
    );

    rerender(workspaceView("b"));
    const input = screen.getByTestId(
      "studio-composer-input"
    ) as HTMLTextAreaElement;
    expect(input.value).toBe("");
    await user.type(input, "Workspace B draft");
    expect(screen.getByTestId("studio-composer-generate")).toBeEnabled();
    await user.click(screen.getByTestId("studio-composer-generate"));
    expect(
      screen
        .getByTestId("studio-composer-generate")
        .querySelector(".animate-spin")
    ).not.toBeNull();

    workspaceAGeneration.resolve({
      ...jsonResponse({}, 202),
      json: async () => {
        workspaceABodyRead = true;
        return {
          asset: workspaceAAsset,
          generationProvider: "google",
          freeGenerations: {
            configured: true,
            limit: 10,
            used: 10,
            remaining: 0,
          },
        };
      },
    } as Response);
    await waitFor(() => expect(workspaceABodyRead).toBe(true));
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(input.value).toBe("Workspace B draft");
    expect(toast.success).not.toHaveBeenCalled();
    expect(
      screen
        .getByTestId("studio-composer-generate")
        .querySelector(".animate-spin")
    ).not.toBeNull();
    expect(
      screen.queryByText(/The \{limit\} free creative generations/)
    ).not.toBeInTheDocument();
    switchToLibraryTab();
    expect(
      screen.queryByText("workspace-a-generated.png")
    ).not.toBeInTheDocument();
    switchToStudioTab();
    const workspaceBInput = screen.getByTestId(
      "studio-composer-input"
    ) as HTMLTextAreaElement;

    workspaceBGeneration.resolve(
      jsonResponse(
        {
          asset: {
            ...workspaceAAsset,
            id: "workspace-b-generated",
            workspaceId: "workspace-b",
            prompt: "Workspace B draft",
            fileName: "workspace-b-generated.png",
          },
        },
        202
      )
    );
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith("Image generation queued")
    );
    await waitFor(() =>
      expect(
        screen
          .getByTestId("studio-composer-generate")
          .querySelector(".animate-spin")
      ).toBeNull()
    );
    expect(workspaceBInput.value).toBe("");
    await user.type(workspaceBInput, "B still has its configured provider");
    expect(screen.getByTestId("studio-composer-generate")).toBeEnabled();
    switchToLibraryTab();
    expect(await screen.findByText("workspace-b-generated.png")).toBeVisible();
    expect(screen.queryByText("workspace-a-generated.png")).toBeNull();
  });

  it("preserves separate video and morph durations", async () => {
    global.fetch = jest.fn(() =>
      Promise.resolve(jsonResponse({ assets: [] }))
    ) as never;
    const user = userEvent.setup();

    renderWorkspace();
    await user.click(screen.getByTestId("studio-composer-skills"));
    await user.click(screen.getByRole("option", { name: /Video/i }));
    await user.clear(screen.getByRole("spinbutton", { name: "seconds" }));
    await user.type(screen.getByRole("spinbutton", { name: "seconds" }), "12");
    await user.click(screen.getByTestId("studio-composer-skills"));
    await user.click(screen.getByRole("option", { name: /Morph/i }));
    await user.clear(screen.getByRole("spinbutton", { name: "seconds" }));
    await user.type(screen.getByRole("spinbutton", { name: "seconds" }), "3");
    await user.click(screen.getByTestId("studio-composer-skills"));
    await user.click(screen.getByRole("option", { name: /Video/i }));

    expect(screen.getByRole("spinbutton", { name: "seconds" })).toHaveValue(12);
  });

  it("applies a marketing template into the studio composer", async () => {
    global.fetch = jest.fn(() =>
      Promise.resolve(jsonResponse({ assets: [] }))
    ) as never;

    render(
      <CreativeAssetsWorkspace
        workspaceId="workspace-1"
        higgsfieldConfigured
        elevenLabsConfigured
        wanAvatarConfigured
      />
    );

    expect(
      await screen.findByTestId("marketing-templates")
    ).toBeInTheDocument();
    expect(
      screen.getByRole("tab", { name: "airi.chat templates" })
    ).toHaveAttribute("data-state", "active");
    expect(
      (global.fetch as jest.Mock).mock.calls.some(([input]) =>
        String(input).includes("/marketing-templates/tiktok")
      )
    ).toBe(false);
    fireEvent.click(screen.getByTestId("marketing-template-ugc-talking-head"));

    await waitFor(() => {
      const value = (
        screen.getByTestId("studio-composer-input") as HTMLTextAreaElement
      ).value;
      expect(value.startsWith("@Avatar")).toBe(true);
      expect(value).toContain("quick update from our team");
    });
    expect(toast.success).toHaveBeenCalled();
  });

  it("applies an Airi ElevenLabs draft from local storage", async () => {
    window.localStorage.setItem(
      "airi:creative-asset-drafts:v1:workspace-1",
      JSON.stringify([
        {
          id: "airi-creative:voiceover",
          workspaceId: "workspace-1",
          kind: "audio_asset",
          title: "Generate voiceover",
          summary: "Create a short voiceover for the campaign.",
          prompt: "Read a warm campaign follow-up.",
          provider: "elevenlabs",
          providerSource: "workspace_source",
          mode: "text_to_speech",
          sourceIds: ["elevenlabs-1"],
        },
      ])
    );
    global.fetch = jest.fn(() =>
      Promise.resolve(jsonResponse({ assets: [] }))
    ) as never;

    render(
      <CreativeAssetsWorkspace
        workspaceId="workspace-1"
        higgsfieldConfigured
        elevenLabsConfigured
        openAiriAssetDraftOnMount
      />
    );

    expect(await screen.findByText("Airi creative draft")).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByTestId("studio-composer-input")).toHaveValue(
        "Read a warm campaign follow-up."
      )
    );
  });

  it("loads Canva templates with an Airi draft query", async () => {
    let canvaQuery = "";
    window.localStorage.setItem(
      "airi:creative-asset-drafts:v1:workspace-1",
      JSON.stringify([
        {
          id: "airi-creative:canva",
          workspaceId: "workspace-1",
          kind: "canva_design",
          title: "Prepare Canva story",
          summary: "Use brand templates for a WhatsApp story creative.",
          prompt: "Campaign: Demo lead creative push",
          provider: "canva",
          providerSource: "workspace_source",
          mode: "canva_template",
          canvaQuery: "Demo lead creative push WhatsApp story",
          sourceIds: ["canva-1"],
        },
      ])
    );
    global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/scenario-generator/canva/templates")) {
        canvaQuery = JSON.parse(String(init?.body || "{}")).query as string;
        return Promise.resolve(jsonResponse({ status: "ok", items: [] }));
      }

      return Promise.resolve(jsonResponse({ assets: [] }));
    }) as never;

    render(
      <CreativeAssetsWorkspace
        workspaceId="workspace-1"
        higgsfieldConfigured
        openAiriAssetDraftOnMount
      />
    );

    await waitFor(() =>
      expect(canvaQuery).toBe("Demo lead creative push WhatsApp story")
    );
    expect(await screen.findByText("Prepare Canva story")).toBeInTheDocument();
  });

  it("searches the asset library without hiding generation controls", async () => {
    global.fetch = jest.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("kind=image") && url.includes("status=complete")) {
        return Promise.resolve(
          jsonResponse({
            assets: [
              {
                id: "source-1",
                workspaceId: "workspace-1",
                kind: "image",
                source: "uploaded",
                status: "complete",
                fileName: "soup-source.jpg",
                url: "https://storage.example.com/source.jpg",
              },
            ],
          })
        );
      }

      return Promise.resolve(
        jsonResponse({
          assets: [
            {
              id: "image-1",
              workspaceId: "workspace-1",
              kind: "image",
              source: "higgsfield",
              status: "complete",
              prompt: "Premium soup visual",
              url: "https://storage.example.com/image.jpg",
            },
            {
              id: "video-1",
              workspaceId: "workspace-1",
              kind: "video",
              source: "higgsfield",
              status: "complete",
              prompt: "Motion for campaign",
              url: "https://storage.example.com/video.mp4",
            },
          ],
        })
      );
    }) as never;

    render(
      <CreativeAssetsWorkspace workspaceId="workspace-1" higgsfieldConfigured />
    );

    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    switchToLibraryTab();

    expect(await screen.findByText("Premium soup visual")).toBeInTheDocument();
    expect(screen.getByText("Motion for campaign")).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText("Search assets"), {
      target: { value: "motion" },
    });

    expect(screen.queryByText("Premium soup visual")).not.toBeInTheDocument();
    expect(screen.getByText("Motion for campaign")).toBeInTheDocument();

    switchToStudioTab();
    expect(
      screen.getByRole("button", { name: "Generate image" })
    ).toBeInTheDocument();

    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
  });

  it("uploads a dropped source image and uses it for video generation", async () => {
    let generatedBody: Record<string, unknown> | null = null;
    const uploadBodies: Record<string, unknown>[] = [];
    const gcsUploadUrls: string[] = [];

    global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);

      if (url === "https://storage.googleapis.com/upload-source-session") {
        gcsUploadUrls.push(url);
        return Promise.resolve(jsonResponse({}, 200));
      }

      if (url.includes("/assets/upload")) {
        if (init?.method !== "POST")
          return Promise.resolve(
            jsonResponse({
              storage: { ready: false, limitBytes: 10 * 1024 ** 3 },
            })
          );
        const body = JSON.parse(String(init?.body || "{}")) as Record<
          string,
          unknown
        >;
        uploadBodies.push(body);
        if (body.action === "initiate") {
          return Promise.resolve(
            jsonResponse({
              upload: {
                provider: "gcs",
                assetId: "uploaded-source",
                bucket: "icecore-ai-creative-assets-prod",
                path: "workspaces/workspace-1/creative-assets/image/uploaded-source/frame.jpg",
                uploadUrl:
                  "https://storage.googleapis.com/upload-source-session",
                method: "PUT",
                kind: "image",
                mimeType: "image/jpeg",
                fileName: "frame.jpg",
                fileSize: 5,
              },
            })
          );
        }

        return Promise.resolve(
          jsonResponse({
            asset: {
              id: "uploaded-source",
              workspaceId: "workspace-1",
              kind: "image",
              source: "uploaded",
              status: "complete",
              fileName: "frame.jpg",
              fileSize: 2048,
              url: "https://storage.example.com/frame.jpg",
            },
          })
        );
      }

      if (url.includes("/assets/generate/higgsfield")) {
        generatedBody = JSON.parse(String(init?.body || "{}")) as Record<
          string,
          unknown
        >;
        return Promise.resolve(
          jsonResponse({
            asset: {
              id: "video-queued",
              workspaceId: "workspace-1",
              kind: "video",
              source: "higgsfield",
              provider: "higgsfield",
              status: "queued",
              prompt: "Smooth product reveal",
              sourceAssetId: "uploaded-source",
            },
          })
        );
      }

      return Promise.resolve(jsonResponse({ assets: [] }));
    }) as never;

    render(
      <CreativeAssetsWorkspace workspaceId="workspace-1" higgsfieldConfigured />
    );

    fireEvent.change(screen.getByTestId("studio-composer-input"), {
      target: { value: "@Video " },
    });

    const dropzone = await screen.findByTestId("video-source-dropzone");
    const sourceImage = new File(["image"], "frame.jpg", {
      type: "image/jpeg",
    });

    fireEvent.drop(dropzone, {
      dataTransfer: {
        files: [sourceImage],
        types: ["Files"],
      },
    });

    expect(await screen.findAllByText("frame.jpg")).toHaveLength(2);
    expect(uploadBodies).toMatchObject([
      {
        action: "initiate",
        fileName: "frame.jpg",
        mimeType: "image/jpeg",
        fileSize: 5,
      },
      {
        action: "complete",
        assetId: "uploaded-source",
        provider: "gcs",
        bucket: "icecore-ai-creative-assets-prod",
        path: "workspaces/workspace-1/creative-assets/image/uploaded-source/frame.jpg",
        kind: "image",
        mimeType: "image/jpeg",
        fileName: "frame.jpg",
        fileSize: 5,
      },
    ]);
    expect(gcsUploadUrls).toEqual([
      "https://storage.googleapis.com/upload-source-session",
    ]);

    fireEvent.change(screen.getByTestId("studio-composer-input"), {
      target: { value: "@Video Smooth product reveal" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Generate video" }));

    await waitFor(() =>
      expect(generatedBody).toMatchObject({
        mode: "image_to_video",
        prompt: "Smooth product reveal",
        sourceAssetId: "uploaded-source",
      })
    );
  });

  it("uploads large videos through GCS resumable upload chunks", async () => {
    const uploadBodies: Record<string, unknown>[] = [];
    const gcsUploadRequests: Array<{
      url: string;
      contentRange: string | null;
    }> = [];
    global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);

      if (url === "https://storage.googleapis.com/upload-video-session") {
        gcsUploadRequests.push({
          url,
          contentRange:
            (init?.headers as Record<string, string> | undefined)?.[
              "Content-Range"
            ] || null,
        });
        return Promise.resolve(
          jsonResponse({}, gcsUploadRequests.length === 1 ? 308 : 200)
        );
      }

      if (url.includes("/assets/upload")) {
        if (init?.method !== "POST")
          return Promise.resolve(
            jsonResponse({
              storage: { ready: false, limitBytes: 10 * 1024 ** 3 },
            })
          );
        const body = JSON.parse(String(init?.body || "{}")) as Record<
          string,
          unknown
        >;
        uploadBodies.push(body);

        if (body.action === "initiate") {
          return Promise.resolve(
            jsonResponse({
              upload: {
                provider: "gcs",
                assetId: "uploaded-video",
                bucket: "icecore-ai-creative-assets-prod",
                path: "workspaces/workspace-1/creative-assets/video/uploaded-video/talking.mp4",
                uploadUrl:
                  "https://storage.googleapis.com/upload-video-session",
                method: "PUT",
                kind: "video",
                mimeType: "video/mp4",
                fileName: "talking.mp4",
                fileSize: 9 * 1024 * 1024,
              },
            })
          );
        }

        return Promise.resolve(
          jsonResponse({
            asset: {
              id: "uploaded-video",
              workspaceId: "workspace-1",
              kind: "video",
              source: "uploaded",
              status: "complete",
              fileName: "talking.mp4",
              fileSize: 9 * 1024 * 1024,
              url: "https://storage.example.com/talking.mp4",
            },
          })
        );
      }

      return Promise.resolve(jsonResponse({ assets: [] }));
    }) as never;

    const { container } = render(
      <CreativeAssetsWorkspace workspaceId="workspace-1" higgsfieldConfigured />
    );

    const fileInput = container.querySelector(
      'input[type="file"]'
    ) as HTMLInputElement | null;
    expect(fileInput).not.toBeNull();

    const videoFile = new File(
      [new Uint8Array(9 * 1024 * 1024)],
      "talking.mp4",
      { type: "video/mp4" }
    );
    fireEvent.change(fileInput!, {
      target: { files: [videoFile] },
    });

    switchToLibraryTab();
    expect(await screen.findByText("talking.mp4")).toBeInTheDocument();
    expect(gcsUploadRequests).toEqual([
      {
        url: "https://storage.googleapis.com/upload-video-session",
        contentRange: "bytes 0-8388607/9437184",
      },
      {
        url: "https://storage.googleapis.com/upload-video-session",
        contentRange: "bytes 8388608-9437183/9437184",
      },
    ]);
    expect(uploadBodies).toMatchObject([
      { action: "initiate", fileName: "talking.mp4", mimeType: "video/mp4" },
      {
        action: "complete",
        provider: "gcs",
        assetId: "uploaded-video",
        bucket: "icecore-ai-creative-assets-prod",
        path: "workspaces/workspace-1/creative-assets/video/uploaded-video/talking.mp4",
        kind: "video",
        mimeType: "video/mp4",
        fileName: "talking.mp4",
      },
    ]);
  });

  it("reuses a video key until an accepted response body is definitive", async () => {
    const idempotencyKeys: string[] = [];
    let videoAttempts = 0;
    global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/assets/generate/happyhorse")) {
        videoAttempts += 1;
        idempotencyKeys.push(
          (init?.headers as Record<string, string>)["Idempotency-Key"]
        );
        if (videoAttempts === 1) {
          return Promise.reject(new TypeError("network disconnected"));
        }
        if (videoAttempts === 2) {
          return Promise.resolve(
            jsonResponse(
              {
                error:
                  "Creative generation is busy. Retry with the same Idempotency-Key.",
                code: "generation_admission_busy",
              },
              503
            )
          );
        }
        if (videoAttempts === 3) {
          return Promise.resolve({
            ok: true,
            status: 202,
            json: async () => {
              throw new SyntaxError("truncated JSON");
            },
          } as unknown as Response);
        }
        if (videoAttempts === 4) {
          return Promise.resolve(jsonResponse({}, 202));
        }
        if (videoAttempts === 5) {
          return Promise.resolve(jsonResponse(null, 202));
        }
        return Promise.resolve(
          jsonResponse(
            {
              asset: {
                id: `video-${videoAttempts}`,
                workspaceId: "workspace-1",
                kind: "video",
                source: "happyhorse",
                provider: "happyhorse",
                status: "queued",
                prompt: "Smooth product reveal",
              },
            },
            202
          )
        );
      }
      return Promise.resolve(jsonResponse({ assets: [] }));
    }) as never;

    render(
      <CreativeAssetsWorkspace
        workspaceId="workspace-1"
        higgsfieldConfigured={false}
        happyHorseConfigured
      />
    );
    const composer = screen.getByTestId("studio-composer-input");
    fireEvent.change(composer, {
      target: { value: "@Video Smooth product reveal" },
    });
    const generate = screen.getByRole("button", { name: "Generate video" });

    fireEvent.click(generate);
    await waitFor(() => expect(videoAttempts).toBe(1));
    await waitFor(() => expect(generate).toBeEnabled());
    fireEvent.click(generate);
    await waitFor(() => expect(videoAttempts).toBe(2));
    await waitFor(() => expect(generate).toBeEnabled());
    fireEvent.click(generate);
    await waitFor(() => expect(videoAttempts).toBe(3));
    await waitFor(() => expect(generate).toBeEnabled());
    fireEvent.click(generate);
    await waitFor(() => expect(videoAttempts).toBe(4));
    await waitFor(() => expect(generate).toBeEnabled());
    fireEvent.click(generate);
    await waitFor(() => expect(videoAttempts).toBe(5));
    await waitFor(() =>
      expect(toast.error).toHaveBeenLastCalledWith(
        "The server accepted the request but its response could not be read. Retry the same request."
      )
    );
    await waitFor(() => expect(generate).toBeEnabled());
    fireEvent.click(generate);
    await waitFor(() => expect(videoAttempts).toBe(6));
    await waitFor(() => expect(composer).toHaveValue(""));

    fireEvent.change(composer, {
      target: { value: "@Video Smooth product reveal" },
    });
    await waitFor(() => expect(generate).toBeEnabled());
    fireEvent.click(generate);
    await waitFor(() => expect(videoAttempts).toBe(7));

    expect(idempotencyKeys[0]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
    expect(idempotencyKeys[1]).toBe(idempotencyKeys[0]);
    expect(idempotencyKeys[2]).toBe(idempotencyKeys[0]);
    expect(idempotencyKeys[3]).toBe(idempotencyKeys[0]);
    expect(idempotencyKeys[4]).toBe(idempotencyKeys[0]);
    expect(idempotencyKeys[5]).toBe(idempotencyKeys[0]);
    expect(idempotencyKeys[6]).not.toBe(idempotencyKeys[5]);
  });

  it("shows the upload limit error when GCS rejects a resumable upload", async () => {
    const uploadBodies: Record<string, unknown>[] = [];
    global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);

      if (url === "https://storage.googleapis.com/upload-too-large-session") {
        return Promise.resolve({
          ok: false,
          status: 413,
          text: async () => "Maximum size exceeded",
        } as Response);
      }

      if (url.includes("/assets/upload")) {
        if (init?.method !== "POST")
          return Promise.resolve(
            jsonResponse({
              storage: { ready: false, limitBytes: 10 * 1024 ** 3 },
            })
          );
        const body = JSON.parse(String(init?.body || "{}")) as Record<
          string,
          unknown
        >;
        uploadBodies.push(body);

        return Promise.resolve(
          jsonResponse({
            upload: {
              provider: "gcs",
              assetId: "uploaded-video",
              bucket: "icecore-ai-creative-assets-prod",
              path: "workspaces/workspace-1/creative-assets/video/uploaded-video/talking.mov",
              uploadUrl:
                "https://storage.googleapis.com/upload-too-large-session",
              method: "PUT",
              kind: "video",
              mimeType: "video/quicktime",
              fileName: "talking.mov",
              fileSize: 6 * 1024 * 1024 + 1,
            },
          })
        );
      }

      return Promise.resolve(jsonResponse({ assets: [] }));
    }) as never;

    const { container } = render(
      <CreativeAssetsWorkspace workspaceId="workspace-1" higgsfieldConfigured />
    );

    const fileInput = container.querySelector(
      'input[type="file"]'
    ) as HTMLInputElement | null;
    expect(fileInput).not.toBeNull();

    const videoFile = new File(
      [new Uint8Array(6 * 1024 * 1024 + 1)],
      "talking.mov",
      { type: "video/quicktime" }
    );
    fireEvent.change(fileInput!, {
      target: { files: [videoFile] },
    });

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "File is larger than the current creative asset upload limit."
      )
    );
    expect(uploadBodies).toMatchObject([
      { action: "initiate", fileName: "talking.mov" },
    ]);
    expect(screen.queryByText("talking.mov")).not.toBeInTheDocument();
  });

  it("lets a completed image card become the video source", async () => {
    const sourceAsset = {
      id: "source-card",
      workspaceId: "workspace-1",
      kind: "image",
      source: "uploaded",
      status: "complete",
      fileName: "soup-source.jpg",
      url: "https://storage.example.com/source.jpg",
    };

    global.fetch = jest.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("kind=image") && url.includes("status=complete")) {
        return Promise.resolve(jsonResponse({ assets: [sourceAsset] }));
      }

      return Promise.resolve(jsonResponse({ assets: [sourceAsset] }));
    }) as never;

    render(
      <CreativeAssetsWorkspace workspaceId="workspace-1" higgsfieldConfigured />
    );

    switchToLibraryTab();
    expect(await screen.findByText("soup-source.jpg")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Use for video" }));
    switchToStudioTab();

    const dropzone = screen.getByTestId("video-source-dropzone");
    expect(dropzone.querySelector("img")?.getAttribute("src")).toBe(
      "https://storage.example.com/source.jpg"
    );
    expect(screen.getAllByText("soup-source.jpg").length).toBeGreaterThan(0);
    switchToLibraryTab();
    expect(
      screen.getByRole("button", { name: "Selected for video" })
    ).toBeInTheDocument();
  });

  it("submits an exact supported Google video duration", async () => {
    const sourceAsset = {
      id: "source-card",
      workspaceId: "workspace-1",
      kind: "image",
      source: "uploaded",
      status: "complete",
      fileName: "soup-source.jpg",
      url: "https://storage.example.com/source.jpg",
    };
    let generatedBody: Record<string, unknown> | null = null;
    global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/assets/generate/higgsfield")) {
        generatedBody = JSON.parse(String(init?.body || "{}")) as Record<
          string,
          unknown
        >;
        return Promise.resolve(
          jsonResponse({
            asset: {
              id: "video-queued",
              workspaceId: "workspace-1",
              kind: "video",
              source: "google",
              provider: "google",
              status: "queued",
            },
            generationProvider: "google",
          })
        );
      }
      return Promise.resolve(jsonResponse({ assets: [sourceAsset] }));
    }) as never;

    render(
      <CreativeAssetsWorkspace
        workspaceId="workspace-1"
        higgsfieldConfigured
        generationProvider="google"
        freeGenerations={{
          configured: true,
          limit: 10,
          used: 0,
          remaining: 10,
        }}
      />
    );

    switchToLibraryTab();
    expect(await screen.findByText("soup-source.jpg")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Use for video" }));
    switchToStudioTab();
    fireEvent.change(screen.getByTestId("studio-composer-input"), {
      target: { value: "@Video Smooth product reveal" },
    });

    expect(screen.queryByRole("spinbutton", { name: "seconds" })).toBeNull();
    expect(screen.getByRole("combobox", { name: "seconds" })).toHaveTextContent(
      "6"
    );
    fireEvent.click(screen.getByRole("button", { name: "Generate video" }));

    await waitFor(() =>
      expect(generatedBody).toMatchObject({
        mode: "image_to_video",
        duration: 6,
        sourceAssetId: "source-card",
      })
    );
  });

  it("queues a green-screen edit from a completed video card", async () => {
    let editUrl = "";
    global.fetch = jest.fn((input: RequestInfo | URL) => {
      const url = String(input);

      if (url.includes("/assets/video-1/edits")) {
        editUrl = url;
        return Promise.resolve(
          jsonResponse(
            {
              asset: {
                id: "green-screen-1",
                workspaceId: "workspace-1",
                kind: "video",
                source: "edited",
                provider: "airi",
                status: "queued",
                storageProvider: "gcs",
                sourceAssetId: "video-1",
                modelId: "airi-green-screen-bria-v1",
                prompt: "Green-screen derivative of talking-head.mp4",
              },
            },
            202
          )
        );
      }

      if (url.includes("kind=image") && url.includes("status=complete")) {
        return Promise.resolve(
          jsonResponse({
            assets: [
              {
                id: "image-1",
                workspaceId: "workspace-1",
                kind: "image",
                source: "uploaded",
                status: "complete",
                fileName: "menu.png",
                url: "https://storage.example.com/menu.png",
              },
            ],
          })
        );
      }

      return Promise.resolve(
        jsonResponse({
          assets: [
            {
              id: "video-1",
              workspaceId: "workspace-1",
              kind: "video",
              source: "uploaded",
              status: "complete",
              fileName: "talking-head.mp4",
              url: "https://storage.example.com/talking-head.mp4",
            },
            {
              id: "image-1",
              workspaceId: "workspace-1",
              kind: "image",
              source: "uploaded",
              status: "complete",
              fileName: "menu.png",
              url: "https://storage.example.com/menu.png",
            },
          ],
          greenScreenSourceAssetIds: [],
        })
      );
    }) as never;

    render(
      <CreativeAssetsWorkspace workspaceId="workspace-1" higgsfieldConfigured />
    );

    switchToLibraryTab();
    expect(await screen.findByText("talking-head.mp4")).toBeInTheDocument();
    expect(screen.getAllByText("menu.png").length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: "Make green screen" }));

    await waitFor(() =>
      expect(editUrl).toBe("/api/workspaces/workspace-1/assets/video-1/edits")
    );
    expect(
      await screen.findByText("Green-screen derivative of talking-head.mp4")
    ).toBeInTheDocument();
    expect(screen.getAllByText("Queued").length).toBeGreaterThan(0);
    const makeGreenScreenButton = screen.getByRole("button", {
      name: "Make green screen",
    });
    expect(makeGreenScreenButton).toBeDisabled();
    expect(makeGreenScreenButton.closest("span")).toHaveAttribute(
      "title",
      "A green-screen copy already exists. Retry or delete that copy before creating another."
    );
  });

  it("disables green-screen creation on the original and retries the failed derivative", async () => {
    let retryBody: Record<string, unknown> | null = null;
    global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);

      if (url.includes("/assets/video-1/edits")) {
        retryBody = JSON.parse(String(init?.body || "{}")) as Record<
          string,
          unknown
        >;
        return Promise.resolve(
          jsonResponse(
            {
              asset: {
                id: "green-screen-2",
                workspaceId: "workspace-1",
                kind: "video",
                source: "edited",
                provider: "airi",
                status: "queued",
                storageProvider: "gcs",
                sourceAssetId: "video-1",
                modelId: "airi-green-screen-bria-v1",
                prompt: "Green-screen derivative of talking-head.mp4",
              },
            },
            202
          )
        );
      }

      if (
        url.includes("/assets/green-screen-failed") &&
        init?.method === "DELETE"
      ) {
        return Promise.resolve(jsonResponse({ success: true }));
      }

      if (url.includes("kind=image") && url.includes("status=complete")) {
        return Promise.resolve(jsonResponse({ assets: [] }));
      }

      return Promise.resolve(
        jsonResponse({
          assets: [
            {
              id: "video-1",
              workspaceId: "workspace-1",
              kind: "video",
              source: "uploaded",
              status: "complete",
              fileName: "talking-head.mp4",
              url: "https://storage.example.com/talking-head.mp4",
            },
            {
              id: "green-screen-failed",
              workspaceId: "workspace-1",
              kind: "video",
              source: "edited",
              provider: "airi",
              status: "failed",
              storageProvider: "gcs",
              sourceAssetId: "video-1",
              modelId: "airi-green-screen-v1",
              prompt: "Green-screen derivative of talking-head.mp4",
              error: "Source video exceeded a processing limit",
            },
          ],
          greenScreenSourceAssetIds: ["video-1"],
        })
      );
    }) as never;

    render(
      <CreativeAssetsWorkspace workspaceId="workspace-1" higgsfieldConfigured />
    );

    switchToLibraryTab();
    expect(await screen.findByText("talking-head.mp4")).toBeInTheDocument();
    expect(
      screen.getByText("Source video exceeded a processing limit")
    ).toBeInTheDocument();
    const makeGreenScreenButton = screen.getByRole("button", {
      name: "Make green screen",
    });
    expect(makeGreenScreenButton).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    await waitFor(() =>
      expect(retryBody).toMatchObject({
        operation: "green_screen",
        retryAssetId: "green-screen-failed",
      })
    );
    expect(toast.success).toHaveBeenCalledWith("Retry queued");
  });

  it("keeps assets visible and directs missing visual credentials to integrations independently of audio usage", async () => {
    global.fetch = jest.fn(() =>
      Promise.resolve(jsonResponse({ assets: [] }))
    ) as never;

    render(
      <CreativeAssetsWorkspace
        workspaceId="workspace-1"
        higgsfieldConfigured={false}
        higgsfieldDisabledReason="source_required"
        higgsfieldIntegrationUrl="/panel/w/workspace-1/settings/integrations?integration=higgsfield"
        freeGenerations={{
          configured: true,
          used: 10,
          limit: 10,
          remaining: 0,
        }}
      />
    );

    expect(
      await screen.findByText("Image generation unavailable")
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Connect your Google AI or Higgsfield credentials in Settings > Integrations to generate images and video. Provider charges are billed to your account."
      )
    ).toBeInTheDocument();
    const integrationLinks = screen.getAllByRole("link", {
      name: "Open integrations",
    });
    expect(
      integrationLinks.some(
        link =>
          link.getAttribute("href") ===
          "/panel/w/workspace-1/settings/integrations?integration=higgsfield"
      )
    ).toBe(true);
    expect(
      screen.getByRole("button", { name: "Generate image" })
    ).toBeDisabled();
    expect(screen.getByTestId("studio-composer-input")).toBeEnabled();
  });

  it("keeps customer Google generation enabled when the audio allowance is exhausted", async () => {
    global.fetch = jest.fn(() =>
      Promise.resolve(
        jsonResponse({
          assets: [],
          higgsfieldConfigured: true,
          generationProvider: "google",
          freeGenerations: {
            configured: true,
            limit: 10,
            used: 10,
            remaining: 0,
          },
        })
      )
    ) as never;

    render(
      <CreativeAssetsWorkspace
        workspaceId="workspace-1"
        higgsfieldConfigured
        generationProvider="google"
        freeGenerations={{
          configured: true,
          limit: 10,
          used: 10,
          remaining: 0,
        }}
      />
    );

    fireEvent.change(await screen.findByTestId("studio-composer-input"), {
      target: { value: "@Image Premium product photo" },
    });
    expect(
      screen.getByRole("button", { name: "Generate image" })
    ).toBeEnabled();
  });

  it("does not disable customer visuals after receiving exhausted audio quota metadata", async () => {
    global.fetch = jest.fn((input: RequestInfo | URL) =>
      Promise.resolve(
        jsonResponse(
          String(input).includes("/assets/generate/higgsfield")
            ? {
                generationProvider: "google",
                freeGenerations: {
                  configured: true,
                  used: 10,
                  limit: 10,
                  remaining: 0,
                },
              }
            : { assets: [] }
        )
      )
    ) as never;
    render(
      <CreativeAssetsWorkspace
        workspaceId="workspace-1"
        higgsfieldConfigured
        generationProvider="google"
      />
    );
    fireEvent.change(await screen.findByTestId("studio-composer-input"), {
      target: { value: "@Image First image" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Generate image" }));
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith("Image generation queued")
    );
    fireEvent.change(screen.getByTestId("studio-composer-input"), {
      target: { value: "@Image Second image" },
    });
    expect(
      screen.getByRole("button", { name: "Generate image" })
    ).toBeEnabled();
  });

  it("retries a legacy image through the active customer provider instead of platform Alibaba", async () => {
    const requests: string[] = [];
    global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "POST" && url.includes("/assets/generate/")) {
        requests.push(url);
        return Promise.resolve(jsonResponse({ generationProvider: "google" }));
      }
      return Promise.resolve(
        jsonResponse({
          assets: [
            {
              id: "failed-image",
              workspaceId: "workspace-1",
              kind: "image",
              source: "google",
              provider: "google",
              status: "failed",
              prompt: "Product photo",
            },
          ],
        })
      );
    }) as never;
    render(
      <CreativeAssetsWorkspace
        workspaceId="workspace-1"
        higgsfieldConfigured
        generationProvider="google"
        alibabaImageConfigured
      />
    );
    switchToLibraryTab();
    await screen.findByTestId("asset-failed-image");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]).toBe(
      "/api/workspaces/workspace-1/assets/generate/higgsfield"
    );
  });

  it("shows Canva templates when the Canva source returns brand templates", async () => {
    global.fetch = jest.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/scenario-generator/canva/templates")) {
        return Promise.resolve(
          jsonResponse({
            status: "ok",
            items: [
              {
                id: "template-1",
                title: "Restaurant follow-up story",
                thumbnailUrl: "https://cdn.example.com/canva.jpg",
                createUrl: "https://www.canva.com/design/template-1",
              },
            ],
          })
        );
      }

      return Promise.resolve(jsonResponse({ assets: [] }));
    }) as never;

    render(
      <CreativeAssetsWorkspace workspaceId="workspace-1" higgsfieldConfigured />
    );

    expect(
      await screen.findByText("Canva brand templates")
    ).toBeInTheDocument();
    expect(screen.getByText("Restaurant follow-up story")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open in Canva" })).toHaveAttribute(
      "href",
      "https://www.canva.com/design/template-1"
    );
  });

  it("retries a safely recoverable contract video even when the failure is nonretryable", async () => {
    const retryRequests: Array<{
      url: string;
      body: Record<string, unknown>;
      headers: Record<string, string>;
    }> = [];
    const deleteRequests: string[] = [];

    global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);

      if (init?.method === "DELETE") {
        deleteRequests.push(url);
        return Promise.resolve(jsonResponse({ success: true }));
      }

      if (url.includes("/assets/failed-video/retry")) {
        retryRequests.push({
          url,
          body: JSON.parse(String(init?.body || "{}")) as Record<
            string,
            unknown
          >,
          headers: init?.headers as Record<string, string>,
        });
        return Promise.resolve(
          jsonResponse(
            {
              asset: {
                id: "retry-child",
                workspaceId: "workspace-1",
                kind: "video",
                source: "higgsfield",
                provider: "higgsfield",
                status: "queued",
                prompt: "Handheld lifestyle movement",
                sourceAssetId: "source-1",
                generation: {
                  contractVersion: 1,
                  retryOfAssetId: "failed-video",
                },
              },
            },
            202
          )
        );
      }

      if (url.includes("kind=image") && url.includes("status=complete")) {
        return Promise.resolve(
          jsonResponse({
            assets: [
              {
                id: "source-1",
                workspaceId: "workspace-1",
                kind: "image",
                source: "uploaded",
                status: "complete",
                fileName: "source.jpg",
                url: "https://storage.example.com/source.jpg",
              },
            ],
          })
        );
      }

      return Promise.resolve(
        jsonResponse({
          assets: [
            {
              id: "failed-video",
              workspaceId: "workspace-1",
              kind: "video",
              source: "higgsfield",
              provider: "higgsfield",
              status: "failed",
              prompt: "Handheld lifestyle movement",
              sourceAssetId: "source-1",
              error: "Workflow bundle missing workflow export",
              generation: {
                contractVersion: 1,
                canRetry: true,
                failure: {
                  code: "provider_result_not_ready",
                  retryable: false,
                  submissionUncertain: false,
                },
                requiresDuplicateChargeAcknowledgement: false,
              },
            },
          ],
        })
      );
    }) as never;

    render(
      <CreativeAssetsWorkspace workspaceId="workspace-1" higgsfieldConfigured />
    );

    switchToLibraryTab();
    expect(
      await screen.findByText("Workflow bundle missing workflow export")
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    await waitFor(() => expect(retryRequests).toHaveLength(1));
    expect(retryRequests[0].url).toContain("/assets/failed-video/retry");
    expect(retryRequests[0].body).toEqual({});
    expect(retryRequests[0].headers).toMatchObject({
      "Content-Type": "application/json",
      "Idempotency-Key": expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      ),
    });
    expect(deleteRequests).toHaveLength(0);
    expect(screen.getByTestId("asset-failed-video")).toBeInTheDocument();
    expect(screen.getByTestId("asset-retry-child")).toBeInTheDocument();
  });

  it("requires explicit duplicate-charge acknowledgement before retrying", async () => {
    const retryBodies: Record<string, unknown>[] = [];
    global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/assets/uncertain-video/retry")) {
        retryBodies.push(
          JSON.parse(String(init?.body || "{}")) as Record<string, unknown>
        );
        return Promise.resolve(
          jsonResponse({
            asset: {
              id: "uncertain-retry-child",
              workspaceId: "workspace-1",
              kind: "video",
              source: "happyhorse",
              provider: "happyhorse",
              status: "queued",
            },
          })
        );
      }
      if (url.includes("kind=image") && url.includes("status=complete")) {
        return Promise.resolve(jsonResponse({ assets: [] }));
      }
      return Promise.resolve(
        jsonResponse({
          assets: [
            {
              id: "uncertain-video",
              workspaceId: "workspace-1",
              kind: "video",
              source: "happyhorse",
              provider: "happyhorse",
              status: "failed",
              prompt: "Orbit product",
              error: "Submission outcome is unknown",
              generation: {
                contractVersion: 1,
                canRetry: true,
                failure: {
                  retryable: true,
                  submissionUncertain: true,
                },
                requiresDuplicateChargeAcknowledgement: true,
              },
            },
          ],
        })
      );
    }) as never;
    const user = userEvent.setup();

    render(
      <CreativeAssetsWorkspace
        workspaceId="workspace-1"
        higgsfieldConfigured
        happyHorseConfigured
      />
    );
    switchToLibraryTab();
    expect(await screen.findByTestId("asset-uncertain-video")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(
      await screen.findByText("Retry may create a second paid video")
    ).toBeVisible();
    expect(retryBodies).toHaveLength(0);

    await user.click(screen.getByRole("button", { name: "Keep waiting" }));
    expect(retryBodies).toHaveLength(0);

    await user.click(screen.getByRole("button", { name: "Try again" }));
    await user.click(screen.getByRole("button", { name: "Retry anyway" }));
    await waitFor(() => expect(retryBodies).toHaveLength(1));
    expect(retryBodies[0]).toEqual({
      acknowledgePossibleDuplicateCharge: true,
    });
  });

  it("rechecks retryability before opening the duplicate-charge retry gate", async () => {
    const mutationRequests: string[] = [];
    const failedAsset = {
      id: "stale-uncertain-video",
      workspaceId: "workspace-1",
      kind: "video",
      source: "happyhorse",
      provider: "happyhorse",
      status: "failed",
      prompt: "Orbit product",
      error: "Submission outcome is unknown",
      generation: {
        contractVersion: 1,
        canRetry: true,
        failure: {
          retryable: true,
          submissionUncertain: true,
        },
        requiresDuplicateChargeAcknowledgement: true,
      },
    };
    global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "POST" && url.includes("/retry")) {
        mutationRequests.push(url);
        return Promise.resolve(jsonResponse({ success: true }));
      }
      if (url.includes("kind=image") && url.includes("status=complete")) {
        return Promise.resolve(jsonResponse({ assets: [] }));
      }
      return Promise.resolve(jsonResponse({ assets: [failedAsset] }));
    }) as never;
    const user = userEvent.setup();

    render(
      <CreativeAssetsWorkspace
        workspaceId="workspace-1"
        higgsfieldConfigured
        happyHorseConfigured
      />
    );
    switchToLibraryTab();
    expect(
      await screen.findByTestId("asset-stale-uncertain-video")
    ).toBeVisible();
    const retryButton = screen.getByRole("button", { name: "Try again" });

    failedAsset.generation.canRetry = false;
    await user.click(retryButton);

    expect(
      screen.queryByText("Retry may create a second paid video")
    ).not.toBeInTheDocument();
    expect(toast.error).toHaveBeenCalledWith("This asset cannot be retried.");
    expect(mutationRequests).toEqual([]);
  });

  it.each([
    {
      label: "non-retryable",
      generation: {
        contractVersion: 1,
        canRetry: false,
        failure: {
          retryable: false,
          submissionUncertain: false,
        },
        requiresDuplicateChargeAcknowledgement: false,
      },
    },
    {
      label: "non-retryable acknowledgement-required",
      generation: {
        contractVersion: 1,
        canRetry: false,
        failure: {
          retryable: false,
          submissionUncertain: true,
        },
        requiresDuplicateChargeAcknowledgement: true,
      },
    },
    {
      label: "malformed",
      generation: {
        contractVersion: 1,
        canRetry: false,
        requiresDuplicateChargeAcknowledgement: false,
      },
    },
  ])(
    "does not expose the legacy retry path for $label contract-v1 failure metadata",
    async ({ generation }) => {
      const mutationRequests: Array<{ method: string; url: string }> = [];
      global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (
          init?.method === "DELETE" ||
          (init?.method === "POST" && url.includes("/assets/"))
        ) {
          mutationRequests.push({ method: init.method, url });
          return Promise.resolve(jsonResponse({ success: true }));
        }
        if (url.includes("kind=image") && url.includes("status=complete")) {
          return Promise.resolve(jsonResponse({ assets: [] }));
        }
        return Promise.resolve(
          jsonResponse({
            assets: [
              {
                id: "blocked-contract-video",
                workspaceId: "workspace-1",
                kind: "video",
                source: "google",
                provider: "google",
                status: "failed",
                prompt: "Orbit product",
                sourceAssetId: "source-1",
                error: "Provider rejected the request",
                generation,
              },
            ],
          })
        );
      }) as never;

      render(
        <CreativeAssetsWorkspace
          workspaceId="workspace-1"
          higgsfieldConfigured
        />
      );
      switchToLibraryTab();

      expect(
        await screen.findByTestId("asset-blocked-contract-video")
      ).toBeVisible();
      expect(
        screen.queryByRole("button", { name: "Try again" })
      ).not.toBeInTheDocument();
      expect(mutationRequests).toEqual([]);
    }
  );

  it("deletes an existing asset from the library card", async () => {
    const originalConfirm = window.confirm;
    window.confirm = jest.fn(() => true);
    let deletedUrl = "";

    global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);

      if (init?.method === "DELETE") {
        deletedUrl = url;
        return Promise.resolve(
          jsonResponse({ success: true, assetId: "image-1" })
        );
      }

      if (url.includes("kind=image") && url.includes("status=complete")) {
        return Promise.resolve(jsonResponse({ assets: [] }));
      }

      return Promise.resolve(
        jsonResponse({
          assets: [
            {
              id: "image-1",
              workspaceId: "workspace-1",
              kind: "image",
              source: "uploaded",
              status: "complete",
              fileName: "menu.png",
              url: "https://storage.example.com/menu.png",
            },
          ],
        })
      );
    }) as never;

    try {
      render(
        <CreativeAssetsWorkspace
          workspaceId="workspace-1"
          higgsfieldConfigured
        />
      );

      switchToLibraryTab();
      expect(await screen.findByText("menu.png")).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Delete asset" }));

      await waitFor(() =>
        expect(deletedUrl).toBe("/api/workspaces/workspace-1/assets/image-1")
      );
      await waitFor(() =>
        expect(screen.queryByText("menu.png")).not.toBeInTheDocument()
      );
    } finally {
      window.confirm = originalConfirm;
    }
  });

  it("does not reload source pickers when a library filter changes", async () => {
    global.fetch = jest.fn(() =>
      Promise.resolve(jsonResponse({ assets: [] }))
    ) as never;
    const user = userEvent.setup();

    renderWorkspace();
    const pickerCallCount = () =>
      jest
        .mocked(global.fetch)
        .mock.calls.filter(([url]) => String(url).includes("surface=picker"))
        .length;
    await waitFor(() => expect(pickerCallCount()).toBe(3));
    const pickerCallsBefore = pickerCallCount();

    switchToLibraryTab();
    await user.click(screen.getByRole("combobox", { name: "mediaKind" }));
    await user.click(screen.getByRole("option", { name: "Videos" }));

    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringMatching(/kind=video(?!.*surface=picker)/),
        expect.anything()
      )
    );
    expect(pickerCallCount()).toBe(pickerCallsBefore);
  });

  it("keeps the latest filter response when an older request resolves last", async () => {
    function deferred<T>() {
      let resolve!: (value: T) => void;
      const promise = new Promise<T>(next => {
        resolve = next;
      });
      return { promise, resolve };
    }

    const all = deferred<Response>();
    const video = deferred<Response>();
    const imageAsset = {
      id: "image-old",
      workspaceId: "workspace-1",
      kind: "image" as const,
      source: "uploaded" as const,
      status: "complete" as const,
      fileName: "older-image.png",
    };
    const videoAsset = {
      id: "video-new",
      workspaceId: "workspace-1",
      kind: "video" as const,
      source: "uploaded" as const,
      status: "complete" as const,
      fileName: "newer-video.mp4",
    };
    global.fetch = jest.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("surface=picker")) {
        return Promise.resolve(jsonResponse({ assets: [] }));
      }
      if (url.includes("/assets?") && url.includes("kind=video")) {
        return video.promise;
      }
      if (url.includes("/assets?")) return all.promise;
      return Promise.resolve(jsonResponse({ assets: [] }));
    }) as never;
    const user = userEvent.setup();

    renderWorkspace();
    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining("/assets?"),
        expect.anything()
      )
    );
    switchToLibraryTab();
    await user.click(screen.getByRole("combobox", { name: "mediaKind" }));
    await user.click(screen.getByRole("option", { name: "Videos" }));

    video.resolve(jsonResponse({ assets: [videoAsset] }));
    expect(await screen.findByText(videoAsset.fileName)).toBeVisible();
    all.resolve(jsonResponse({ assets: [imageAsset] }));
    await waitFor(() =>
      expect(screen.queryByText(imageAsset.fileName)).not.toBeInTheDocument()
    );
  });

  it("does not apply a stale source-picker response after the workspace changes", async () => {
    function deferred<T>() {
      let resolve!: (value: T) => void;
      const promise = new Promise<T>(next => {
        resolve = next;
      });
      return { promise, resolve };
    }

    const firstWorkspaceImagePicker = deferred<Response>();
    global.fetch = jest.fn((input: RequestInfo | URL) => {
      const url = String(input);
      const isFirstWorkspace = url.includes("/workspaces/workspace-1/");
      if (
        isFirstWorkspace &&
        url.includes("surface=picker") &&
        url.includes("kind=image")
      ) {
        return firstWorkspaceImagePicker.promise;
      }
      if (url.includes("surface=picker")) {
        return Promise.resolve(
          jsonResponse({
            assets:
              url.includes("workspace-2") && url.includes("kind=image")
                ? [
                    {
                      id: "next-source",
                      workspaceId: "workspace-2",
                      kind: "image",
                      source: "uploaded",
                      status: "complete",
                      fileName: "next-source.jpg",
                      url: "https://storage.example.com/next-source.jpg",
                    },
                  ]
                : [],
          })
        );
      }
      return Promise.resolve(jsonResponse({ assets: [] }));
    }) as never;
    const user = userEvent.setup();
    const { rerender } = render(
      <CreativeAssetsWorkspace workspaceId="workspace-1" higgsfieldConfigured />
    );

    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining("workspace-1/assets?kind=image"),
        expect.anything()
      )
    );
    rerender(
      <CreativeAssetsWorkspace workspaceId="workspace-2" higgsfieldConfigured />
    );
    fireEvent.change(screen.getByTestId("studio-composer-input"), {
      target: { value: "@Video " },
    });
    expect(await screen.findByTestId("video-settings")).toBeVisible();
    await user.click(screen.getByRole("combobox"));
    expect(await screen.findByText("next-source.jpg")).toBeVisible();
    await user.click(screen.getByRole("option", { name: "next-source.jpg" }));

    firstWorkspaceImagePicker.resolve(
      jsonResponse({
        assets: [
          {
            id: "stale-source",
            workspaceId: "workspace-1",
            kind: "image",
            source: "uploaded",
            status: "complete",
            fileName: "stale-source.jpg",
            url: "https://storage.example.com/stale-source.jpg",
          },
        ],
      })
    );

    await new Promise(resolve => setTimeout(resolve, 0));
    expect(screen.getAllByText("next-source.jpg")).toHaveLength(2);
  });

  it("shows contextual source-image failure feedback and retries independently", async () => {
    let imagePickerAttempts = 0;
    global.fetch = jest.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("surface=picker") && url.includes("kind=image")) {
        imagePickerAttempts += 1;
        return Promise.resolve(
          imagePickerAttempts === 1
            ? jsonResponse({ error: "image picker unavailable" }, 500)
            : jsonResponse({ assets: [] })
        );
      }
      return Promise.resolve(jsonResponse({ assets: [] }));
    }) as never;
    const user = userEvent.setup();

    renderWorkspace();
    fireEvent.change(screen.getByTestId("studio-composer-input"), {
      target: { value: "@Video Product reveal" },
    });

    expect(await screen.findByText("sourceImagesLoadFailed")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "retry" }));
    await waitFor(() => expect(imagePickerAttempts).toBe(2));
    await waitFor(() =>
      expect(
        screen.queryByText("sourceImagesLoadFailed")
      ).not.toBeInTheDocument()
    );
  });

  it("preserves failed media kinds while clearing fulfilled empty kinds", async () => {
    let audioAttempts = 0;
    let videoAttempts = 0;
    const audioAsset = {
      id: "source-audio",
      workspaceId: "workspace-1",
      kind: "audio",
      source: "uploaded",
      status: "complete",
      fileName: "source-audio.mp3",
      url: "https://storage.example.com/source-audio.mp3",
    };
    const videoAsset = {
      id: "source-video",
      workspaceId: "workspace-1",
      kind: "video",
      source: "uploaded",
      status: "complete",
      fileName: "source-video.mp4",
      url: "https://storage.example.com/source-video.mp4",
    };
    global.fetch = jest.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("surface=picker") && url.includes("kind=audio")) {
        audioAttempts += 1;
        if (audioAttempts === 1) {
          return Promise.resolve(jsonResponse({ assets: [audioAsset] }));
        }
        if (audioAttempts === 2) {
          return Promise.resolve(jsonResponse({ error: "audio failed" }, 500));
        }
        return Promise.resolve(jsonResponse({ assets: [] }));
      }
      if (url.includes("surface=picker") && url.includes("kind=video")) {
        videoAttempts += 1;
        if (videoAttempts === 1) {
          return Promise.resolve(jsonResponse({ error: "video failed" }, 500));
        }
        if (videoAttempts === 2) {
          return Promise.resolve(jsonResponse({ assets: [videoAsset] }));
        }
        return Promise.resolve(jsonResponse({ error: "video failed" }, 500));
      }
      return Promise.resolve(jsonResponse({ assets: [] }));
    }) as never;
    const user = userEvent.setup();

    render(
      <CreativeAssetsWorkspace
        workspaceId="workspace-1"
        higgsfieldConfigured
        elevenLabsConfigured
      />
    );
    fireEvent.change(screen.getByTestId("studio-composer-input"), {
      target: { value: "@Voice " },
    });
    await user.click(screen.getByRole("combobox"));
    await user.click(screen.getByRole("option", { name: "Transcript" }));

    expect(await screen.findByText("sourceMediaLoadFailed")).toBeVisible();
    let mediaPicker = screen.getAllByRole("combobox")[1];
    await user.click(mediaPicker);
    expect(await screen.findByText("source-audio.mp3")).toBeVisible();
    expect(screen.queryByText("source-video.mp4")).not.toBeInTheDocument();
    await user.keyboard("{Escape}");

    await user.click(screen.getByRole("button", { name: "retry" }));
    await waitFor(() => expect(audioAttempts).toBe(2));
    await waitFor(() => expect(videoAttempts).toBe(2));
    mediaPicker = screen.getAllByRole("combobox")[1];
    await user.click(mediaPicker);
    expect(await screen.findByText("source-audio.mp3")).toBeVisible();
    expect(await screen.findByText("source-video.mp4")).toBeVisible();
    await user.keyboard("{Escape}");

    await user.click(screen.getByRole("button", { name: "retry" }));
    await waitFor(() => expect(audioAttempts).toBe(3));
    await waitFor(() => expect(videoAttempts).toBe(3));
    mediaPicker = screen.getAllByRole("combobox")[1];
    await user.click(mediaPicker);
    expect(screen.queryByText("source-audio.mp3")).not.toBeInTheDocument();
    expect(await screen.findByText("source-video.mp4")).toBeVisible();
  });

  it("keeps a successful video picker result when the audio picker fails", async () => {
    global.fetch = jest.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("surface=picker") && url.includes("kind=audio")) {
        return Promise.resolve(
          jsonResponse({ error: "audio unavailable" }, 500)
        );
      }
      if (url.includes("surface=picker") && url.includes("kind=video")) {
        return Promise.resolve(
          jsonResponse({
            assets: [
              {
                id: "video-picker-result",
                workspaceId: "workspace-1",
                kind: "video",
                source: "uploaded",
                status: "complete",
                fileName: "video-picker-result.mp4",
                url: "https://storage.example.com/video-picker-result.mp4",
              },
            ],
          })
        );
      }
      return Promise.resolve(jsonResponse({ assets: [] }));
    }) as never;
    const user = userEvent.setup();

    render(
      <CreativeAssetsWorkspace
        workspaceId="workspace-1"
        higgsfieldConfigured
        elevenLabsConfigured
      />
    );
    fireEvent.change(screen.getByTestId("studio-composer-input"), {
      target: { value: "@Voice " },
    });
    expect(await screen.findByText("ElevenLabs action")).toBeVisible();
    await user.click(screen.getByRole("combobox"));
    await user.click(screen.getByRole("option", { name: "Transcript" }));

    const mediaPicker = screen.getAllByRole("combobox")[1];
    expect(mediaPicker).toBeEnabled();
    await user.click(mediaPicker);
    expect(await screen.findByText("video-picker-result.mp4")).toBeVisible();
  });

  it("clears workspace A assets and selections when workspace B fails to load", async () => {
    const workspaceAAsset = {
      id: "workspace-a-image",
      workspaceId: "workspace-a",
      kind: "image",
      source: "uploaded",
      status: "complete",
      fileName: "workspace-a-image.jpg",
      url: "https://storage.example.com/workspace-a-image.jpg",
    };
    global.fetch = jest.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("workspace-b/assets")) {
        return Promise.resolve(
          jsonResponse({ error: "workspace B failed" }, 500)
        );
      }
      if (url.includes("workspace-a/assets")) {
        return Promise.resolve(jsonResponse({ assets: [workspaceAAsset] }));
      }
      return Promise.resolve(jsonResponse({ assets: [] }));
    }) as never;
    const { rerender } = render(
      <CreativeAssetsWorkspace workspaceId="workspace-a" higgsfieldConfigured />
    );

    switchToLibraryTab();
    expect(await screen.findByText("workspace-a-image.jpg")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Use for video" }));
    switchToStudioTab();
    expect(
      (await screen.findByTestId("video-source-dropzone")).querySelector("img")
    ).toHaveAttribute("src", workspaceAAsset.url);

    rerender(
      <CreativeAssetsWorkspace workspaceId="workspace-b" higgsfieldConfigured />
    );

    switchToLibraryTab();
    expect(screen.queryByText("workspace-a-image.jpg")).not.toBeInTheDocument();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "assetsLoadFailed"
    );
    expect(screen.queryByText("workspace-a-image.jpg")).not.toBeInTheDocument();
  });

  it("resets provider availability and quota before the next workspace request settles", async () => {
    let rejectWorkspaceB!: (error: Error) => void;
    const workspaceBRequest = new Promise<Response>((_, reject) => {
      rejectWorkspaceB = reject;
    });
    global.fetch = jest.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("workspace-b/assets")) return workspaceBRequest;
      return Promise.resolve(jsonResponse({ assets: [] }));
    }) as never;

    const { rerender } = render(
      <CreativeAssetsWorkspace
        workspaceId="workspace-a"
        higgsfieldConfigured
        generationProvider="google"
        freeGenerations={{
          configured: true,
          limit: 10,
          used: 10,
          remaining: 0,
        }}
        elevenLabsConfigured
        wanAvatarConfigured
        wanMorphConfigured
        happyHorseConfigured
        alibabaImageConfigured
      />
    );
    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining("workspace-a/assets?"),
        expect.anything()
      )
    );

    rerender(
      <CreativeAssetsWorkspace
        workspaceId="workspace-b"
        higgsfieldConfigured={false}
        higgsfieldDisabledReason="server_unconfigured"
      />
    );

    expect(screen.getByTestId("generation-source-alert")).toHaveTextContent(
      "Image generation unavailable"
    );
    expect(screen.getByTestId("generation-source-alert")).not.toHaveTextContent(
      "The {limit} free creative generations"
    );
    expect(screen.getByTestId("studio-composer-generate")).toBeDisabled();
    fireEvent.change(screen.getByTestId("studio-composer-input"), {
      target: { value: "@Voice New workspace voiceover" },
    });
    expect(
      await screen.findByText("Connect ElevenLabs to use voice tools")
    ).toBeVisible();

    rejectWorkspaceB(new Error("workspace B unavailable"));
    switchToLibraryTab();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "assetsLoadFailed"
    );
    expect(
      screen.queryByText("The {limit} free creative generations")
    ).toBeNull();
  });

  it.each([0, 10])(
    "asks for customer ElevenLabs credentials regardless of %s legacy preview uses",
    async used => {
      render(
        <CreativeAssetsWorkspace
          workspaceId="workspace-1"
          elevenLabsConfigured={false}
          higgsfieldConfigured={false}
          freeGenerations={{
            configured: true,
            limit: 10,
            used,
            remaining: 10 - used,
          }}
        />
      );
      fireEvent.change(screen.getByTestId("studio-composer-input"), {
        target: { value: "@Voice A short voiceover" },
      });
      expect(
        await screen.findByText(
          "Connect your ElevenLabs API key in Settings > Integrations. Provider charges are billed to your account."
        )
      ).toBeVisible();
      expect(screen.getByTestId("studio-composer-generate")).toBeDisabled();
    }
  );

  it("preserves same-workspace assets when a filtered library request fails", async () => {
    const existingAsset = {
      id: "same-workspace-asset",
      workspaceId: "workspace-1",
      kind: "image",
      source: "uploaded",
      status: "complete",
      fileName: "same-workspace-asset.jpg",
      url: "https://storage.example.com/same-workspace-asset.jpg",
    };
    global.fetch = jest.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("surface=picker")) {
        return Promise.resolve(jsonResponse({ assets: [] }));
      }
      if (url.includes("kind=video")) {
        return Promise.resolve(jsonResponse({ error: "video failed" }, 500));
      }
      return Promise.resolve(jsonResponse({ assets: [existingAsset] }));
    }) as never;
    const user = userEvent.setup();

    renderWorkspace();
    switchToLibraryTab();
    expect(await screen.findByText("same-workspace-asset.jpg")).toBeVisible();
    await user.click(screen.getByRole("combobox", { name: "mediaKind" }));
    await user.click(screen.getByRole("option", { name: "Videos" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "assetsLoadFailed"
    );
    expect(screen.getByText("same-workspace-asset.jpg")).toBeVisible();
  });

  it("renders a persistent retry action after library loading fails", async () => {
    let mainAttempts = 0;
    global.fetch = jest.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/assets?") && !url.includes("surface=picker")) {
        mainAttempts += 1;
        return Promise.resolve(
          mainAttempts === 1
            ? jsonResponse({ error: "nope" }, 500)
            : jsonResponse({ assets: [] })
        );
      }
      return Promise.resolve(jsonResponse({ assets: [] }));
    }) as never;
    const user = userEvent.setup();

    renderWorkspace();
    switchToLibraryTab();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "assetsLoadFailed"
    );
    const retry = screen.getByRole("button", { name: "retry" });
    expect(retry).toBeEnabled();
    await user.click(retry);
    await waitFor(() => expect(mainAttempts).toBe(2));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows a translated toast when copying an asset URL fails", async () => {
    const writeText = jest.fn().mockRejectedValue(new Error("blocked"));
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    global.fetch = jest.fn(() =>
      Promise.resolve(
        jsonResponse({
          assets: [
            {
              id: "copy-failure",
              workspaceId: "workspace-1",
              kind: "image",
              source: "uploaded",
              status: "complete",
              fileName: "copy-me.png",
              url: "https://storage.example.com/copy-me.png",
            },
          ],
        })
      )
    ) as never;
    renderWorkspace();
    switchToLibraryTab();
    await screen.findByText("copy-me.png");
    const copyUrl = screen.getByRole("button", { name: "Copy URL" });
    expect(copyUrl).toBeEnabled();
    fireEvent.click(copyUrl);

    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(toast.error).toHaveBeenCalledWith("assetUrlCopyFailed");
  });

  it("uses translated status and relative-age labels for asset cards", async () => {
    global.fetch = jest.fn(() =>
      Promise.resolve(
        jsonResponse({
          assets: [
            {
              id: "localized-asset",
              workspaceId: "workspace-1",
              kind: "video",
              source: "uploaded",
              status: "in_progress",
              fileName: "localized-video.mp4",
              createdAt: new Date(Date.now() - 7 * 60_000).toISOString(),
            },
          ],
        })
      )
    ) as never;

    renderWorkspace();
    switchToLibraryTab();

    expect(await screen.findByText("localized-video.mp4")).toBeVisible();
    expect(screen.getAllByText("Processing").length).toBeGreaterThan(0);
    expect(screen.getByText("minutesAgo")).toBeVisible();
  });
});
