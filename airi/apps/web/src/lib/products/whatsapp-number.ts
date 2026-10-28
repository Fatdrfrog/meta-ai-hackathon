import "server-only";
import { normalizeWhatsAppPhone } from "@icecore/shared/lib/whatsapp/contact-identities";

// airi's own WhatsApp number that shop owners send shelf videos to
// (Products), set by PRODUCTS_WHATSAPP_NUMBER; sending videos on WhatsApp is
// off without it.

/** The number, digits only; null when it isn't set up. */
export function productsWhatsAppNumber(): string | null {
  return normalizeWhatsAppPhone(process.env.PRODUCTS_WHATSAPP_NUMBER) ?? null;
}

/** The number as the owner reads it, such as "+7 708 260 9346". */
export function productsWhatsAppNumberLabel(): string | null {
  const number = productsWhatsAppNumber();
  if (!number) return null;
  const written = process.env.PRODUCTS_WHATSAPP_NUMBER?.trim() ?? "";
  return written.startsWith("+") ? written : `+${number}`;
}
