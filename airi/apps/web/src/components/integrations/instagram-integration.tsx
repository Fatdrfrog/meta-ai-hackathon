"use client";

import {
  ConnectInstagramButton,
  ConnectInstagramViaFacebookButton,
} from "@/components/integrations/connect-buttons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Source, isInstagramSource } from "@/types/supabase";
import { AlertTriangle } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";

type InstagramInsight = {
  name?: string;
  values?: Array<{ value?: unknown }>;
};

function formatInstagramInsightValue(value: unknown): string | number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "boolean") return value ? "true" : "false";
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(
        ([, entryValue]) => entryValue !== null && entryValue !== undefined
      )
      .map(([key, entryValue]) => `${key}: ${String(entryValue)}`);
    return entries.length > 0 ? entries.join(", ") : 0;
  }
  return 0;
}

export const InstagramIntegration = ({
  source,
  workspaceId,
  connectionActionsDisabled = false,
}: {
  source?: Source;
  workspaceId?: string;
  connectionActionsDisabled?: boolean;
}) => {
  const t = useTranslations("InstagramIntegration");
  const [publishType, setPublishType] = useState<"image" | "video">("video");
  const [publishUrl, setPublishUrl] = useState("");
  const [publishCaption, setPublishCaption] = useState("");
  const [publishLoading, setPublishLoading] = useState(false);
  const [publishResult, setPublishResult] = useState<{
    mediaId?: string;
    permalink?: string;
  } | null>(null);

  const [insights, setInsights] = useState<InstagramInsight[]>([]);
  const [insightsLoading, setInsightsLoading] = useState(false);

  const loadInsights = async () => {
    if (!workspaceId) return;
    setInsightsLoading(true);
    try {
      const res = await fetch(
        `/api/sources/instagram/insights?workspaceId=${workspaceId}`
      );
      if (res.ok) {
        const data = (await res.json()) as { data?: unknown };
        setInsights(Array.isArray(data.data) ? data.data : []);
      }
    } catch (err) {
      console.error(err);
    } finally {
      setInsightsLoading(false);
    }
  };

  if (!source || !isInstagramSource(source)) {
    return (
      <div className="space-y-3">
        <p className="text-xs text-muted-foreground">
          {t("instagramNotConnected")}
        </p>
        <div className="flex flex-wrap gap-2">
          <ConnectInstagramViaFacebookButton
            workspaceId={workspaceId}
            label={t("connectViaFacebook")}
            disabled={connectionActionsDisabled}
          />
          <ConnectInstagramButton
            workspaceId={workspaceId}
            label={t("connectInstagram")}
            disabled={connectionActionsDisabled}
          />
        </div>
        <p className="text-[11px] text-muted-foreground">
          {t("connectionMethodHint")}
        </p>
      </div>
    );
  }

  // Type is narrowed to InstagramSource after the guard above
  const expiresAt = source.credentials.token_expires_at;
  let needsReconnection = false;
  let expiresInDays = 0;

  if (expiresAt) {
    const expirationDate = new Date(expiresAt);
    const now = new Date();
    const diffTime = expirationDate.getTime() - now.getTime();
    expiresInDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    if (expiresInDays <= 14) {
      needsReconnection = true;
    }
  } else {
    // No expiry date stored - might be old integration
    needsReconnection = false; // Don't show warning for legacy integrations
  }
  const isFacebookLogin = source.credentials.auth_method === "facebook_login";
  const authMethodLabel =
    source.credentials.auth_method === "facebook_login"
      ? t("connectionMethodFacebook")
      : source.credentials.auth_method === "instagram_business_login"
        ? t("connectionMethodInstagram")
        : source.credentials.auth_method || "";
  const username = (source.credentials.username || "").trim();
  const displayName = (source.credentials.name || "").trim();
  const accountType = (source.credentials.account_type || "").trim();
  const categoryName = (source.credentials.category_name || "").trim();
  const biography = (source.credentials.biography || "").trim();
  const website = (source.credentials.website || "").trim();
  const profilePictureUrl = (
    source.credentials.profile_picture_url || ""
  ).trim();
  const isVerified = source.credentials.is_verified === true;
  const followersCount =
    typeof source.credentials.followers_count === "number"
      ? source.credentials.followers_count
      : undefined;
  const followsCount =
    typeof source.credentials.follows_count === "number"
      ? source.credentials.follows_count
      : undefined;
  const mediaCount =
    typeof source.credentials.media_count === "number"
      ? source.credentials.media_count
      : undefined;
  const websiteHref = website
    ? website.startsWith("http://") || website.startsWith("https://")
      ? website
      : `https://${website}`
    : "";
  const hasProfileSnapshot = Boolean(
    profilePictureUrl ||
      username ||
      displayName ||
      accountType ||
      categoryName ||
      biography ||
      website ||
      typeof followersCount === "number" ||
      typeof followsCount === "number" ||
      typeof mediaCount === "number" ||
      isVerified
  );
  const formatCount = (count: number) => new Intl.NumberFormat().format(count);
  const grantedPermissionsRaw = String(
    source.credentials.granted_permissions || ""
  );
  const grantedPermissions = new Set(
    grantedPermissionsRaw
      .split(/[,\s]+/)
      .map(v => v.trim())
      .filter(Boolean)
  );
  const requiredPublishPermission =
    source.credentials.auth_method === "instagram_business_login"
      ? "instagram_business_content_publish"
      : "instagram_content_publish";
  const hasPublishPermission =
    grantedPermissions.size === 0 ||
    grantedPermissions.has(requiredPublishPermission);

  const handlePublishMedia = async () => {
    const mediaUrl = publishUrl.trim();
    if (!mediaUrl) {
      toast.error(t("publish.validationUrl"));
      return;
    }

    setPublishLoading(true);
    setPublishResult(null);

    try {
      const response = await fetch("/api/sources/instagram/publish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId,
          mediaType: publishType,
          mediaUrl,
          caption: publishCaption.trim(),
        }),
      });

      const payload = (await response.json().catch(() => ({}))) as {
        error?: string;
        publishedMediaId?: string;
        permalink?: string;
      };

      if (!response.ok) {
        throw new Error(payload.error || t("publish.failed"));
      }

      setPublishResult({
        mediaId: payload.publishedMediaId,
        permalink: payload.permalink,
      });
      toast.success(t("publish.success"));
    } catch (error) {
      toast.error((error as Error).message || t("publish.failed"));
    } finally {
      setPublishLoading(false);
    }
  };

  if (needsReconnection && expiresInDays >= 0) {
    return (
      <div className="space-y-3 rounded-xl bg-destructive/10 p-4">
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-destructive">
            <AlertTriangle className="h-4 w-4" />
            <h3 className="text-base font-semibold">
              {t("instagramReconnectTitle")}
            </h3>
          </div>
          <p className="text-xs text-destructive/90">
            {expiresInDays > 0
              ? t("instagramExpiresIn", { days: expiresInDays })
              : t("instagramExpired")}{" "}
            {t("instagramReconnectPrompt")}
          </p>
        </div>
        {isFacebookLogin ? (
          <ConnectInstagramViaFacebookButton
            workspaceId={workspaceId}
            label={t("reconnectViaFacebook")}
            disabled={connectionActionsDisabled}
          />
        ) : (
          <ConnectInstagramButton
            workspaceId={workspaceId}
            label={t("reconnectInstagram")}
            disabled={connectionActionsDisabled}
          />
        )}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-green-600 font-medium">
        {t("instagramConnected")}
      </p>
      <div className="space-y-5 rounded-xl bg-muted/30 p-4">
        <div className="text-[11px] text-muted-foreground uppercase tracking-wide font-medium">
          {t("businessProfile")}
        </div>
        {hasProfileSnapshot ? (
          <div className="space-y-3">
            <div className="flex items-start gap-3">
              {profilePictureUrl ? (
                <img
                  src={profilePictureUrl}
                  alt={displayName || username || "Instagram profile"}
                  className="h-12 w-12 shrink-0 rounded-full object-cover"
                />
              ) : (
                <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-background/80 text-sm font-semibold text-muted-foreground">
                  {(displayName || username || "IG").slice(0, 2).toUpperCase()}
                </div>
              )}
              <div className="min-w-0 space-y-1">
                <p className="text-sm font-semibold truncate">
                  {displayName || username || t("instagramConnected")}
                </p>
                <div className="flex flex-wrap gap-x-2 gap-y-1 text-xs text-muted-foreground">
                  {username && <span>@{username}</span>}
                  {accountType && (
                    <span>
                      {t("accountType")}: {accountType}
                    </span>
                  )}
                  {categoryName && (
                    <span>
                      {t("category")}: {categoryName}
                    </span>
                  )}
                  {isVerified && <span>{t("verified")}</span>}
                </div>
              </div>
            </div>

            {(typeof followersCount === "number" ||
              typeof followsCount === "number" ||
              typeof mediaCount === "number") && (
              <div className="grid grid-cols-3 gap-2">
                <div className="rounded-lg bg-background/70 p-2 text-center">
                  <div className="text-sm font-semibold">
                    {typeof followersCount === "number"
                      ? formatCount(followersCount)
                      : "-"}
                  </div>
                  <div className="text-[11px] text-muted-foreground">
                    {t("followers")}
                  </div>
                </div>
                <div className="rounded-lg bg-background/70 p-2 text-center">
                  <div className="text-sm font-semibold">
                    {typeof followsCount === "number"
                      ? formatCount(followsCount)
                      : "-"}
                  </div>
                  <div className="text-[11px] text-muted-foreground">
                    {t("following")}
                  </div>
                </div>
                <div className="rounded-lg bg-background/70 p-2 text-center">
                  <div className="text-sm font-semibold">
                    {typeof mediaCount === "number"
                      ? formatCount(mediaCount)
                      : "-"}
                  </div>
                  <div className="text-[11px] text-muted-foreground">
                    {t("posts")}
                  </div>
                </div>
              </div>
            )}

            <div className="space-y-1 text-xs">
              {displayName && (
                <p>
                  <span className="font-medium">{t("displayName")}</span>{" "}
                  {displayName}
                </p>
              )}
              {website && websiteHref && (
                <p className="min-w-0">
                  <span className="font-medium">{t("website")}</span>{" "}
                  <a
                    href={websiteHref}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary hover:underline break-all"
                  >
                    {website}
                  </a>
                </p>
              )}
              {biography && (
                <p className="leading-relaxed">
                  <span className="font-medium">{t("bio")}</span> {biography}
                </p>
              )}
            </div>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">{t("profilePending")}</p>
        )}

        <div className="space-y-1.5 rounded-lg bg-background/70 p-3">
          <div className="text-[11px] text-muted-foreground uppercase tracking-wide font-medium">
            {t("technicalDetails")}
          </div>
          <div className="text-xs">
            <span className="font-medium">{t("status")}</span>{" "}
            <span className="text-green-600">{t("statusConnected")}</span>
          </div>
          {source.credentials.instagram_business_account_id && (
            <div className="text-xs">
              <span className="font-medium">{t("accountId")}</span>{" "}
              <code className="text-[11px] bg-background px-1 py-0.5 rounded">
                {source.credentials.instagram_business_account_id}
              </code>
            </div>
          )}
          {source.credentials.instagram_scoped_id && (
            <div className="text-xs">
              <span className="font-medium">{t("scopedId")}</span>{" "}
              <code className="text-[11px] bg-background px-1 py-0.5 rounded">
                {source.credentials.instagram_scoped_id}
              </code>
            </div>
          )}
          {source.credentials.page_id && (
            <div className="text-xs">
              <span className="font-medium">{t("pageId")}</span>{" "}
              <code className="text-[11px] bg-background px-1 py-0.5 rounded">
                {source.credentials.page_id}
              </code>
            </div>
          )}
          {source.credentials.auth_method && (
            <div className="text-[11px] text-muted-foreground">
              {t("connectionMethod")}: {authMethodLabel}
            </div>
          )}
          <div className="text-[11px] text-muted-foreground">
            {t("publish.permissionLabel")}{" "}
            <code className="text-[11px] bg-background px-1 py-0.5 rounded">
              {requiredPublishPermission}
            </code>{" "}
            {grantedPermissions.size === 0 ? (
              <span className="text-muted-foreground">
                {t("publish.permissionUnknown")}
              </span>
            ) : hasPublishPermission ? (
              <span className="text-green-600">
                {t("publish.permissionOk")}
              </span>
            ) : (
              <span className="text-amber-600">
                {t("publish.permissionMissing")}
              </span>
            )}
          </div>
          {expiresAt && (
            <div className="text-[11px] text-muted-foreground">
              {t("tokenExpiresIn", { days: expiresInDays })}
            </div>
          )}
        </div>

        <div className="space-y-3">
          <div className="space-y-1">
            <h3 className="text-sm font-medium text-foreground">
              Account Insights
            </h3>
            <p className="text-xs text-muted-foreground">
              Instagram Business Insights (Reach, Impressions, Profile Views)
            </p>
          </div>
          <Button
            onClick={loadInsights}
            disabled={insightsLoading || connectionActionsDisabled}
            size="sm"
            variant="secondary"
          >
            {insightsLoading ? "Loading..." : "Load Insights"}
          </Button>
          {insights.length > 0 && (
            <div className="mt-4 grid grid-cols-1 gap-2">
              {insights.map((insight, idx) => (
                <div
                  key={idx}
                  className="flex items-center justify-between rounded-lg bg-background/70 px-3 py-2 text-sm"
                >
                  <span className="font-medium capitalize">
                    {(insight.name || "Insight").replace(/_/g, " ")}
                  </span>
                  <span>
                    {formatInstagramInsightValue(insight.values?.[0]?.value)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="space-y-3">
          <div className="space-y-1">
            <h3 className="text-sm font-medium text-foreground">
              {t("publish.title")}
            </h3>
            <p className="text-xs text-muted-foreground">
              {t("publish.description")}
            </p>
          </div>
          <div className="space-y-3 rounded-lg bg-background/70 p-4">
            <div className="space-y-1.5">
              <Label className="text-xs">{t("publish.mediaTypeLabel")}</Label>
              <div className="flex gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant={publishType === "image" ? "default" : "outline"}
                  onClick={() => setPublishType("image")}
                  disabled={connectionActionsDisabled}
                >
                  {t("publish.image")}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant={publishType === "video" ? "default" : "outline"}
                  onClick={() => setPublishType("video")}
                  disabled={connectionActionsDisabled}
                >
                  {t("publish.video")}
                </Button>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="ig-publish-url" className="text-xs">
                {t("publish.mediaUrlLabel")}
              </Label>
              <Input
                id="ig-publish-url"
                placeholder={t("publish.mediaUrlPlaceholder")}
                value={publishUrl}
                onChange={e => setPublishUrl(e.target.value)}
                disabled={connectionActionsDisabled}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="ig-publish-caption" className="text-xs">
                {t("publish.captionLabel")}
              </Label>
              <Textarea
                id="ig-publish-caption"
                placeholder={t("publish.captionPlaceholder")}
                value={publishCaption}
                onChange={e => setPublishCaption(e.target.value)}
                rows={3}
                disabled={connectionActionsDisabled}
              />
            </div>

            <Button
              type="button"
              size="sm"
              onClick={handlePublishMedia}
              disabled={
                connectionActionsDisabled ||
                publishLoading ||
                (grantedPermissions.size > 0 && !hasPublishPermission)
              }
            >
              {publishLoading ? t("publish.publishing") : t("publish.publish")}
            </Button>

            {grantedPermissions.size > 0 && !hasPublishPermission && (
              <p className="text-[11px] text-amber-600">
                {t("publish.permissionHint", {
                  permission: requiredPublishPermission,
                })}
              </p>
            )}

            {publishResult?.mediaId && (
              <div className="space-y-1 text-[11px] text-muted-foreground">
                <p>
                  {t("publish.resultMediaId")}{" "}
                  <code className="bg-background px-1 py-0.5 rounded">
                    {publishResult.mediaId}
                  </code>
                </p>
                {publishResult.permalink && (
                  <p>
                    {t("publish.resultPermalink")}{" "}
                    <a
                      href={publishResult.permalink}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-primary hover:underline break-all"
                    >
                      {publishResult.permalink}
                    </a>
                  </p>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
