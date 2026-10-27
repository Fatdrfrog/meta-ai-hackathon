import { redirect } from "next/navigation";

type BulkAnalyticsRedirectSearchParams = Record<
  string,
  string | string[] | undefined
>;

function appendSearchParam(
  params: URLSearchParams,
  key: string,
  value: string | string[] | undefined
) {
  if (Array.isArray(value)) {
    for (const item of value) params.append(key, item);
    return;
  }
  if (value !== undefined) params.set(key, value);
}

export default async function BulkAnalyticsRedirectPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<BulkAnalyticsRedirectSearchParams>;
}) {
  const [{ workspaceId }, resolvedSearchParams] = await Promise.all([
    params,
    searchParams,
  ]);
  const nextSearchParams = new URLSearchParams();

  for (const [key, value] of Object.entries(resolvedSearchParams)) {
    appendSearchParam(nextSearchParams, key, value);
  }
  nextSearchParams.set("tab", "analytics");

  redirect(
    `/panel/w/${workspaceId}/bulk-campaigns?${nextSearchParams.toString()}`
  );
}
