import type { FacebookSDK } from "@/lib/facebook-sdk";

declare global {
  interface Window {
    FB?: FacebookSDK;
    fbAsyncInit?: () => void;
  }
}

export {};
