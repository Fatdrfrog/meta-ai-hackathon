"use client";

import { loadRegisteredBusinessPhonesAudienceAction } from "@/features/panel/scenarios/actions";
import {
  getAiriScenarioGeneratorDraftStorageKey,
  normalizeAiriScenarioGeneratorDraft,
  type AiriScenarioGeneratorDraft,
} from "@/lib/airi-chats/scenario-generator-draft";
import type { RegisteredBusinessPhonesAudienceSummary } from "@/lib/campaign/bulk-campaign-contracts";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
} from "react";
import { useSyncedDraftValue } from "../nodes/draft-state";
import { ScenarioEditorDraftProvider } from "../view/editor-drafts";
import type { ScenarioAutomationHeaderActions } from "./use-scenario-view-signals";
import { ScenariosToolbar } from "./scenarios-toolbar";
import { ScenariosView } from "./scenarios-view";

type ScenariosWorkspaceProps = Omit<
  ComponentProps<typeof ScenariosView>,
  "onLoadingChange" | "onAutomationActionsChange" | "initialAiriCreateDraft"
> & {
  hasWhatsApp: boolean;
  /**
   * The server's allow-list answer for the registered-phones audience: false
   * skips loading it (the load would find it disabled).
   */
  registeredAudienceEnabled: boolean;
};

export function ScenariosWorkspace(props: ScenariosWorkspaceProps) {
  return (
    <ScenarioEditorDraftProvider key={props.workspaceId}>
      <ScenariosWorkspaceContent {...props} />
    </ScenarioEditorDraftProvider>
  );
}

function ScenariosWorkspaceContent({
  workspaceId,
  hasWhatsApp,
  registeredAudienceEnabled,
  registeredBusinessPhonesAudience = null,
  openAiriCreateOnMount = false,
  initialScenarioDetail = null,
  ...viewProps
}: ScenariosWorkspaceProps) {
  const [automationHeaderActions, setAutomationHeaderActions] =
    useState<ScenarioAutomationHeaderActions | null>(null);
  const [audience, setAudience] =
    useSyncedDraftValue<RegisteredBusinessPhonesAudienceSummary | null>(
      registeredBusinessPhonesAudience
    );
  // The server already answered the allow-list check, which includes the
  // WhatsApp connection; only an enabled workspace loads the audience.
  const skipsAudienceLoad =
    Boolean(registeredBusinessPhonesAudience) ||
    !hasWhatsApp ||
    !registeredAudienceEnabled;
  const audienceLoadStartedRef = useRef(skipsAudienceLoad);
  const audienceRequestIdRef = useRef(0);

  useEffect(() => {
    audienceLoadStartedRef.current = skipsAudienceLoad;
  }, [skipsAudienceLoad, workspaceId]);

  useEffect(() => {
    if (audienceLoadStartedRef.current) return;
    if (!hasWhatsApp || !registeredAudienceEnabled) return;
    audienceLoadStartedRef.current = true;
    const requestId = audienceRequestIdRef.current + 1;
    audienceRequestIdRef.current = requestId;
    void loadRegisteredBusinessPhonesAudienceAction(workspaceId)
      .then(result => {
        if (audienceRequestIdRef.current !== requestId) return;
        setAudience(result);
      })
      .catch(() => {
        if (audienceRequestIdRef.current !== requestId) return;
        setAudience(null);
      });
    return () => {
      audienceRequestIdRef.current += 1;
    };
  }, [hasWhatsApp, registeredAudienceEnabled, workspaceId, setAudience]);

  const initialAiriCreateDraft =
    useMemo<AiriScenarioGeneratorDraft | null>(() => {
      if (!openAiriCreateOnMount) return null;
      try {
        const raw = window.localStorage?.getItem(
          getAiriScenarioGeneratorDraftStorageKey(workspaceId)
        );
        const draft = raw
          ? normalizeAiriScenarioGeneratorDraft(JSON.parse(raw))
          : null;
        return draft?.workspaceId === workspaceId ? draft : null;
      } catch {
        return null;
      }
    }, [openAiriCreateOnMount, workspaceId]);

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <ScenariosToolbar actions={automationHeaderActions} />
      <div className="min-h-0 flex-1 overflow-hidden">
        <ScenariosView
          {...viewProps}
          key={workspaceId}
          workspaceId={workspaceId}
          registeredBusinessPhonesAudience={audience}
          onAutomationActionsChange={setAutomationHeaderActions}
          openAiriCreateOnMount={openAiriCreateOnMount}
          initialAiriCreateDraft={initialAiriCreateDraft}
          initialScenarioDetail={initialScenarioDetail}
        />
      </div>
    </div>
  );
}
