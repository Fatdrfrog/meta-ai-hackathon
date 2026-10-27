"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  MARKETING_TEMPLATE_CATEGORIES,
  listMarketingTemplates,
  type MarketingTemplate,
  type MarketingTemplateCategory,
} from "@/lib/creative-assets/marketing-templates";
import dynamic from "next/dynamic";
import type { ReferenceVideoReference } from "@/lib/creative-assets/reference-video/contracts";
import { memo, useMemo, useState } from "react";

import { AiriTemplateGrid } from "./creative-assets-airi-template-grid";
import type { MarketingTemplatesTranslationFn } from "./creative-assets-tiktok-inspiration";
import type { CreativeAsset } from "./creative-assets-workspace";

type Collection = "airi" | "tiktok";

const ReferenceVideoPlanDialog = dynamic(() =>
  import("./reference-video-plan-dialog").then(
    module => module.ReferenceVideoPlanDialog
  )
);

const loadTikTokInspiration = () =>
  import("./creative-assets-tiktok-inspiration");

const preloadTikTokInspiration = () => {
  void loadTikTokInspiration().catch(() => undefined);
};

const TikTokInspiration = dynamic(
  () =>
    loadTikTokInspiration().then(
      module => module.CreativeAssetsTikTokInspiration
    ),
  {
    loading: () => (
      <div
        className="grid grid-cols-1 gap-3 min-[360px]:grid-cols-2 sm:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5"
        aria-hidden="true"
      >
        {Array.from({ length: 4 }, (_, index) => (
          <div
            key={index}
            className="min-w-0 overflow-hidden rounded-xl border bg-card"
          >
            <Skeleton className="aspect-[9/14] rounded-none" />
            <div className="grid gap-2 p-3">
              <Skeleton className="h-3 w-4/5" />
              <Skeleton className="h-3 w-3/5" />
            </div>
          </div>
        ))}
      </div>
    ),
  }
);

function categoryLabel(
  category: MarketingTemplateCategory,
  t: MarketingTemplatesTranslationFn
) {
  switch (category) {
    case "all":
      return t("marketingTemplatesCategoryAll");
    case "ugc":
      return t("marketingTemplatesCategoryUgc");
    case "product":
      return t("marketingTemplatesCategoryProduct");
    case "avatar":
      return t("marketingTemplatesCategoryAvatar");
    case "voice":
      return t("marketingTemplatesCategoryVoice");
    case "story":
      return t("marketingTemplatesCategoryStory");
    default: {
      const _exhaustive: never = category;
      return _exhaustive;
    }
  }
}

function CreativeAssetsMarketingTemplatesContent({
  workspaceId,
  t,
  onApply,
  onAssetCreated,
}: {
  workspaceId: string;
  t: MarketingTemplatesTranslationFn;
  onApply: (template: MarketingTemplate) => void;
  onAssetCreated?: (asset: CreativeAsset) => void;
}) {
  const [collection, setCollection] = useState<Collection>("airi");
  const [tiktokActivated, setTikTokActivated] = useState(false);
  const [category, setCategory] = useState<MarketingTemplateCategory>("all");
  const [planner, setPlanner] = useState<{
    reference?: ReferenceVideoReference;
  } | null>(null);
  const templates = useMemo(() => listMarketingTemplates(category), [category]);

  const selectCollection = (value: string) => {
    const next = value as Collection;
    setCollection(next);
    if (next === "tiktok") setTikTokActivated(true);
  };

  return (
    <Card className="gap-4 py-4" data-testid="marketing-templates">
      <CardHeader className="flex min-w-0 flex-row flex-wrap items-end justify-between gap-3 px-4">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">
            {t("marketingTemplatesTitle")}
          </h2>
          <p className="text-xs text-muted-foreground">
            {t("marketingTemplatesDescription")}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setPlanner({})}
          >
            {t("referenceVideoOpenPlanner")}
          </Button>
          {collection === "airi" ? (
            <Badge variant="secondary" className="shrink-0 rounded-md">
              {t("marketingTemplatesCount", { count: templates.length })}
            </Badge>
          ) : null}
        </div>
      </CardHeader>

      <CardContent className="px-4">
        <Tabs
          value={collection}
          onValueChange={selectCollection}
          className="min-w-0 gap-3"
        >
          <TabsList className="grid h-auto w-full max-w-sm grid-cols-2">
            <TabsTrigger
              value="airi"
              className="min-w-0 whitespace-normal py-2 leading-tight"
            >
              <span>{t("marketingTemplatesCollectionAiri")}</span>
            </TabsTrigger>
            <TabsTrigger
              value="tiktok"
              className="min-w-0 whitespace-normal py-2 leading-tight"
              onPointerEnter={preloadTikTokInspiration}
              onFocus={preloadTikTokInspiration}
            >
              <span>{t("marketingTemplatesCollectionTikTok")}</span>
            </TabsTrigger>
          </TabsList>

          <TabsContent value="airi" className="space-y-3">
            <div className="flex flex-wrap gap-1.5">
              {MARKETING_TEMPLATE_CATEGORIES.map(item => (
                <Button
                  key={item}
                  type="button"
                  size="sm"
                  variant={item === category ? "default" : "outline"}
                  className="h-7 rounded-md px-2.5 text-[11px]"
                  onClick={() => setCategory(item)}
                  data-testid={`marketing-template-category-${item}`}
                >
                  {categoryLabel(item, t)}
                </Button>
              ))}
            </div>
            <AiriTemplateGrid templates={templates} t={t} onApply={onApply} />
          </TabsContent>

          <TabsContent
            value="tiktok"
            forceMount
            hidden={collection !== "tiktok"}
            className="data-[state=inactive]:hidden"
          >
            {tiktokActivated ? (
              <TikTokInspiration
                workspaceId={workspaceId}
                t={t}
                onUseReference={item =>
                  setPlanner({
                    reference: {
                      providerVideoId: item.reference.providerVideoId,
                      shareUrl: item.reference.shareUrl,
                      title: item.title.slice(0, 300),
                    },
                  })
                }
              />
            ) : null}
          </TabsContent>
        </Tabs>
      </CardContent>
      {planner ? (
        <ReferenceVideoPlanDialog
          workspaceId={workspaceId}
          open
          reference={planner?.reference}
          onOpenChange={open => {
            if (!open) setPlanner(null);
          }}
          t={t}
          onAssetCreated={onAssetCreated}
        />
      ) : null}
    </Card>
  );
}

export const CreativeAssetsMarketingTemplates = memo(
  function CreativeAssetsMarketingTemplates(props: {
    workspaceId: string;
    t: MarketingTemplatesTranslationFn;
    onApply: (template: MarketingTemplate) => void;
    onAssetCreated?: (asset: CreativeAsset) => void;
  }) {
    return (
      <CreativeAssetsMarketingTemplatesContent
        key={props.workspaceId}
        {...props}
      />
    );
  }
);
