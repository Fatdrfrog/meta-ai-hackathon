"use client";

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  normalizeFewShotExamples,
  normalizeTaxonomyLabels,
  type FewShotExample,
  type WorkspaceTaxonomy,
} from "@/lib/classifier/taxonomy";
import { Loader2, Plus, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";

interface TaxonomyManagerProps {
  workspaceId: string;
  initialTaxonomy: {
    labels?: string[];
    guidelines?: string | null;
    few_shots?: FewShotExample[] | null;
    confidence_threshold?: number | null;
  } | null;
  defaultTemplate: WorkspaceTaxonomy;
}

type Draft = {
  labels: string[];
  guidelines: string;
  fewShots: FewShotExample[];
  confidenceThreshold: string;
};

export function TaxonomyManager({
  workspaceId,
  initialTaxonomy,
  defaultTemplate,
}: TaxonomyManagerProps) {
  const t = useTranslations("TaxonomyManager");
  const defaults: Draft = {
    labels: normalizeTaxonomyLabels(defaultTemplate.labels),
    guidelines: defaultTemplate.guidelines ?? "",
    fewShots: defaultTemplate.fewShots ?? [],
    confidenceThreshold: String(defaultTemplate.confidenceThreshold ?? 0.7),
  };
  const [draft, setDraft] = useState<Draft>(() => ({
    labels: normalizeTaxonomyLabels(initialTaxonomy?.labels ?? defaults.labels),
    guidelines: initialTaxonomy?.guidelines ?? defaults.guidelines,
    fewShots: initialTaxonomy?.few_shots ?? defaults.fewShots,
    confidenceThreshold: String(
      initialTaxonomy?.confidence_threshold ?? defaults.confidenceThreshold
    ),
  }));
  const [savedDraft, setSavedDraft] = useState<Draft | null>(
    initialTaxonomy ? draft : null
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const dirty = JSON.stringify(draft) !== JSON.stringify(savedDraft);
  const update = (next: Partial<Draft>) => {
    setDraft(current => ({ ...current, ...next }));
    setError(null);
    setSuccess(false);
  };
  const updateExample = (index: number, patch: Partial<FewShotExample>) =>
    update({
      fewShots: draft.fewShots.map((example, i) =>
        i === index ? { ...example, ...patch } : example
      ),
    });

  const handleSave = async () => {
    const cleanedLabels = draft.labels
      .map(label => label.trim())
      .filter(Boolean);
    if (!cleanedLabels.length) {
      setError(t("validation.minLabels"));
      return;
    }
    if (
      new Set(cleanedLabels.map(label => label.toLowerCase())).size !==
      cleanedLabels.length
    ) {
      setError(t("validation.duplicateLabels"));
      return;
    }
    const confidence = Number(draft.confidenceThreshold);
    if (
      !draft.confidenceThreshold.trim() ||
      !Number.isFinite(confidence) ||
      confidence < 0 ||
      confidence > 1
    ) {
      setError(t("validation.confidence"));
      return;
    }
    const labels = normalizeTaxonomyLabels(cleanedLabels);
    const examples = draft.fewShots.filter(
      example => example.text.trim() || example.label.trim()
    );
    if (
      examples.some(
        example =>
          !example.text.trim() ||
          !labels.some(
            label => label.toLowerCase() === example.label.trim().toLowerCase()
          )
      )
    ) {
      setError(t("validation.examples"));
      return;
    }
    if (examples.length > 24) {
      setError(t("validation.maxExamples"));
      return;
    }
    const fewShots = normalizeFewShotExamples(examples, labels);
    const nextDraft = {
      labels,
      guidelines: draft.guidelines.trim(),
      fewShots,
      confidenceThreshold: String(confidence),
    };
    setSaving(true);
    setError(null);
    setSuccess(false);
    try {
      const response = await fetch("/api/taxonomies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspace_id: workspaceId,
          labels,
          guidelines: nextDraft.guidelines,
          few_shots: fewShots,
          confidence_threshold: confidence,
          version: `v${Date.now()}`,
        }),
      });
      const result = await response.json();
      if (!response.ok || result.ok !== true || !result.id)
        throw new Error(t("saveFailed"));
      setDraft(nextDraft);
      setSavedDraft(nextDraft);
      setSuccess(true);
      toast.success(t("toast.saved"));
    } catch {
      setError(t("saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <fieldset disabled={saving} className="min-w-0 space-y-4">
        <Card>
          <CardContent className="space-y-5 pt-5">
            <div className="space-y-3">
              <div>
                <h2 className="text-base font-medium">
                  {t("classificationLabels")}
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  {t("labelsDescription")}
                </p>
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                {draft.labels.map((label, index) => (
                  <div key={index} className="flex min-w-0 gap-1">
                    <Input
                      aria-label={t("labelPlaceholder", { number: index + 1 })}
                      value={label}
                      onChange={event =>
                        update({
                          labels: draft.labels.map((value, i) =>
                            i === index ? event.target.value : value
                          ),
                        })
                      }
                      className="min-w-0"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={t("removeLabel", { number: index + 1 })}
                      disabled={draft.labels.length <= 1}
                      onClick={() =>
                        update({
                          labels: draft.labels.filter((_, i) => i !== index),
                        })
                      }
                    >
                      <X className="size-4" />
                    </Button>
                  </div>
                ))}
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => update({ labels: [...draft.labels, ""] })}
              >
                <Plus className="size-4" />
                {t("addLabel")}
              </Button>
            </div>
            <div className="space-y-2 border-t pt-4">
              <Label htmlFor="taxonomy-guidelines">{t("guidelines")}</Label>
              <Textarea
                id="taxonomy-guidelines"
                value={draft.guidelines}
                onChange={event => update({ guidelines: event.target.value })}
                placeholder={t("guidelinesPlaceholder")}
                rows={3}
              />
            </div>
          </CardContent>
        </Card>
        <Accordion type="multiple" className="rounded-lg border px-4">
          <AccordionItem value="examples">
            <AccordionTrigger>
              {t("fewShotTitle")}{" "}
              <span className="ml-auto mr-3 text-xs text-muted-foreground">
                {draft.fewShots.length}
              </span>
            </AccordionTrigger>
            <AccordionContent className="space-y-3">
              <p className="text-sm text-muted-foreground">
                {t("fewShotDescription")}
              </p>
              {draft.fewShots.map((example, index) => (
                <div key={index} className="space-y-3 rounded-md border p-3">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium">
                      {t("example", { number: index + 1 })}
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={t("removeExample", { number: index + 1 })}
                      onClick={() =>
                        update({
                          fewShots: draft.fewShots.filter(
                            (_, i) => i !== index
                          ),
                        })
                      }
                    >
                      <X className="size-4" />
                    </Button>
                  </div>
                  <Textarea
                    aria-label={t("exampleText")}
                    value={example.text}
                    onChange={event =>
                      updateExample(index, { text: event.target.value })
                    }
                    placeholder={t("exampleTextPlaceholder")}
                    rows={2}
                  />
                  <Select
                    value={example.label}
                    onValueChange={label => updateExample(index, { label })}
                  >
                    <SelectTrigger
                      className="w-full"
                      aria-label={t("expectedLabel")}
                    >
                      <SelectValue placeholder={t("chooseLabel")} />
                    </SelectTrigger>
                    <SelectContent>
                      {Array.from(
                        new Set(normalizeTaxonomyLabels(draft.labels))
                      ).map(label => (
                        <SelectItem key={label} value={label}>
                          {label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ))}
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={draft.fewShots.length >= 24}
                onClick={() =>
                  update({
                    fewShots: [...draft.fewShots, { text: "", label: "" }],
                  })
                }
              >
                <Plus className="size-4" />
                {t("addExample")}
              </Button>
            </AccordionContent>
          </AccordionItem>
          <AccordionItem value="confidence" className="border-b-0">
            <AccordionTrigger>{t("confidenceThreshold")}</AccordionTrigger>
            <AccordionContent className="space-y-2">
              <Input
                id="confidence"
                aria-label={t("confidenceThreshold")}
                type="number"
                min="0"
                max="1"
                step="0.05"
                value={draft.confidenceThreshold}
                onChange={event =>
                  update({ confidenceThreshold: event.target.value })
                }
                className="w-28"
              />
              <p className="text-sm text-muted-foreground">
                {t("confidenceDescription")}
              </p>
            </AccordionContent>
          </AccordionItem>
        </Accordion>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              if (confirm(t("validation.resetConfirm"))) update(defaults);
            }}
          >
            {t("resetToDefaults")}
          </Button>
          <div className="flex items-center gap-3">
            {success && (
              <p role="status" className="text-sm text-muted-foreground">
                {t("toast.saved")}
              </p>
            )}
            <Button
              type="button"
              disabled={!dirty || saving}
              onClick={handleSave}
            >
              {saving && <Loader2 className="size-4 animate-spin" />}
              {saving ? t("saving") : t("saveTaxonomy")}
            </Button>
          </div>
        </div>
      </fieldset>
    </div>
  );
}
