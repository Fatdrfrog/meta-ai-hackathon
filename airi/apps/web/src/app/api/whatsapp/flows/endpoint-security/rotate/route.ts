import { rotateWhatsAppFlowEndpointSecurity } from "@/lib/whatsapp/flows/endpoint-security-service";
import { NextResponse } from "next/server";

import {
  endpointSecurityErrorResponse,
  parseEndpointSecurityPostRequest,
  resolveEndpointSecurityMutationContext,
} from "@/app/api/whatsapp/flows/endpoint-security/route-shared";

export async function POST(request: Request): Promise<NextResponse> {
  const parsed = await parseEndpointSecurityPostRequest(request);
  if (!parsed.ok) return parsed.response;
  const resolved = await resolveEndpointSecurityMutationContext(
    parsed.data,
    "ROTATE"
  );
  if (!resolved.ok) return resolved.response;
  try {
    const status = await rotateWhatsAppFlowEndpointSecurity({
      context: resolved.context,
    });
    return NextResponse.json(status);
  } catch (error) {
    return endpointSecurityErrorResponse(error);
  }
}
