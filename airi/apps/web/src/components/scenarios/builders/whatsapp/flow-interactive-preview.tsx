"use client";

import { Button } from "@/components/ui/button";
import { SimulationFlowForm } from "../../view/preview/simulation-flow-form";
import type { WhatsAppFlowConfig } from "@icecore/scenario-contracts";
import { RotateCcw } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState, type CSSProperties } from "react";
import type { FlowJsonPreview } from "./flow-json-preview";
import { WHATSAPP_ACTION_BUTTON_COLOR } from "./action-colors";

/** Editor test session only; its submission never sends a message or saves an asset. */
export function FlowInteractivePreview({
  config,
  initialScreenId,
  preview,
  disabled = false,
}: {
  config: WhatsAppFlowConfig;
  initialScreenId?: string;
  preview?: FlowJsonPreview;
  disabled?: boolean;
}) {
  // Provider metadata does not change the local form or its test answers.
  const sessionConfig = { ...config };
  delete sessionConfig.metaFlowId;
  delete sessionConfig.metaFlowName;
  delete sessionConfig.metaFlowStatus;
  const sessionKey = JSON.stringify([
    sessionConfig,
    initialScreenId,
    preview?.componentsByScreen,
  ]);
  return (
    <FlowInteractivePreviewSession
      key={sessionKey}
      config={sessionConfig}
      initialScreenId={initialScreenId}
      preview={preview}
      disabled={disabled}
    />
  );
}

function FlowInteractivePreviewSession({
  config,
  initialScreenId,
  preview,
  disabled,
}: {
  config: WhatsAppFlowConfig;
  initialScreenId?: string;
  preview?: FlowJsonPreview;
  disabled: boolean;
}) {
  const t = useTranslations("Scenarios");
  const [result, setResult] = useState<Record<string, unknown> | null>(null);
  const [revision, setRevision] = useState(0);
  return (
    <div className="mx-auto w-full min-w-0 max-w-[340px] space-y-3">
      <div
        className="min-h-64 overflow-hidden rounded-[24px] bg-background p-4 shadow-[0_2px_14px_rgba(0,0,0,0.08)]"
        style={
          {
            "--primary": WHATSAPP_ACTION_BUTTON_COLOR,
            "--ring": WHATSAPP_ACTION_BUTTON_COLOR,
          } as CSSProperties
        }
      >
        <SimulationFlowForm
          key={revision}
          config={config}
          initialScreenId={initialScreenId}
          preview={preview}
          enabled={!disabled}
          onSubmit={setResult}
          onComplete={setResult}
        />
      </div>
      {result ? (
        <div className="space-y-2">
          <p role="status" className="text-sm font-medium">
            {t("flowAuthoring.previewCompleted")}
          </p>
          <details className="rounded-lg bg-muted/35 p-3">
            <summary className="cursor-pointer text-xs font-medium">
              {t("flowAuthoring.testResult")}
            </summary>
            <pre className="mt-2 whitespace-pre-wrap break-all text-xs">
              {JSON.stringify(result, null, 2)}
            </pre>
          </details>
        </div>
      ) : null}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="w-full text-xs text-muted-foreground"
        disabled={disabled}
        onClick={() => {
          setResult(null);
          setRevision(current => current + 1);
        }}
      >
        <RotateCcw className="size-3.5" />
        {t("flowAuthoring.restartPreview")}
      </Button>
    </div>
  );
}
