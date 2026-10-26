import type { ApiProduct, ProductPatch, ShopPageData, StudioData } from "@vitrina/server/api";

export class RequestError extends Error {}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch {
    throw new RequestError("Can't reach the server. Check your connection and try again.");
  }
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  if (!res.ok) throw new RequestError(body?.error ?? `The server answered ${res.status}.`);
  return body as T;
}

export function studioApi(token: string) {
  const base = `/api/studio/${encodeURIComponent(token)}`;
  return {
    load: () => request<StudioData>(base),

    updateProduct: (id: string, patch: ProductPatch) =>
      request<{ product: ApiProduct }>(`${base}/products/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      }).then((r) => r.product),

    removeProduct: (id: string) => request<{ ok: true }>(`${base}/products/${id}`, { method: "DELETE" }),

    confirmAll: () => request<{ confirmed: number }>(`${base}/products/confirm-all`, { method: "POST" }),

    retryVideo: (id: string) => request<{ ok: true }>(`${base}/videos/${id}/retry`, { method: "POST" }),

    // XMLHttpRequest rather than fetch, because a phone upload of a big video needs a progress bar.
    uploadVideo: (file: File, onProgress: (fraction: number) => void) =>
      new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("POST", `${base}/videos`);
        xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) return resolve();
          let message = `The server answered ${xhr.status}.`;
          try {
            message = (JSON.parse(xhr.responseText) as { error?: string }).error ?? message;
          } catch {
            // Not JSON; keep the status message.
          }
          reject(new RequestError(message));
        };
        xhr.onerror = () => reject(new RequestError("The upload was interrupted. Check your connection and try again."));
        const form = new FormData();
        form.append("video", file);
        xhr.send(form);
      }),
  };
}

export const loadShop = (slug: string) => request<ShopPageData>(`/api/shops/${encodeURIComponent(slug)}`);
