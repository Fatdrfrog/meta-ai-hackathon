"use client";

export type BillingCycle = "monthly" | "annual";

type CheckoutResponse = {
  provider: "paddle";
  transactionId: string;
  clientToken: string;
  environment: "sandbox" | "production";
  checkoutUrl?: string | null;
};

declare global {
  interface Window {
    Paddle?: {
      Environment?: {
        set?: (environment: "sandbox" | "production") => void;
      };
      Initialize?: (params: { token: string }) => void;
      Checkout?: {
        open?: (params: {
          transactionId: string;
          settings?: { successUrl?: string };
        }) => void;
      };
    };
  }
}

function loadScript(src: string): Promise<void> {
  const existing = document.querySelector<HTMLScriptElement>(
    `script[src="${src}"]`
  );
  if (existing) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Failed to load Paddle checkout"));
    document.head.appendChild(script);
  });
}

async function postCheckout(
  workspaceId: string,
  billingCycle: BillingCycle
): Promise<CheckoutResponse> {
  const response = await fetch(
    `/api/workspaces/${workspaceId}/billing/checkout`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ billingCycle }),
    }
  );
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      typeof body?.error === "string" ? body.error : "Billing request failed"
    );
  }
  return body as CheckoutResponse;
}

export async function startBillingCheckout(
  workspaceId: string,
  billingCycle: BillingCycle = "monthly"
) {
  const checkout = await postCheckout(workspaceId, billingCycle);
  await loadScript("https://cdn.paddle.com/paddle/v2/paddle.js");
  window.Paddle?.Environment?.set?.(checkout.environment);
  window.Paddle?.Initialize?.({ token: checkout.clientToken });
  const open = window.Paddle?.Checkout?.open;
  if (!open) throw new Error("Paddle checkout did not initialize");
  open({
    transactionId: checkout.transactionId,
    settings: {
      successUrl: `${window.location.origin}/panel/w/${workspaceId}/settings/billing`,
    },
  });
}
