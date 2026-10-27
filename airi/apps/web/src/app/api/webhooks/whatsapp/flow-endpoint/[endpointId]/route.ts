import { handleWhatsAppFlowEndpointPost } from "@/app/api/webhooks/whatsapp/flow-endpoint/route-shared";
import { resolveWhatsAppFlowEndpointRuntimeKeys } from "@/lib/whatsapp/flows/endpoint-security-service";

export const runtime = "nodejs";
export const maxDuration = 60;

type RouteContext = {
  params: Promise<{ endpointId: string }>;
};

export async function POST(
  request: Request,
  context: RouteContext
): Promise<Response> {
  let endpointId: string;
  try {
    endpointId = (await context.params).endpointId;
  } catch {
    return new Response(null, { status: 421 });
  }

  return handleWhatsAppFlowEndpointPost({
    request,
    route: "/api/webhooks/whatsapp/flow-endpoint/[endpointId]",
    resolveKeyCandidates: async () => {
      const resolved = await resolveWhatsAppFlowEndpointRuntimeKeys({
        endpointId,
      });
      if (!resolved || resolved.endpointId !== endpointId.trim()) return null;
      return resolved.keyCandidates;
    },
    unavailable: { status: 421, body: null },
  });
}
