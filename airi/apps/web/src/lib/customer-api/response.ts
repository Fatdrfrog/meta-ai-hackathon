import { noStoreJson } from "@/lib/http/no-store-json";

export function customerApiResponse(body: unknown, status = 200) {
  return noStoreJson(body, status, { cacheControl: "no-store" });
}
