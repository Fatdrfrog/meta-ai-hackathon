import type { WorkspaceAgentPersona } from "@/lib/airi/workspace-bot-contract";

/**
 * Canonical persona lines for assistant prompts (same wording everywhere:
 * main RAG reply, contextual short replies, etc.).
 */
export function formatPersonaPromptLines(
  persona?: WorkspaceAgentPersona
): string[] {
  if (!persona) return [];
  const sections: string[] = [];
  if (persona.displayName) {
    sections.push(`AGENT IDENTITY: Reply as ${persona.displayName}.`);
  }
  if (persona.tone) {
    sections.push(`AGENT TONE: ${persona.tone}`);
  }
  if (persona.topicRestrictions && persona.topicRestrictions.length > 0) {
    sections.push(
      `TOPIC RESTRICTIONS (never discuss): ${persona.topicRestrictions.join(", ")}`
    );
  }
  return sections;
}
