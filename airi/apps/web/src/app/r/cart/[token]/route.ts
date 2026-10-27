import { NextResponse } from "next/server";
import connectDB from "@/lib/mongoose";
import WebsiteCart, { type WebsiteCartRow } from "@/models/website-cart";
import { readCartRecoveryToken } from "@/lib/commerce/cart-journeys";
import {
  resolveWebsiteCommerceContext,
  WebsiteCommerceIntegrationError,
} from "@/lib/commerce/integrations";
import {
  ACTIVE_CART_STATES,
  validateRecoveryUrl,
  WebsiteCartError,
} from "@/lib/commerce/cart-state";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ token: string }> }
) {
  const headers = {
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
  };
  try {
    const id = readCartRecoveryToken((await params).token);
    if (!id)
      return new NextResponse("This cart link has expired.", {
        status: 410,
        headers,
      });
    await connectDB();
    const cart = await WebsiteCart.findById(id).lean<WebsiteCartRow>();
    if (
      !cart ||
      !ACTIVE_CART_STATES.includes(cart.status) ||
      new Date(cart.expiresAt) <= new Date()
    )
      return new NextResponse("This cart is no longer available.", {
        status: 410,
        headers,
      });
    const context = await resolveWebsiteCommerceContext(cart.widgetSourceId);
    const url = validateRecoveryUrl(
      cart.recoveryUrl,
      context.widgetSource.credentials.allowed_domains
    );
    if (!url)
      return new NextResponse("This cart is no longer available.", {
        status: 410,
        headers,
      });
    return new NextResponse(null, {
      status: 302,
      headers: { ...headers, Location: url },
    });
  } catch (error) {
    if (
      error instanceof WebsiteCartError ||
      (error instanceof WebsiteCommerceIntegrationError && error.status !== 503)
    )
      return new NextResponse("This cart is no longer available.", {
        status: 410,
        headers,
      });
    return new NextResponse("Cart recovery is temporarily unavailable.", {
      status: 503,
      headers,
    });
  }
}
