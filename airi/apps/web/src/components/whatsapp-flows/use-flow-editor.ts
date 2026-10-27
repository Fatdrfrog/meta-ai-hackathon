"use client";

import { generateFlowJson } from "@/components/scenarios/builders/whatsapp/flow-json-generator";
import { parseFlowJsonToWhatsAppFlowConfig } from "@/components/scenarios/builders/whatsapp/flow-json-parser";
import { validateWhatsAppFlowConfig } from "@/components/scenarios/builders/whatsapp/flow-validation";
import { formatFlowValidationIssue } from "@/components/scenarios/builders/whatsapp/flow-validation-messages";
import {
  getFlowTemplate,
  type FlowTemplateId,
} from "@/components/scenarios/builders/whatsapp/templates";
import type { WhatsAppFlowConfig } from "@icecore/scenario-contracts";
import { WHATSAPP_FLOW_LIMITS } from "@icecore/shared/types/whatsapp-flows";
import { useTransitionOwnerKey } from "@/hooks/use-transition-owner-key";
import {
  fetchWhatsAppFlowDetails,
  updateWhatsAppFlow,
  type WhatsAppFlowSummary,
} from "@/lib/whatsapp/flows/client";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";

export type WhatsAppFlowEditorProps = {
  workspaceId: string;
  sourceId: string;
  flow: WhatsAppFlowSummary;
  onClose: () => void;
  onSaved: (flow?: WhatsAppFlowSummary) => void;
};

function validationLines(issues: unknown[] | undefined): string[] {
  return (issues ?? []).flatMap(issue => {
    if (!issue || typeof issue !== "object") return [];
    const record = issue as Record<string, unknown>;
    const message =
      typeof record.message === "string"
        ? record.message
        : typeof record.error === "string"
          ? record.error
          : typeof record.error_type === "string"
            ? record.error_type
            : JSON.stringify(record);
    const paths = Array.isArray(record.pointers)
      ? record.pointers.flatMap(pointer =>
          pointer && typeof pointer.path === "string" ? [pointer.path] : []
        )
      : [];
    const location =
      paths.join(", ") ||
      (typeof record.line_start === "number" ? `L${record.line_start}` : "");
    return message ? [`${location ? `${location}: ` : ""}${message}`] : [];
  });
}

export function useWhatsAppFlowEditor({
  workspaceId,
  sourceId,
  flow,
  onSaved,
  onClose,
}: WhatsAppFlowEditorProps) {
  const t = useTranslations("WhatsAppFlows");
  const tScenarios = useTranslations("Scenarios");
  const loadFailedMessage = t("editor.loadFailed");
  const ownerKey = useTransitionOwnerKey(
    JSON.stringify([workspaceId, sourceId, flow.id])
  );
  const isManaged = Boolean(flow.managedArtifact);
  const latestOwner = useRef(ownerKey);
  latestOwner.current = ownerKey;
  const mounted = useRef(false);
  const sequence = useRef(0);
  const inFlight = useRef(false);
  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"save" | "publish" | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [assetError, setAssetError] = useState<string | null>(null);
  const [details, setDetails] = useState(flow);
  const [name, setName] = useState(flow.name ?? "");
  const [categories, setCategories] = useState(flow.categories ?? ["OTHER"]);
  const [source, setSource] = useState("");
  const [saved, setSaved] = useState({
    source: "",
    name: flow.name ?? "",
    categories: flow.categories ?? ["OTHER"],
  });
  const [issues, setIssues] = useState<string[]>([]);
  const [mode, setMode] = useState<"visual" | "json">("json");
  const [visualDraft, setVisualDraft] = useState<WhatsAppFlowConfig | null>(
    null
  );
  const [reload, setReload] = useState(0);
  const parsed = useMemo(() => {
    try {
      const json: unknown = JSON.parse(source);
      return json && typeof json === "object" && !Array.isArray(json)
        ? (json as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }, [source]);
  const parsedVisualConfig = useMemo(
    () =>
      parsed
        ? parseFlowJsonToWhatsAppFlowConfig({
            flowJson: parsed,
            flowId: flow.id,
            flowName: name,
            flowStatus: details.status,
          })
        : null,
    [parsed, flow.id, name, details.status]
  );
  const visualConfig = mode === "visual" ? visualDraft : parsedVisualConfig;
  // Endpoint branch policy also lives on the server, outside Flow JSON.
  const canEditVisually = Boolean(
    visualConfig && visualConfig.flowNavigationMode !== "data_endpoint"
  );
  const readOnly =
    details.status !== "DRAFT" || Boolean(details.managedArtifact) || isManaged;
  const dirty =
    source !== saved.source ||
    name.trim() !== saved.name ||
    JSON.stringify([...categories].sort()) !==
      JSON.stringify([...saved.categories].sort());

  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    const request = ++sequence.current;
    inFlight.current = false;
    setLoading(true);
    setLoadError(null);
    const owns = () =>
      mounted.current &&
      latestOwner.current === ownerKey &&
      sequence.current === request &&
      !controller.signal.aborted;
    void fetchWhatsAppFlowDetails({
      workspaceId,
      sourceId,
      flowId: flow.id,
      includeJson: true,
      signal: controller.signal,
    })
      .then(result => {
        if (!owns()) return;
        if (!result.ok || !result.data?.flow)
          throw new Error(result.data?.error || loadFailedMessage);
        const remote = result.data.flow;
        const json =
          result.data.flowJson == null
            ? ""
            : JSON.stringify(result.data.flowJson, null, 2);
        const remoteName = remote.name ?? "";
        const remoteCategories = remote.categories?.length
          ? remote.categories
          : ["OTHER"];
        setDetails(remote);
        setSource(json);
        setName(remoteName);
        setCategories(remoteCategories);
        setSaved({
          source: json,
          name: remoteName,
          categories: remoteCategories,
        });
        setIssues(validationLines(remote.validation_errors));
        setAssetError(result.data.flowJsonError ?? null);
        setError(null);
        const config = parseFlowJsonToWhatsAppFlowConfig({
          flowJson: result.data.flowJson,
          flowId: flow.id,
        });
        setVisualDraft(
          config && config.flowNavigationMode !== "data_endpoint"
            ? config
            : null
        );
        setMode(
          config &&
            config.flowNavigationMode !== "data_endpoint" &&
            remote.status === "DRAFT" &&
            !remote.managedArtifact &&
            !isManaged
            ? "visual"
            : "json"
        );
      })
      .catch(failure => {
        if (owns())
          setLoadError(
            failure instanceof Error ? failure.message : loadFailedMessage
          );
      })
      .finally(() => {
        if (owns()) setLoading(false);
      });
    return () => {
      mounted.current = false;
      controller.abort();
      sequence.current += 1;
    };
  }, [
    workspaceId,
    sourceId,
    flow.id,
    ownerKey,
    reload,
    loadFailedMessage,
    isManaged,
  ]);

  const changeConfig = (config: WhatsAppFlowConfig) => {
    if (readOnly || busy) return;
    setVisualDraft(config);
    setSource(JSON.stringify(generateFlowJson(config), null, 2));
    setError(null);
  };
  const selectTemplate = (id: FlowTemplateId) => {
    const template = getFlowTemplate(id);
    if (!template || readOnly || busy) return;
    changeConfig({
      templateId: id,
      screens: structuredClone(template.screens),
      ctaText: template.defaultCtaText,
      flowUiLocale: "en",
    });
    setMode("visual");
  };
  const close = () => {
    if (inFlight.current) return;
    if (!dirty || window.confirm(t("editor.discardConfirm"))) onClose();
  };
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (dirty) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [dirty]);

  const mutate = async (operation: "save" | "publish") => {
    if (readOnly || inFlight.current || loading || loadError) return;
    if (
      !parsed ||
      typeof parsed.version !== "string" ||
      !Array.isArray(parsed.screens) ||
      parsed.screens.length === 0
    ) {
      setError(t("editor.invalidJson"));
      return;
    }
    if (new Blob([source]).size > WHATSAPP_FLOW_LIMITS.JSON_ASSET_MAX_BYTES) {
      setError(t("editor.tooLarge"));
      return;
    }
    if (
      !name.trim() ||
      name.trim().length > WHATSAPP_FLOW_LIMITS.NAME_MAX_LENGTH ||
      categories.length === 0
    ) {
      setError(t("editor.categoriesRequired"));
      return;
    }
    if (operation === "publish" && (dirty || !saved.source || issues.length))
      return;
    if (operation === "save" && canEditVisually && visualConfig) {
      const validation = validateWhatsAppFlowConfig(visualConfig);
      if (!validation.isValid) {
        setIssues(
          validation.issues.map(issue =>
            formatFlowValidationIssue(issue, tScenarios)
          )
        );
        setError(t("editor.invalidJson"));
        return;
      }
    }
    const requestOwner = ownerKey;
    const request = ++sequence.current;
    const owns = () =>
      mounted.current &&
      latestOwner.current === requestOwner &&
      sequence.current === request;
    inFlight.current = true;
    setBusy(operation);
    setError(null);
    try {
      let remote = details;
      if (operation === "save") {
        const result = await updateWhatsAppFlow({
          workspaceId,
          sourceId,
          flowId: flow.id,
          operation: "update_json",
          flowJson: source,
        });
        if (!owns()) return;
        if (
          !result.ok ||
          !result.data?.success ||
          result.data.validation_errors?.length
        ) {
          setIssues(validationLines(result.data?.validation_errors));
          throw new Error(result.data?.error || t("editor.saveFailed"));
        }
        remote = { ...remote, ...result.data.flow };
        if (
          name.trim() !== saved.name ||
          JSON.stringify([...categories].sort()) !==
            JSON.stringify([...saved.categories].sort())
        ) {
          const metadata = await updateWhatsAppFlow({
            workspaceId,
            sourceId,
            flowId: flow.id,
            operation: "update",
            name: name.trim(),
            categories,
          });
          if (!owns()) return;
          if (!metadata.ok || !metadata.data?.success)
            throw new Error(metadata.data?.error || t("editor.saveFailed"));
          remote = { ...remote, ...metadata.data.flow };
        }
        remote = { ...remote, name: name.trim(), categories };
        setSaved({ source, name: name.trim(), categories: [...categories] });
        setIssues([]);
        setAssetError(null);
      } else {
        const result = await updateWhatsAppFlow({
          workspaceId,
          sourceId,
          flowId: flow.id,
          operation: "publish",
        });
        if (!owns()) return;
        if (
          !result.ok ||
          !result.data?.success ||
          result.data.flow?.status !== "PUBLISHED"
        ) {
          setIssues(validationLines(result.data?.validation_errors));
          throw new Error(result.data?.error || t("editor.publishFailed"));
        }
        remote = { ...remote, ...result.data.flow };
        setMode("json");
      }
      if (!owns()) return;
      setDetails(remote);
      onSavedRef.current(remote);
      toast.success(
        t(operation === "save" ? "editor.saved" : "editor.published")
      );
    } catch (failure) {
      if (owns())
        setError(
          failure instanceof Error
            ? failure.message
            : t(
                operation === "save"
                  ? "editor.saveFailed"
                  : "editor.publishFailed"
              )
        );
    } finally {
      if (owns()) {
        inFlight.current = false;
        setBusy(null);
      }
    }
  };
  const importFile = async (file: File) => {
    if (readOnly || busy) return;
    if (file.size > WHATSAPP_FLOW_LIMITS.JSON_ASSET_MAX_BYTES) {
      setError(t("editor.tooLarge"));
      return;
    }
    const requestOwner = ownerKey;
    const request = sequence.current;
    try {
      const json = await file.text();
      if (
        !mounted.current ||
        latestOwner.current !== requestOwner ||
        sequence.current !== request ||
        inFlight.current
      )
        return;
      const value: unknown = JSON.parse(json);
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error(t("editor.invalidJson"));
      setSource(json);
      setMode("json");
      setError(null);
    } catch {
      if (mounted.current && latestOwner.current === requestOwner)
        setError(t("editor.importFailed"));
    }
  };
  const exportFile = () => {
    const url = URL.createObjectURL(
      new Blob([source], { type: "application/json" })
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = "flow.json";
    link.click();
    URL.revokeObjectURL(url);
  };

  return {
    t,
    loading,
    busy,
    loadError,
    error,
    assetError,
    details,
    name,
    setName,
    categories,
    setCategories,
    source,
    setSource,
    parsed,
    visualConfig,
    canEditVisually,
    mode,
    setMode: (next: "visual" | "json") => {
      if (next === "visual") {
        if (
          !parsedVisualConfig ||
          parsedVisualConfig.flowNavigationMode === "data_endpoint"
        )
          return;
        setVisualDraft(parsedVisualConfig);
      }
      setMode(next);
    },
    readOnly,
    dirty,
    issues,
    close,
    changeConfig,
    selectTemplate,
    mutate,
    importFile,
    exportFile,
    retry: () => setReload(value => value + 1),
    canPublish:
      !readOnly &&
      !dirty &&
      Boolean(saved.source) &&
      issues.length === 0 &&
      !assetError,
  };
}
