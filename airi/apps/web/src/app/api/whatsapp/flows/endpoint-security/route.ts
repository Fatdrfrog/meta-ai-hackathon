import { getWhatsAppFlowEndpointSecurityStatus } from "@/lib/whatsapp/flows/endpoint-security-service";
import { NextResponse } from "next/server";

import {
  endpointSecurityErrorResponse,
  parseEndpointSecurityGetRequest,
  resolveEndpointSecurityReadContext,
} from "@/app/api/whatsapp/flows/endpoint-security/route-shared";

function noStore(response: NextResponse): NextResponse {
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export async function GET(request: Request): Promise<NextResponse> {
  const parsed = parseEndpointSecurityGetRequest(request);
  if (!parsed.ok) return noStore(parsed.response);
  const resolved = await resolveEndpointSecurityReadContext(parsed.data);
  if (!resolved.ok) return noStore(resolved.response);
  try {
    const status = await getWhatsAppFlowEndpointSecurityStatus({
      context: resolved.context,
    });
    return noStore(NextResponse.json(status));
  } catch (error) {
    return noStore(endpointSecurityErrorResponse(error));
  }
}
