import "server-only";

/**
 * Web-owned code the worker's Products code uses (the video import activity,
 * and the WhatsApp intake on airi's own number), in one module, so each
 * reaches the web app through a single import.
 */
export { default as connectDB } from "@/lib/mongoose";
export { ProductVideoImport } from "@/models/product-video-import";
export { WorkspaceProduct } from "@/models/workspace-product";
export { emitProductsChangedRealtimeEvent } from "@/lib/realtime/server";
export { productImportSpend } from "@/lib/products/import-spend";
export { downloadOwnedWhatsAppMedia } from "@/lib/media/whatsapp-media-server";
export {
  handleProductsWhatsAppMessage,
  notifyProductsWhatsAppOwner,
} from "@/lib/products/whatsapp-intake";
