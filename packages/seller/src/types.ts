export type Channel = "web" | "whatsapp";

export interface SellerProduct {
  readonly id: string;
  /** The owner's name for it, in their language. */
  readonly localName: string;
  readonly name: string;
  readonly category: string;
  readonly price: number | null;
}

export interface SellerMessage {
  readonly role: "buyer" | "seller";
  readonly text: string;
}

export interface PastOrder {
  readonly items: readonly { readonly localName: string; readonly quantity: number }[];
  readonly total: number | null;
  readonly createdAt: string;
}

export interface SellerTurnInput {
  readonly shopName: string;
  readonly channel: Channel;
  /** In shelf order; the numbered catalog sheet follows the same order. */
  readonly products: readonly SellerProduct[];
  /** Numbered sheet of the products' photos, for matching a buyer's photo. */
  readonly catalogSheetPath?: string;
  readonly history: readonly SellerMessage[];
  readonly buyerText: string;
  readonly buyerPhotoPath?: string;
  /** Known on WhatsApp; on the web the buyer has to give it. */
  readonly buyerPhone?: string;
  /** Orders already placed in this chat, for "where is my order?". */
  readonly previousOrders?: readonly PastOrder[];
}

export interface SellerOrder {
  readonly items: readonly { readonly productId: string; readonly quantity: number }[];
  readonly buyerName: string | null;
  readonly buyerPhone: string;
  /** Null when an item has no price yet. */
  readonly total: number | null;
}

/** One tool call the agent made, kept so its work can be shown and checked. */
export interface TraceStep {
  readonly tool: string;
  readonly args: unknown;
  readonly result: unknown;
}

export interface SellerTurn {
  readonly reply: string;
  readonly productIds: readonly string[];
  readonly order: SellerOrder | null;
  /** Questions for the shop owner, written in Russian, joined. */
  readonly ownerQuestion: string | null;
  /** What the checks caught in the agent's first reply; empty when it passed. */
  readonly corrections: readonly string[];
  readonly trace: readonly TraceStep[];
}
