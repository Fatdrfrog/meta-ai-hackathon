"use client";

import { useState, useCallback } from "react";
import { useParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  CardFooter,
} from "@/components/ui/card";
import { TagInput } from "@/components/ui/tag-input";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";

export function AiContextManager({
  initialTags,
  readOnly = false,
}: {
  initialTags: string[];
  readOnly?: boolean;
}) {
  const params = useParams();
  const workspaceId = params.workspaceId as string;
  const [tags, setTags] = useState(initialTags);
  const [savedTags, setSavedTags] = useState(initialTags);
  const [isLoading, setIsLoading] = useState(false);
  const t = useTranslations("AiContextManager");

  const predefinedSuggestions = [
    t("salesGrowth"),
    t("customerRetention"),
    t("competitorAnalysis"),
    t("productFeedback"),
    t("serviceQuality"),
  ];

  const handleSaveChanges = useCallback(async () => {
    if (readOnly) return;
    setIsLoading(true);
    try {
      const response = await fetch("/api/company-context", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tags, workspaceId }),
      });

      if (!response.ok) {
        const result = await response.json();
        throw new Error(result.error || t("failedToSave"));
      }

      toast.success(t("contextUpdated"));
      setSavedTags(tags);
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : t("unknownError");
      toast.error(errorMessage);
    } finally {
      setIsLoading(false);
    }
  }, [tags, t, workspaceId, readOnly]);

  const hasChanges = JSON.stringify(tags) !== JSON.stringify(savedTags);

  return (
    <Card className="animate-in fade-in-50 duration-500">
      <CardHeader>
        <div className="flex items-start gap-4">
          <div className="flex-1">
            <CardTitle className="text-base">{t("title")}</CardTitle>
            <CardDescription className="mt-1">
              {t("description")}
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <TagInput
          disabled={isLoading || readOnly}
          value={tags}
          onChange={setTags}
          placeholder={t("placeholder")}
          suggestions={predefinedSuggestions}
        />
        {tags.length > 0 && (
          <div className="text-sm text-muted-foreground">
            {tags.length === 1
              ? t("tagsCountOne")
              : t("tagsCountOther", { count: tags.length })}
          </div>
        )}
      </CardContent>
      {!readOnly && (
        <CardFooter className="flex flex-wrap items-center gap-3 border-t pt-4">
          <Button
            onClick={handleSaveChanges}
            disabled={isLoading || !hasChanges}
            className="min-w-32"
          >
            {isLoading && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            {isLoading ? t("saving") : t("saveChanges")}
          </Button>
          {hasChanges && !isLoading && (
            <p className="text-xs text-muted-foreground">
              {t("unsavedChanges")}
            </p>
          )}
        </CardFooter>
      )}
    </Card>
  );
}
