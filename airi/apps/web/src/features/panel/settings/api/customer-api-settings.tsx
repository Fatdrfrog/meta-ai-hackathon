"use client";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { ApiKeysCard } from "./api-keys-card";
import { WebhooksCard } from "./webhooks-card";

export function CustomerApiSettings({ workspaceId }: { workspaceId: string }) {
  const t = useTranslations("CustomerApiSettings");
  const [tab, setTab] = useState("keys");
  return (
    <Tabs value={tab} onValueChange={setTab} className="min-w-0 gap-4">
      <TabsList aria-label={t("title")}>
        <TabsTrigger value="keys">{t("keysTitle")}</TabsTrigger>
        <TabsTrigger value="webhooks">{t("webhooksTitle")}</TabsTrigger>
      </TabsList>
      <TabsContent value="keys" forceMount hidden={tab !== "keys"}>
        <ApiKeysCard workspaceId={workspaceId} />
      </TabsContent>
      <TabsContent value="webhooks" forceMount hidden={tab !== "webhooks"}>
        <WebhooksCard workspaceId={workspaceId} />
      </TabsContent>
    </Tabs>
  );
}
