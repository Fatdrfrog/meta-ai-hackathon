"use client";

import { useTranslations } from "next-intl";
import useSWR from "swr";
import { readJsonResponse } from "@/lib/creative-assets/creative-asset-client-response";

type StorageStatus = {
  storage: {
    ready: boolean;
    recording?: boolean;
    limitBytes: number;
    storedBytes?: number;
    reservedBytes?: number;
    remainingBytes?: number;
  };
};

const gib = (bytes: number) => (bytes / 1024 ** 3).toFixed(2);
const fetchStatus = async (url: string) =>
  readJsonResponse<StorageStatus>(await fetch(url));

export function CreativeAssetStorageStatus({
  workspaceId,
}: {
  workspaceId: string;
}) {
  const t = useTranslations("CreativeAssetsWorkspace");
  const { data, error } = useSWR(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/assets/upload`,
    fetchStatus,
    { refreshInterval: 60_000 }
  );
  const storage = data?.storage;
  const message = error
    ? t("storageUnavailable")
    : !storage
      ? t("storageLoading")
      : !storage.ready && !storage.recording
        ? t("storagePreparing")
        : t(storage.recording ? "storageRecording" : "storageUsage", {
            stored: gib(storage.storedBytes || 0),
            reserved: gib(storage.reservedBytes || 0),
            limit: gib(storage.limitBytes),
          });
  return (
    <p
      role="status"
      className="min-w-0 break-words pb-2 text-xs text-muted-foreground"
    >
      {message}
      {(storage?.ready || storage?.recording) && storage.remainingBytes === 0
        ? ` ${t("storageFull")}`
        : ""}
    </p>
  );
}
