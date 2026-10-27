import { Server, type CallToolResult } from "@modelcontextprotocol/server";
import { AIRI_MCP_TOOLS, listAllowedAiriMcpTools } from "./tools";
import {
  READ_ONLY_TOOL_ANNOTATIONS,
  UNTRUSTED_CONTENT_NOTICE,
  type AiriMcpTool,
} from "./tools/define";
import type {
  AiriMcpAuthContext,
  AiriMcpDeps,
  AiriMcpLogContext,
} from "./types";

export const AIRI_MCP_SERVER_INFO = { name: "airi", version: "0.1.0" };

export const AIRI_MCP_INSTRUCTIONS = `Read-only access to the Airi workspace that owns this API key. ${UNTRUSTED_CONTENT_NOTICE}`;

/** Same text for unknown and disallowed tools, so neither reveals the other. */
export const AIRI_MCP_TOOL_UNAVAILABLE = "This tool is not available.";
export const AIRI_MCP_TOOL_FAILED =
  "The tool could not read Airi data right now. Try again later.";

export const AIRI_MCP_TOOL_CALL_EVENT = "airi_mcp.tool_call";

type ToolCallOutcome = "ok" | "denied" | "error";
type ToolCallReason = "not_available" | "invalid_arguments" | "failed";

function toolError(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

function toolListing(tool: AiriMcpTool) {
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema,
    annotations: { title: tool.title, ...READ_ONLY_TOOL_ANNOTATIONS },
  };
}

/**
 * One low-level MCP server per HTTP request, holding only the tools this key
 * may call. The SDK's McpServer is not used: its registerTool needs zod >=4.2
 * schemas, reports unknown or disabled tools by name and echoes handler error
 * messages to the client.
 */
export function createAiriMcpServer(
  auth: AiriMcpAuthContext,
  deps: Pick<AiriMcpDeps, "data" | "logger" | "now">
): Server {
  const allowed = listAllowedAiriMcpTools(auth.apiKey);
  const server = new Server(AIRI_MCP_SERVER_INFO, {
    capabilities: { tools: { listChanged: false } },
    instructions: AIRI_MCP_INSTRUCTIONS,
  });

  server.setRequestHandler("tools/list", () => ({
    tools: allowed.map(toolListing),
  }));

  server.setRequestHandler("tools/call", async request => {
    const startedAt = deps.now();
    const tool = AIRI_MCP_TOOLS.find(
      candidate => candidate.name === request.params.name
    );
    const log = (
      outcome: ToolCallOutcome,
      itemCount: number,
      reason?: ToolCallReason
    ) => {
      const context: AiriMcpLogContext = {
        event: AIRI_MCP_TOOL_CALL_EVENT,
        keyId: auth.apiKey.id,
        workspaceId: auth.workspaceId,
        // Client-chosen names of unknown tools are not logged.
        tool: tool?.name ?? "unknown",
        outcome,
        latencyMs: Math.max(0, deps.now().getTime() - startedAt.getTime()),
        itemCount,
        ...(reason ? { reason } : {}),
      };
      if (outcome === "ok") deps.logger.info(AIRI_MCP_TOOL_CALL_EVENT, context);
      else if (outcome === "denied")
        deps.logger.warn(AIRI_MCP_TOOL_CALL_EVENT, context);
      else deps.logger.error(AIRI_MCP_TOOL_CALL_EVENT, undefined, context);
    };

    if (!tool || !allowed.includes(tool)) {
      log("denied", 0, "not_available");
      return toolError(AIRI_MCP_TOOL_UNAVAILABLE);
    }

    try {
      const execution = await tool.execute(request.params.arguments, {
        auth,
        data: deps.data,
        now: startedAt,
      });
      if (!execution.ok) {
        log("denied", 0, "invalid_arguments");
        return toolError(`Invalid arguments: ${execution.invalidArguments}`);
      }
      const { summary, structured, itemCount } = execution.output;
      log("ok", itemCount);
      return {
        // Clients that ignore structuredContent still get the data as text.
        content: [
          { type: "text", text: summary },
          { type: "text", text: JSON.stringify(structured) },
        ],
        structuredContent: structured,
      };
    } catch {
      // Never surface internal errors; a throw here would echo its message.
      log("error", 0, "failed");
      return toolError(AIRI_MCP_TOOL_FAILED);
    }
  });

  return server;
}
