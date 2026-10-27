/* eslint-disable @typescript-eslint/no-require-imports -- Standalone Node CommonJS QA runner. */
// Run from apps/web: node e2e/settings/voice-replies-browser.cjs
// Compile the real settings/dialog/CSS owners; intercept every provider/API boundary.
const fs = require("node:fs/promises");
const path = require("node:path");
const http = require("node:http");
const os = require("node:os");
const { createRequire } = require("node:module");
const assert = require("node:assert/strict");

const web = path.resolve(__dirname, "../..");
const tsxRequire = createRequire(require.resolve("tsx/package.json"));
const cssRequire = createRequire(require.resolve("@tailwindcss/postcss"));
const esbuild = tsxRequire("esbuild");
const postcss = cssRequire("postcss");
const tailwind = require("@tailwindcss/postcss");
const { chromium } = require("@playwright/test");
let out;
const source = value => value.replaceAll("\\", "/");

async function buildFixture() {
  const entry = `import React from 'react';
import {createRoot} from 'react-dom/client';
import {NextIntlClientProvider} from 'next-intl';
import AgentSettingsView from '${source(web)}/src/components/settings/agent-settings-view.tsx';
import base from '${source(web)}/messages/en.json';
import agent from '${source(web)}/messages/settings/ai-agent/en/page.json';
createRoot(document.getElementById('root')).render(
  <NextIntlClientProvider locale="en" timeZone="UTC" messages={{...base,...agent}}>
    <main style={{maxWidth:920,margin:'0 auto'}} className="mx-auto min-w-0 p-4 md:p-6">
      <header className="mb-5 space-y-1"><h1 className="text-xl font-semibold">AI agent settings</h1><p className="text-xs text-muted-foreground">Isolated browser QA · actual airi.chat settings component</p></header>
      <AgentSettingsView workspaceId="qa-workspace" />
    </main>
  </NextIntlClientProvider>
);`;
  await fs.writeFile(path.join(out, "entry.tsx"), entry);
  await esbuild.build({
    entryPoints: [path.join(out, "entry.tsx")],
    outfile: path.join(out, "bundle.js"),
    bundle: true,
    format: "iife",
    platform: "browser",
    jsx: "automatic",
    tsconfig: path.join(web, "tsconfig.json"),
    alias: { "@": path.join(web, "src") },
    nodePaths: [path.join(web, "node_modules")],
    define: {
      "process.env": "{}",
      "process.env.NODE_ENV": '"development"',
      "process.env.NEXT_PUBLIC_BILLING_ENABLED": '"true"',
      "process.env.NEXT_PUBLIC_POSTHOG_KEY": '""',
    },
    logLevel: "warning",
  });
  const cssFile = path.join(web, "src/app/globals.css");
  const css = await postcss([tailwind({ base: web })]).process(
    await fs.readFile(cssFile, "utf8"),
    { from: cssFile }
  );
  await fs.writeFile(path.join(out, "style.css"), css.css);
  await fs.writeFile(
    path.join(out, "index.html"),
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Airi AgentSettingsView browser QA</title><link rel="stylesheet" href="/style.css"><style>:root{--font-inter:Arial,sans-serif;--font-geist-mono:monospace}body{margin:0}</style></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>'
  );
}

const initial = {
  success: true,
  defaultBotEnabled: false,
  defaultScenariosEnabled: true,
  defaultCoachEnabled: true,
  retrievalQueryMode: "adaptive",
  includeRecentConversationInRetrievalContext: true,
  sendKbArticleLinksToUserChannels: false,
  whatsappVoiceRepliesEnabled: false,
  languageBias: "none",
  greetingBehavior: "auto",
  escalationBehavior: "suggest_human",
  responseStyle: "balanced",
  agentPersona: { displayName: "Airi" },
  totalConversations: 0,
  enabledConversations: 0,
  scenariosEnabledConversations: 0,
  coachEnabledConversations: 0,
};

async function main() {
  out = process.env.VOICE_REPLIES_QA_OUTPUT
    ? path.resolve(process.env.VOICE_REPLIES_QA_OUTPUT)
    : await fs.mkdtemp(path.join(os.tmpdir(), "airi-voice-replies-browser-"));
  await fs.mkdir(out, { recursive: true });
  await buildFixture();
  const server = http.createServer(async (request, response) => {
    const file =
      request.url === "/bundle.js"
        ? "bundle.js"
        : request.url === "/style.css"
          ? "style.css"
          : "index.html";
    if (request.url === "/favicon.ico") {
      response.writeHead(204);
      response.end();
      return;
    }
    response.writeHead(200, {
      "Content-Type": file.endsWith(".js")
        ? "text/javascript"
        : file.endsWith(".css")
          ? "text/css"
          : "text/html",
    });
    response.end(await fs.readFile(path.join(out, file)));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser;
  const result = {
    environment: {
      origin,
      component: "actual AgentSettingsView/Switch/PlanUpgradeDialog",
      css: "actual apps/web/src/app/globals.css via existing Tailwind/PostCSS",
      browser: "Chromium Playwright",
      scope:
        "Isolated component fixture; authenticated app, checkout, and provider delivery are not exercised",
    },
    viewports: [],
    externalRequests: [],
    screenshots: [],
  };
  try {
    browser = await chromium.launch({ headless: true });
    for (const [name, viewport] of [
      ["desktop", { width: 1280, height: 800 }],
      ["mobile", { width: 390, height: 844 }],
    ]) {
      const context = await browser.newContext({
        viewport,
        reducedMotion: "reduce",
      });
      const page = await context.newPage();
      const errors = [];
      const consoleErrors = [];
      page.on("pageerror", error => errors.push(error.message));
      page.on("console", message => {
        if (message.type() === "error") consoleErrors.push(message.text());
      });
      let settings = {
        ...initial,
        voiceReplyAccess: { available: true, reason: null },
      };
      let failGet = false;
      let failPatch = false;
      let holdGet;
      let holdPatch;
      const patches = [];
      await page.route("**/*", async route => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.origin !== origin) {
          result.externalRequests.push(request.url());
          await route.abort();
          return;
        }
        if (url.pathname === "/api/workspaces/qa-workspace/airi-bot") {
          if (request.method() === "GET") {
            if (holdGet) await holdGet;
            await route.fulfill({
              status: 200,
              contentType: "application/json",
              body: JSON.stringify(
                failGet
                  ? { success: false, error: "Mocked unavailable settings" }
                  : settings
              ),
            });
          } else if (request.method() === "PATCH") {
            const patch = request.postDataJSON();
            patches.push(patch);
            if (holdPatch) await holdPatch;
            if (!failPatch) settings = { ...settings, ...patch };
            await route.fulfill({
              status: 200,
              contentType: "application/json",
              body: JSON.stringify(
                failPatch
                  ? { success: false, error: "Mocked save failure" }
                  : settings
              ),
            });
          } else
            throw new Error(`Unexpected settings method ${request.method()}`);
          return;
        }
        if (url.pathname.startsWith("/api/"))
          throw new Error(`Unexpected API call: ${url.pathname}`);
        await route.continue();
      });
      const checks = [];
      const settle = async () =>
        page.evaluate(async () => {
          document.getAnimations().forEach(animation => {
            try {
              animation.finish();
            } catch {}
          });
          await new Promise(resolve =>
            requestAnimationFrame(() => requestAnimationFrame(resolve))
          );
        });
      const screenshot = async label => {
        await settle();
        if (
          [
            "free-locked",
            "paid-missing-elevenlabs",
            "paid-enabled-saved",
            "save-failure-draft",
          ].includes(label)
        ) {
          await page
            .getByRole("button", {
              name: "Voice replies & voice agent",
              exact: true,
            })
            .evaluate(element => element.scrollIntoView({ block: "start" }));
        }
        await settle();
        const file = `${name}-${label}.png`;
        await page.screenshot({
          path: path.join(out, file),
          fullPage: false,
          animations: "disabled",
        });
        result.screenshots.push(path.join(out, file));
      };
      const checkOverflow = async label => {
        const dimensions = await page.evaluate(() => ({
          width: innerWidth,
          doc: document.documentElement.scrollWidth,
          body: document.body.scrollWidth,
        }));
        assert(
          dimensions.doc <= dimensions.width + 1 &&
            dimensions.body <= dimensions.width + 1,
          `${name} ${label} document overflow: ${JSON.stringify(dimensions)}`
        );
        checks.push(`${label}: no horizontal overflow`);
      };
      const load = async () => {
        await page.goto(`${origin}/panel/w/qa-workspace/settings/ai-agent`);
        await page
          .getByRole("textbox", { name: "Display name", exact: true })
          .waitFor();
        assert.equal(await page.title(), "Airi AgentSettingsView browser QA");
        assert.equal(
          new URL(page.url()).pathname,
          "/panel/w/qa-workspace/settings/ai-agent"
        );
        assert.equal(
          await page
            .locator("vite-error-overlay,[data-nextjs-dialog-overlay]")
            .count(),
          0
        );
        assert(
          await page
            .getByRole("heading", { name: "AI agent settings", exact: true })
            .isVisible()
        );
        await page
          .getByRole("button", {
            name: "Voice replies & voice agent",
            exact: true,
          })
          .click();
      };
      const toggle = () =>
        page.getByRole("switch", {
          name: "WhatsApp voice replies",
          exact: true,
        });
      const save = () =>
        page.getByRole("button", { name: "Save settings", exact: true });

      settings = {
        ...initial,
        voiceReplyAccess: { available: false, reason: "subscription_required" },
      };
      await load();
      assert(await toggle().isDisabled(), "Free voice replies must be locked");
      await screenshot("free-locked");
      await checkOverflow("Free locked");
      await page
        .getByRole("button", { name: "Upgrade to Pro", exact: true })
        .focus();
      await page.keyboard.press("Enter");
      await page.getByRole("dialog").waitFor();
      assert(
        await page
          .getByRole("dialog")
          .getByRole("button", { name: "Upgrade to Pro", exact: true })
          .isVisible()
      );
      checks.push(
        "Free upgrade CTA: keyboard Enter opens actual PlanUpgradeDialog"
      );
      await screenshot("free-upgrade-open");
      await checkOverflow("Upgrade dialog");
      if (name === "mobile") {
        await settle();
        await page.getByRole("dialog").evaluate(element => {
          element.scrollTop = element.scrollHeight;
        });
        const contact = page.getByRole("link", {
          name: "Contact sales",
          exact: true,
        });
        await contact.scrollIntoViewIfNeeded();
        const rect = await contact.boundingBox();
        assert(
          rect && rect.y >= 0 && rect.y + rect.height <= viewport.height + 1,
          "Mobile upgrade drawer must allow reaching Enterprise CTA"
        );
        const visibility = await contact.evaluate(element => {
          const rect = element.getBoundingClientRect();
          const pointElement = document.elementFromPoint(
            rect.x + rect.width / 2,
            rect.y + rect.height / 2
          );
          const ancestors = [];
          let current = element;
          while (current) {
            const style = getComputedStyle(current);
            const box = current.getBoundingClientRect();
            ancestors.push({
              tag: current.tagName,
              classes: current.className,
              top: box.top,
              bottom: box.bottom,
              height: box.height,
              clientHeight: current.clientHeight,
              scrollHeight: current.scrollHeight,
              scrollTop: current.scrollTop,
              overflowY: style.overflowY,
              opacity: style.opacity,
              transform: style.transform,
              minHeight: style.minHeight,
              flexShrink: style.flexShrink,
            });
            current = current.parentElement;
          }
          return {
            pointHitsContact:
              pointElement === element || element.contains(pointElement),
            pointElement: pointElement?.outerHTML.slice(0, 200),
            ancestors,
          };
        });
        result.mobileContactVisibility = visibility;
        await fs.writeFile(
          path.join(out, "mobile-contact-visibility.json"),
          JSON.stringify(visibility, null, 2)
        );
        await screenshot("free-upgrade-scrolled");
        assert(
          visibility.pointHitsContact,
          "Mobile Enterprise contact action must be visibly hit-testable after scrolling; Vaul background must not cover it"
        );
        checks.push(
          "Mobile upgrade drawer: vertical scroll reaches Enterprise contact action"
        );
      }
      await page.keyboard.press("Escape");
      await page.getByRole("dialog").waitFor({ state: "hidden" });
      checks.push("Upgrade dialog: keyboard Escape closes it");

      settings = {
        ...initial,
        voiceReplyAccess: { available: false, reason: "elevenlabs_required" },
      };
      await load();
      assert(await toggle().isDisabled());
      assert.equal(
        await page
          .getByRole("link", { name: "Connect ElevenLabs", exact: true })
          .getAttribute("href"),
        "/panel/w/qa-workspace/settings/integrations"
      );
      checks.push(
        "Paid missing ElevenLabs: locked switch and canonical Integrations link"
      );
      await screenshot("paid-missing-elevenlabs");
      await checkOverflow("Missing ElevenLabs");

      settings = {
        ...initial,
        voiceReplyAccess: { available: true, reason: null },
      };
      await load();
      assert(await save().isDisabled());
      await toggle().focus();
      await page.keyboard.press("Space");
      assert.equal(await toggle().getAttribute("aria-checked"), "true");
      assert(!(await save().isDisabled()));
      let releasePatch;
      holdPatch = new Promise(resolve => {
        releasePatch = resolve;
      });
      await save().click();
      await page
        .getByRole("button", { name: "Saving...", exact: true })
        .waitFor();
      assert(
        await page
          .getByRole("button", { name: "Saving...", exact: true })
          .isDisabled()
      );
      await screenshot("saving");
      checks.push(
        "Saving: disabled progress button while PATCH remains pending"
      );
      releasePatch();
      holdPatch = null;
      await page.getByText("Agent settings saved", { exact: true }).waitFor();
      assert.equal(patches.at(-1).whatsappVoiceRepliesEnabled, true);
      assert(await save().isDisabled());
      checks.push(
        "Available: keyboard Space opts in; Save persists true and confirms server snapshot"
      );
      await screenshot("paid-enabled-saved");
      await checkOverflow("Enabled saved");
      await toggle().focus();
      await page.keyboard.press("Space");
      assert.equal(await toggle().getAttribute("aria-checked"), "false");
      await save().click();
      await page.getByText("Agent settings saved", { exact: true }).waitFor();
      assert.equal(patches.at(-1).whatsappVoiceRepliesEnabled, false);
      checks.push("Available: opt-out Save persists false");

      await toggle().click();
      failPatch = true;
      await save().click();
      await page
        .getByText("Failed to save agent settings", { exact: true })
        .waitFor();
      assert.equal(await toggle().getAttribute("aria-checked"), "true");
      assert(!(await save().isDisabled()));
      checks.push("Save failure: draft retained and retry remains enabled");
      await screenshot("save-failure-draft");
      await checkOverflow("Save failure");
      failPatch = false;
      await save().click();
      await page.getByText("Agent settings saved", { exact: true }).waitFor();
      checks.push("Save retry: confirmed success");

      settings = {
        ...initial,
        whatsappVoiceRepliesEnabled: true,
        voiceReplyAccess: { available: false, reason: "subscription_required" },
      };
      await load();
      assert(
        !(await toggle().isDisabled()),
        "Downgraded workspace can turn voice replies off"
      );
      await page
        .getByRole("textbox", { name: "Display name", exact: true })
        .fill("Updated Airi");
      await save().click();
      await page.getByText("Agent settings saved", { exact: true }).waitFor();
      assert(
        !Object.hasOwn(patches.at(-1), "whatsappVoiceRepliesEnabled"),
        "Unrelated save must omit unchanged enabled voice setting after downgrade"
      );
      checks.push(
        "Downgrade: persona Save omits unchanged enabled voice setting"
      );
      await toggle().click();
      await save().click();
      await page.getByText("Agent settings saved", { exact: true }).waitFor();
      assert.equal(patches.at(-1).whatsappVoiceRepliesEnabled, false);
      assert(
        await toggle().isDisabled(),
        "Downgraded workspace locks voice replies after opting out"
      );
      checks.push(
        "Downgrade: voice replies remain possible to disable and then become locked"
      );

      settings = {
        ...initial,
        voiceReplyAccess: { available: true, reason: null },
      };
      failGet = true;
      await page.reload();
      await page.getByRole("alert").waitFor();
      assert(
        !(await page
          .getByRole("textbox", { name: "Display name", exact: true })
          .isVisible())
      );
      checks.push(
        "Load failure: retry alert without editable default settings"
      );
      await screenshot("load-failure");
      await checkOverflow("Load failure");
      failGet = false;
      await page.getByRole("button", { name: "Retry", exact: true }).click();
      await page
        .getByRole("textbox", { name: "Display name", exact: true })
        .waitFor();
      checks.push("Load retry: form recovers");

      let releaseGet;
      holdGet = new Promise(resolve => {
        releaseGet = resolve;
      });
      await page.reload();
      await page
        .getByText("Loading agent settings...", { exact: true })
        .waitFor();
      assert(
        !(await page
          .getByRole("textbox", { name: "Display name", exact: true })
          .isVisible())
      );
      await screenshot("loading");
      checks.push("Loading: progress text, no editable default settings");
      releaseGet();
      holdGet = null;
      await page
        .getByRole("textbox", { name: "Display name", exact: true })
        .waitFor();
      await page
        .getByRole("button", {
          name: "Voice replies & voice agent",
          exact: true,
        })
        .focus();
      await page.keyboard.press("Enter");
      await toggle().waitFor();
      await page.keyboard.press("Tab");
      assert(
        await toggle().evaluate(element => element === document.activeElement),
        "Voice accordion keyboard Tab must reach switch"
      );
      checks.push("Accordion Enter + Tab reaches voice switch");
      assert.deepEqual(errors, [], "Unexpected page errors");
      assert.deepEqual(consoleErrors, [], "Unexpected browser console errors");
      result.viewports.push({
        name,
        viewport,
        checks,
        pageErrors: errors,
        consoleErrors,
        patches: patches.map(value => ({
          whatsappVoiceRepliesEnabled: value.whatsappVoiceRepliesEnabled,
        })),
      });
      await context.close();
    }
    assert.deepEqual(
      result.externalRequests,
      [],
      "No external provider or billing requests allowed"
    );
    result.outcome = "passed";
    await fs.writeFile(
      path.join(out, "results.json"),
      JSON.stringify(result, null, 2)
    );
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    result.outcome = "failed";
    result.error = error.message;
    await fs.writeFile(
      path.join(out, "results.json"),
      JSON.stringify(result, null, 2)
    );
    throw error;
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}
main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
