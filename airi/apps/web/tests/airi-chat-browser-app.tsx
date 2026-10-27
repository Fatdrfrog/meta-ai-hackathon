import { useState } from "react";
import { createRoot } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { Toaster } from "sonner";
import { AiriChatWorkspace } from "../src/components/ai/airi-chat-workspace";
import commonMessages from "../messages/en.json";
import scenarioMessages from "../messages/scenarios/en/page.json";
import templateMessages from "../messages/templates/en/page.json";
import "../src/app/globals.css";

const WORKSPACE_ID = "browser-workspace";

/**
 * The header's Airi drawer, as site-header.tsx mounts it: the compact
 * workspace exists only while the drawer is open, so closing it unmounts
 * the chat (and detaches any running answer's stream).
 */
function AiriDrawerHarness() {
  const [open, setOpen] = useState(false);
  return (
    <main className="flex h-screen">
      <div className="flex-1 p-4">
        <button
          type="button"
          className="rounded border px-3 py-1"
          onClick={() => setOpen(true)}
        >
          Open Airi chat
        </button>
      </div>
      {open ? (
        <aside
          aria-label="Airi drawer"
          className="h-full w-[520px] shrink-0 border-l"
        >
          <AiriChatWorkspace
            workspaceId={WORKSPACE_ID}
            compact
            initialSource="global"
            onClose={() => setOpen(false)}
          />
        </aside>
      ) : null}
    </main>
  );
}

// The /airi page's workspace, as the page renders it (or the header drawer
// with ?drawer=1): the real client, its SSE parser and its rendering.
// Playwright answers every API request.
const drawer = new URLSearchParams(window.location.search).has("drawer");

createRoot(document.getElementById("root")!).render(
  <NextIntlClientProvider
    locale="en"
    timeZone="UTC"
    messages={{ ...commonMessages, ...scenarioMessages, ...templateMessages }}
  >
    {drawer ? (
      <AiriDrawerHarness />
    ) : (
      <main className="h-screen">
        <AiriChatWorkspace workspaceId={WORKSPACE_ID} initialSource="manual" />
      </main>
    )}
    <Toaster />
  </NextIntlClientProvider>
);
