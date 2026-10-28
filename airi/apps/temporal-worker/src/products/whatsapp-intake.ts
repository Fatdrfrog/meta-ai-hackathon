import { airiWorkerLogger } from "@icecore/airi-runtime/logging";
import { readDefaultExport } from "@icecore/airi-runtime/module-interop";

// Messages on airi's own WhatsApp number that are for Products (a shop
// owner's link code, their answer to Airi, a shelf video) go to the web
// app's intake; the rest carry on to the number's usual handling.

/** The web code this uses, through the Products host module. */
async function loadWebHost() {
  const host = await import("@/lib/products/import-worker-host");
  return readDefaultExport<typeof host>(host);
}

type WebHost = Awaited<ReturnType<typeof loadWebHost>>;

export type ProductsWhatsAppIntakeMessage = Parameters<
  WebHost["handleProductsWhatsAppMessage"]
>[0];

/**
 * Hands one inbound message to the Products intake. Off until
 * PRODUCTS_WHATSAPP_NUMBER names airi's number. A failure leaves the message
 * to the usual handling rather than dropping it.
 */
export async function handleProductsWhatsAppIntake(
  message: ProductsWhatsAppIntakeMessage,
): Promise<{ handled: boolean; outcome: string }> {
  if (!process.env.PRODUCTS_WHATSAPP_NUMBER?.trim())
    return { handled: false, outcome: "off" };
  try {
    const host = await loadWebHost();
    await host.connectDB();
    return await host.handleProductsWhatsAppMessage(message);
  } catch (error) {
    airiWorkerLogger.warn("products.whatsapp_intake_failed", {
      workspaceId: message.workspaceId,
      messageId: message.messageId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { handled: false, outcome: "failed" };
  }
}
