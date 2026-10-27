import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import enMessages from "../messages/settings/integrations/en/page.json";
import ruMessages from "../messages/settings/integrations/ru/page.json";
import kzMessages from "../messages/settings/integrations/kz/page.json";
import enScenarioMessages from "../messages/scenarios/en/page.json";
import ruScenarioMessages from "../messages/scenarios/ru/page.json";
import kzScenarioMessages from "../messages/scenarios/kz/page.json";
import {
  META_STARTER_FLOW_JSON,
  DEMOSHOP_FLOW_JSON,
} from "../src/components/scenarios/builders/whatsapp/flow-json-fixtures";

for (const viewport of [
  { name: "desktop", width: 1440, height: 1000 },
  { name: "mobile", width: 390, height: 844 },
]) {
  test(`${viewport.name} Meta starter opens visually, saves losslessly and explains the publish prerequisite`, async ({
    page,
  }) => {
    await page.setViewportSize({
      width: viewport.width,
      height: viewport.height,
    });
    const provider = await mockProviderBoundary(page, {
      draftJson: META_STARTER_FLOW_JSON,
    });
    await openManager(page);
    const card = page.getByRole("listitem").filter({ hasText: "Contact form" });
    await expect(card.getByText("Hello World", { exact: true })).toBeVisible();
    await expect(
      card.getByText("Let's start building things!", { exact: true })
    ).toBeVisible();
    await card.getByRole("button", { name: "Edit", exact: true }).click();
    const dialog = page.getByRole("dialog");
    const visual = dialog.getByRole("tab", { name: "Visual", exact: true });
    await expect(visual).toBeEnabled();
    await expect(visual).toHaveAttribute("data-state", "active");
    const publish = dialog.getByRole("button", {
      name: "Publish",
      exact: true,
    });
    await expect(publish).toBeEnabled();
    const workspace = dialog.getByTestId("flow-authoring-workspace");
    if (viewport.name === "mobile") {
      await workspace
        .getByRole("button", { name: "Edit", exact: true })
        .click();
    }
    const text = workspace.getByRole("textbox", { name: "Text", exact: true });
    await expect(text).toHaveValue("Hello World");
    await text.fill("Welcome to airi.chat");
    await expect(publish).toBeDisabled();
    const explanation = dialog.getByText(
      enMessages.WhatsAppFlows.editor.publishNeedsSave,
      { exact: true }
    );
    await expect(explanation).toBeVisible();
    await expect(publish).toHaveAttribute(
      "aria-describedby",
      (await explanation.getAttribute("id")) as string
    );
    if (viewport.name === "mobile") {
      await workspace
        .getByRole("button", { name: "WhatsApp preview", exact: true })
        .click();
    }
    const phone = workspace
      .getByRole("button", { name: "Restart preview", exact: true })
      .locator("..");
    await expect(
      phone.getByRole("heading", { name: "Welcome to airi.chat", exact: true })
    ).toBeVisible();
    await phone.getByRole("button", { name: "Complete", exact: true }).click();
    await openPreviewResult(phone);
    await expect
      .poll(async () => JSON.parse(await phone.locator("pre").innerText()))
      .toEqual({});
    await capture(page, `${viewport.name}-meta-starter-publish-prerequisite`);
    await dialog
      .getByRole("button", { name: "Save draft", exact: true })
      .click();
    await expect(
      dialog.getByText("Draft saved", { exact: true })
    ).toBeVisible();
    await expect(publish).toBeEnabled();
    await expect(explanation).toHaveCount(0);
    const expected = structuredClone(META_STARTER_FLOW_JSON);
    expected.screens[0].layout.children[0] = {
      type: "TextHeading",
      text: "Welcome to airi.chat",
    };
    expect(provider.documents.get(ids.draft)).toEqual(expected);
    expect(
      provider.mutations.filter(mutation => mutation.operation === "publish")
    ).toHaveLength(0);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth
      )
    ).toBe(false);
    await capture(page, `${viewport.name}-meta-starter-saved`);
    await dialog
      .getByRole("button", { name: "Close", exact: true })
      .last()
      .click();
    await card.getByRole("button", { name: "Edit", exact: true }).click();
    await expect(visual).toHaveAttribute("data-state", "active");
    await publish.click();
    await expect(
      dialog.getByText(enMessages.WhatsAppFlows.editor.readOnly, {
        exact: true,
      })
    ).toBeVisible();
    expect(
      provider.mutations.filter(mutation => mutation.operation === "publish")
    ).toHaveLength(1);
    expect(provider.errors).toEqual([]);
  });
}
for (const viewport of [
  { name: "desktop", width: 1440, height: 1000 },
  { name: "mobile", width: 390, height: 844 },
]) {
  test(`${viewport.name} demoshop graph previews every branch and preserves its response contract`, async ({
    page,
  }) => {
    await page.setViewportSize({
      width: viewport.width,
      height: viewport.height,
    });
    const provider = await mockProviderBoundary(page, {
      draftJson: DEMOSHOP_FLOW_JSON,
    });
    await openManager(page);
    await page
      .getByRole("listitem")
      .filter({ hasText: "Contact form" })
      .getByRole("button", { name: "Edit", exact: true })
      .click();
    const dialog = page.getByRole("dialog");
    const workspace = dialog.getByTestId("flow-authoring-workspace");
    await expect(
      dialog.getByRole("tab", { name: "Visual", exact: true })
    ).toHaveAttribute("data-state", "active");
    if (viewport.name === "mobile")
      await workspace
        .getByRole("button", { name: "WhatsApp preview", exact: true })
        .click();
    const phone = workspace
      .getByRole("button", { name: "Restart preview", exact: true })
      .locator("..");
    await expect(
      phone.getByRole("heading", { name: "Choose a sport", exact: true })
    ).toBeVisible();
    await expect(phone.getByText("sport_list", { exact: true })).toHaveCount(0);
    for (const [label, sport] of [
      ["Football, basketball", "0_Футбол_/_Баскетбол_/_Волейбол"],
      ["Taekwondo, karate, wrestling", "1_Таэквондо_/_Каратэ_/_Күрес"],
      ["Gymnastics, dance", "2_Гимнастика_/_Би"],
    ]) {
      const choice = phone.getByRole("button", { name: label, exact: true });
      await choice.focus();
      await page.keyboard.press("Enter");
      await expect(
        phone.getByRole("heading", { name: "Design and name", exact: true })
      ).toBeFocused();
      await expect(
        phone.getByRole("button", { name: "Send", exact: true })
      ).toBeDisabled();
      await expect(
        phone.getByText("With the athlete's name", { exact: true })
      ).toBeVisible();
      await phone
        .getByRole("radio", { name: "Personalised With the athlete's name" })
        .click();
      await phone
        .getByRole("textbox", { name: "Athlete's name *", exact: true })
        .fill("Aruzhan");
      await phone
        .getByRole("textbox", { name: "City / region *", exact: true })
        .fill("Shymkent");
      await phone.getByRole("button", { name: "Send", exact: true }).click();
      await openPreviewResult(phone);
      await expect
        .poll(async () => JSON.parse(await phone.locator("pre").innerText()))
        .toEqual({
          __9ba1c9: sport,
          ____133f36: "0_Есімі_жазылатын_(Именная)",
          _68d224: "Aruzhan",
          _ebfcfb: "Shymkent",
        });
      await phone
        .getByRole("button", { name: "Restart preview", exact: true })
        .click();
    }
    await phone
      .getByRole("button", { name: "Other sport Write your sport" })
      .click();
    await expect(
      phone.getByRole("textbox", { name: "Which sport? *", exact: true })
    ).toHaveValue("");
    await phone.getByRole("button", { name: "Back", exact: true }).click();
    await expect(
      phone.getByRole("heading", { name: "Choose a sport", exact: true })
    ).toBeFocused();
    await phone
      .getByRole("button", { name: "Other sport Write your sport" })
      .click();
    await phone
      .getByRole("radio", { name: "Classic Standard design for this sport" })
      .click();
    await phone
      .getByRole("textbox", { name: "Athlete's name *", exact: true })
      .fill("Ali");
    await phone
      .getByRole("textbox", { name: "City / region *", exact: true })
      .fill("Almaty");
    await expect(
      phone.getByRole("button", { name: "Send", exact: true })
    ).toBeDisabled();
    await phone
      .getByRole("textbox", { name: "Which sport? *", exact: true })
      .fill("Chess");
    await phone.getByRole("button", { name: "Send", exact: true }).click();
    await openPreviewResult(phone);
    await expect
      .poll(async () => JSON.parse(await phone.locator("pre").innerText()))
      .toEqual({
        __9ba1c9: "4_Басқа",
        other_sport: "Chess",
        ____133f36: "1_Классикалық",
        _68d224: "Ali",
        _ebfcfb: "Almaty",
      });
    expect(provider.mutations).toEqual([]);
    await expect
      .poll(() =>
        page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth
        )
      )
      .toBe(true);
    await capture(page, `${viewport.name}-demoshop-preview`);
    if (viewport.name === "mobile")
      await workspace
        .getByRole("button", { name: "Screens & content", exact: true })
        .click();
    await workspace
      .getByTestId("flow-authoring-outline")
      .getByRole("button", { name: "DETAILS Design and name", exact: true })
      .click();
    if (viewport.name === "mobile")
      await selectAuthoringPane(workspace, "outline");
    await workspace
      .getByTestId("flow-authoring-outline")
      .getByRole("button", { name: "Athlete's name", exact: true })
      .click();
    const label = dialog.getByRole("textbox", {
      name: "Field label",
      exact: true,
    });
    await label.fill("Athlete");
    await label.press("End");
    await label.pressSequentially(" full name");
    await expect(label).toHaveText("Athlete full name");
    await expect(label).toBeFocused();
    await dialog
      .getByRole("textbox", { name: "Helper text", exact: true })
      .fill("Write the full name");
    await capture(page, `${viewport.name}-demoshop-properties`);
    await dialog
      .getByRole("button", { name: "Save draft", exact: true })
      .click();
    await expect(
      dialog.getByText("Unsaved changes", { exact: true })
    ).toHaveCount(0);
    const saved = provider.mutations.find(
      mutation => mutation.operation === "update_json"
    );
    const expected = JSON.parse(JSON.stringify(DEMOSHOP_FLOW_JSON));
    expected.screens[1].layout.children[1].label = "Athlete full name";
    expected.screens[1].layout.children[1]["helper-text"] =
      "Write the full name";
    expect(JSON.parse(String(saved?.flowJson))).toEqual(expected);
    await expect(
      dialog.getByRole("button", { name: "Publish", exact: true })
    ).toBeEnabled();
    expect(
      provider.mutations.some(mutation => mutation.operation === "publish")
    ).toBe(false);
    expect(provider.errors).toEqual([]);
  });
}

const artifactDir =
  process.env.FLOW_BROWSER_ARTIFACT_DIR ||
  join(tmpdir(), "airi-whatsapp-flows-browser");

for (const viewport of [
  { name: "live desktop", width: 1298, height: 686, narrow: false },
  { name: "short desktop dark", width: 1280, height: 720, narrow: false },
  { name: "short mobile", width: 390, height: 568, narrow: true },
]) {
  test(`${viewport.name} layout keeps the editor and long preview reachable above fixed actions`, async ({
    page,
  }) => {
    await page.setViewportSize({
      width: viewport.width,
      height: viewport.height,
    });
    if (viewport.name.endsWith("dark")) {
      await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
      await page.addInitScript(() => {
        document.addEventListener("DOMContentLoaded", () =>
          document.documentElement.classList.add("dark")
        );
      });
    }
    const provider = await mockProviderBoundary(page, {
      draftFixture: "longForm",
    });
    await openManager(page);
    await page
      .getByRole("listitem")
      .filter({ hasText: "Contact form" })
      .getByRole("button", { name: "Edit", exact: true })
      .click();
    const dialog = page.getByRole("dialog");
    const workspace = dialog.getByTestId("flow-authoring-workspace");
    const body = dialog.getByTestId("flow-editor-body");
    const actions = dialog.getByTestId("flow-editor-actions");
    const outline = workspace.getByTestId("flow-authoring-outline");
    const editor = workspace.getByTestId("flow-authoring-editor");
    const preview = workspace.getByTestId("flow-authoring-preview");
    await expect(editor).toBeVisible();
    await capture(page, `${viewport.name.replaceAll(" ", "-")}-editor-initial`);
    await expect(
      dialog.getByRole("button", {
        name: enMessages.WhatsAppFlows.editor.advanced,
        exact: true,
      })
    ).toBeVisible();
    await expect(
      dialog.getByRole("tab", { name: "JSON", exact: true })
    ).toHaveCount(0);
    await expectFullyVisible(actions);
    await expectFullyVisible(
      actions.getByRole("button", { name: "Save draft", exact: true })
    );
    await expectFullyVisible(
      actions.getByRole("button", { name: "Publish", exact: true })
    );
    if (viewport.narrow) {
      await expect(
        workspace.getByRole("button", { name: "Edit", exact: true })
      ).toHaveAttribute("aria-pressed", "true");
      await expect(outline).toBeHidden();
      await expect(preview).toBeHidden();
      await expectPaneContained(editor, body, actions);
    } else {
      await expectEditorColumns(workspace);
      for (const pane of [outline, editor, preview]) {
        await expectPaneContained(pane, body, actions);
      }
    }

    await editor.getByRole("button", { name: "Screen", exact: true }).click();
    const screenAdvanced = editor.getByTestId("flow-screen-advanced");
    await expect(screenAdvanced).toHaveJSProperty("open", false);
    await screenAdvanced.locator(":scope > summary").click();
    await expect(screenAdvanced).toHaveJSProperty("open", true);
    const actionAdvanced = editor.getByTestId("flow-action-advanced");
    await expect(actionAdvanced).toHaveJSProperty("open", false);
    await actionAdvanced.locator(":scope > summary").click();
    await scrollRegionToEnd(editor);
    await expectFullyVisible(
      editor.getByRole("button", { name: "Remove screen", exact: true })
    );
    await scrollTargetToEnd(
      editor.getByRole("button", { name: "Add value", exact: true }),
      editor
    );
    await expectFullyVisible(
      editor.getByRole("button", { name: "Add value", exact: true })
    );
    await expectAboveActions(
      editor.getByRole("button", { name: "Add value", exact: true }),
      actions
    );
    await screenAdvanced.locator(":scope > summary").click();
    await expect(screenAdvanced).toHaveJSProperty("open", false);

    if (viewport.narrow) await selectAuthoringPane(workspace, "outline");
    await scrollRegionToEnd(outline);
    const finalComponent = outline.getByRole("button", {
      name: "Final answer",
      exact: true,
    });
    await expectFullyVisible(finalComponent);
    if (viewport.narrow) {
      await finalComponent.focus();
      await page.keyboard.press("Enter");
      await expect(editor).toBeFocused();
    } else await finalComponent.click();
    await expect(
      editor.getByRole("textbox", { name: "Field label", exact: true })
    ).toHaveText("Final answer");
    await expect(editor.getByTestId("flow-field-advanced")).toHaveJSProperty(
      "open",
      false
    );

    if (viewport.narrow) await selectAuthoringPane(workspace, "preview");
    await expectPaneContained(preview, body, actions);
    await expect
      .poll(() =>
        preview.evaluate(element => element.scrollHeight > element.clientHeight)
      )
      .toBe(true);
    await scrollRegionToEnd(preview);
    const finalAnswer = preview.getByRole("textbox", {
      name: "Final answer",
      exact: true,
    });
    const submit = preview.getByRole("button", {
      name: "Finish survey",
      exact: true,
    });
    await expectFullyVisible(finalAnswer);
    await expectFullyVisible(submit);
    await expectAboveActions(submit, actions);
    for (let index = 1; index < 8; index += 1) {
      await preview
        .getByRole("textbox", { name: `Question ${index}`, exact: true })
        .fill(`Answer ${index}`);
    }
    await finalAnswer.fill("Completed");
    await scrollRegionToEnd(preview);
    await submit.click();
    await openPreviewResult(preview);
    await scrollRegionToEnd(preview);
    expect(
      await preview.locator("pre").evaluate(element => ({
        contentFits: element.scrollHeight <= element.clientHeight,
        overflow: getComputedStyle(element).overflowY,
      }))
    ).toEqual({ contentFits: true, overflow: "visible" });
    await expectFullyVisible(
      preview.getByRole("button", { name: "Restart preview", exact: true })
    );
    expect(JSON.parse(await preview.locator("pre").innerText())).toEqual(
      Object.fromEntries(
        Array.from({ length: 8 }, (_, index) => [
          `answer_${index + 1}`,
          index === 7 ? "Completed" : `Answer ${index + 1}`,
        ])
      )
    );
    await expectFullyVisible(actions);
    await capture(page, `${viewport.name.replaceAll(" ", "-")}-bounded-editor`);
    const completion = await preview.locator("pre").innerText();
    if (viewport.narrow) {
      await selectAuthoringPane(workspace, "editor");
      await expect(
        editor.getByRole("textbox", { name: "Field label", exact: true })
      ).toHaveText("Final answer");
      await selectAuthoringPane(workspace, "preview");
      await expect(preview.locator("pre")).toHaveText(completion);
    }

    const advancedButton = dialog.getByRole("button", {
      name: enMessages.WhatsAppFlows.editor.advanced,
      exact: true,
    });
    await advancedButton.click();
    const advancedPopover = page.getByRole("dialog", {
      name: enMessages.WhatsAppFlows.editor.settings,
      exact: true,
    });
    await expectFullyVisible(advancedPopover);
    await page.keyboard.press("Escape");
    await expect(advancedPopover).toBeHidden();
    await expect(advancedButton).toBeFocused();
    await expect(preview.locator("pre")).toHaveText(completion);
    await selectJsonEditor(dialog);
    const source = dialog.getByRole("textbox", {
      name: enMessages.WhatsAppFlows.editor.sourceLabel,
      exact: true,
    });
    const original = await page.evaluate(() => {
      return (
        window as typeof window & {
          __flowFixtures: Record<string, unknown>;
        }
      ).__flowFixtures.longForm;
    });
    expect(JSON.parse(await source.inputValue())).toEqual(original);
    await dialog.getByRole("tab", { name: "Visual", exact: true }).click();
    await expect(preview.locator("pre")).toHaveText(completion);
    await expect(finalAnswer).toHaveValue("Completed");
    expect(provider.mutations).toEqual([]);
    expect(provider.errors).toEqual([]);
  });
}

test("Scenario Builder uses the same graph controls and phone preview in a narrow panel", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.goto("/whatsapp-flows-browser.html?surface=scenario");
  const surface = page.getByTestId("scenario-flow-surface");
  const workspace = surface.getByTestId("flow-authoring-workspace");
  await workspace
    .getByRole("button", { name: "WhatsApp preview", exact: true })
    .click();
  const phone = workspace
    .getByRole("button", { name: "Restart preview", exact: true })
    .locator("..");
  await phone
    .getByRole("button", { name: "Football, basketball", exact: true })
    .click();
  await expect(
    phone.getByRole("heading", { name: "Design and name", exact: true })
  ).toBeVisible();
  await workspace
    .getByRole("button", { name: "Screens & content", exact: true })
    .click();
  await workspace
    .getByTestId("flow-authoring-outline")
    .getByRole("button", { name: "OTHER_DETAILS Design and name", exact: true })
    .click();
  await selectAuthoringPane(workspace, "outline");
  await workspace
    .getByTestId("flow-authoring-outline")
    .getByRole("button", { name: "Which sport?", exact: true })
    .click();
  const label = workspace.getByRole("textbox", {
    name: "Field label",
    exact: true,
  });
  await label.fill("Your sport");
  await expect(label).toBeFocused();
  await workspace
    .getByRole("button", { name: "WhatsApp preview", exact: true })
    .click();
  await expect(
    phone.getByRole("textbox", { name: "Your sport *", exact: true })
  ).toBeVisible();
  expect(
    await surface.evaluate(
      element => element.scrollWidth <= element.clientWidth
    )
  ).toBe(true);
  await capture(page, "scenario-demoshop-narrow");
  expect(errors).toEqual([]);
});

for (const width of [300, 640, 960]) {
  test(`Scenario Builder ${width}px panel keeps long editing and preview content inside its height`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    const provider = await mockProviderBoundary(page);
    await page.goto(
      `/whatsapp-flows-browser.html?surface=scenario&fixture=longForm&width=${width}&height=420`
    );
    const surface = page.getByTestId("scenario-flow-surface");
    const workspace = surface.getByTestId("flow-authoring-workspace");
    const outline = workspace.getByTestId("flow-authoring-outline");
    const editor = workspace.getByTestId("flow-authoring-editor");
    const preview = workspace.getByTestId("flow-authoring-preview");
    // Scenario Builder deliberately reuses its canonical host scroller; its
    // natural-height lanes do not have to fit in the host all at once.
    const host = workspace.locator("..");
    const narrow = width < 896;
    await expect(editor).toBeVisible();
    await expectPaneContained(host, surface);
    await capture(page, `scenario-layout-${width}px-initial`);
    if (narrow) {
      await expect(
        workspace.getByRole("button", { name: "Edit", exact: true })
      ).toHaveAttribute("aria-pressed", "true");
      await expect(outline).toBeHidden();
      await expect(preview).toBeHidden();
      await selectAuthoringPane(workspace, "outline");
    } else {
      await expectEditorColumns(workspace);
    }
    const lastComponent = outline.getByRole("button", {
      name: "Final answer",
      exact: true,
    });
    await scrollTargetToEnd(lastComponent, host);
    await expectFullyVisible(lastComponent);
    if (narrow) {
      await lastComponent.focus();
      await page.keyboard.press("Enter");
      await expect(editor).toBeFocused();
    } else await lastComponent.click();
    await expect(
      editor.getByRole("textbox", { name: "Field label", exact: true })
    ).toHaveText("Final answer");
    await expect(editor.getByTestId("flow-field-advanced")).toHaveJSProperty(
      "open",
      false
    );
    await editor.getByRole("button", { name: "Screen", exact: true }).click();
    const advanced = editor.getByTestId("flow-screen-advanced");
    await expect(advanced).toHaveJSProperty("open", false);
    await advanced.locator(":scope > summary").click();
    const actionAdvanced = editor.getByTestId("flow-action-advanced");
    await expect(actionAdvanced).toHaveJSProperty("open", false);
    await actionAdvanced.locator(":scope > summary").click();
    const lastPayloadAction = editor.getByRole("button", {
      name: "Add value",
      exact: true,
    });
    await scrollTargetToEnd(lastPayloadAction, host);
    await expectFullyVisible(lastPayloadAction);
    if (narrow) await selectAuthoringPane(workspace, "preview");
    const finalAnswer = preview.getByRole("textbox", {
      name: "Final answer",
      exact: true,
    });
    const submit = preview.getByRole("button", {
      name: "Finish survey",
      exact: true,
    });
    await scrollTargetToEnd(submit, host);
    await expectFullyVisible(finalAnswer);
    await expectFullyVisible(submit);
    for (let index = 1; index < 8; index += 1) {
      await preview
        .getByRole("textbox", { name: `Question ${index}`, exact: true })
        .fill(`Answer ${index}`);
    }
    await finalAnswer.fill("Scenario answer");
    await scrollTargetToEnd(submit, host);
    await submit.click();
    await openPreviewResult(preview);
    const restart = preview.getByRole("button", {
      name: "Restart preview",
      exact: true,
    });
    await scrollTargetToEnd(restart, host);
    expect(
      await preview.locator("pre").evaluate(element => ({
        contentFits: element.scrollHeight <= element.clientHeight,
        overflow: getComputedStyle(element).overflowY,
      }))
    ).toEqual({ contentFits: true, overflow: "visible" });
    await expectFullyVisible(restart);
    await expectPaneContained(host, surface);
    expect(JSON.parse(await preview.locator("pre").innerText())).toMatchObject({
      answer_8: "Scenario answer",
    });
    if (narrow) {
      await selectAuthoringPane(workspace, "editor");
      await selectAuthoringPane(workspace, "preview");
      await expect(finalAnswer).toHaveValue("Scenario answer");
      await expect(preview.locator("pre")).toContainText("Scenario answer");
    }
    expect(
      await surface.evaluate(
        element => element.scrollWidth <= element.clientWidth
      )
    ).toBe(true);
    await scrollTargetToEnd(restart, host);
    await capture(page, `scenario-layout-${width}px`);
    expect(provider.mutations).toEqual([]);
    expect(provider.errors).toEqual([]);
  });
}

const ids = {
  draft: "1234567890",
  advanced: "1234567891",
  published: "1234567892",
  managed: "1234567893",
  clone: "1234567894",
};
const providerTeardownByPage = new WeakMap<Page, () => Promise<void>>();

test.afterEach(async ({ page }) => {
  const teardown = providerTeardownByPage.get(page);
  if (!teardown) return;
  try {
    await teardown();
  } finally {
    providerTeardownByPage.delete(page);
  }
});

async function mockProviderBoundary(
  page: Page,
  options: {
    draftStatus?: "DRAFT" | "THROTTLED";
    flowCount?: number;
    failPreviewOnce?: string;
    holdDetailReads?: boolean;
    draftJson?: unknown;
    draftFixture?: "longForm";
  } = {}
) {
  const mutations: Array<Record<string, unknown>> = [];
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => {
    if (message.type() === "error") errors.push(message.text());
  });
  const flows: Array<Record<string, unknown>> = [
    {
      id: ids.draft,
      name: "Contact form",
      status: options.draftStatus ?? "DRAFT",
      categories: ["CONTACT_US"],
      json_version: "7.3",
      validation_errors: [],
    },
    {
      id: ids.advanced,
      name: "Advanced form",
      status: "DRAFT",
      categories: ["SURVEY"],
      json_version: "7.3",
      validation_errors: [],
    },
    {
      id: ids.published,
      name: "Published booking",
      status: "PUBLISHED",
      categories: ["APPOINTMENT_BOOKING"],
      json_version: "7.3",
      validation_errors: [],
    },
    {
      id: ids.managed,
      name: "Scenario registration",
      status: "PUBLISHED",
      categories: ["LEAD_GENERATION"],
      json_version: "7.3",
      validation_errors: [],
      managedArtifact: {
        operationId: "browser-operation",
        scenarioId: "browser-scenario",
        ledgerStatus: "COMPLETED",
        stage: "ATTACHED",
        cleanupEligibility: "NOT_TERMINAL",
      },
    },
  ];
  for (let index = flows.length; index < (options.flowCount ?? 4); index += 1) {
    flows.push({
      id: String(1234567900 + index),
      name: `Gallery form ${String(index + 1).padStart(2, "0")}`,
      status: "DRAFT",
      categories: ["CONTACT_US"],
      json_version: "7.3",
      validation_errors: [],
    });
  }
  const documents = new Map<string, unknown>();
  if (options.draftJson) documents.set(ids.draft, options.draftJson);
  const detailReads: Array<{ flowId: string; includeJson: boolean }> = [];
  let activeDetailReads = 0;
  let maxActiveDetailReads = 0;
  let detailReadsReleased = !options.holdDetailReads;
  const heldDetailReads: Array<() => void> = [];
  const releaseDetailReads = () => {
    detailReadsReleased = true;
    heldDetailReads.splice(0).forEach(resolve => resolve());
  };
  let previewFailureRemaining = options.failPreviewOnce;
  let validationError = false;
  await page.route("**/api/whatsapp/flows**", async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "GET") {
      const id = url.searchParams.get("flowId");
      if (!id) {
        await route.fulfill({
          json: {
            flows,
            sourceId: "browser-source",
            readiness: {
              hasWabaId: true,
              hasPhoneNumberId: true,
              hasAccessToken: true,
            },
          },
        });
        return;
      }
      detailReads.push({
        flowId: id,
        includeJson: url.searchParams.get("includeJson") === "true",
      });
      activeDetailReads += 1;
      maxActiveDetailReads = Math.max(maxActiveDetailReads, activeDetailReads);
      try {
        if (!detailReadsReleased) {
          await new Promise<void>(resolve => heldDetailReads.push(resolve));
        }
        const index = flows.findIndex(flow => flow.id === id);
        const fixtureName =
          id === ids.draft && options.draftFixture
            ? options.draftFixture
            : id === ids.advanced
              ? "advanced"
              : id === ids.published || id === ids.clone || index % 3 === 2
                ? "booking"
                : id === ids.managed || (index % 3 === 0 && index > 0)
                  ? "registration"
                  : "basic";
        const fixture = await page.evaluate((name: string) => {
          const windowFixtures = window as typeof window & {
            __flowFixtures: Record<string, unknown>;
          };
          return windowFixtures.__flowFixtures[name];
        }, fixtureName);
        const failPreview = previewFailureRemaining === id;
        if (failPreview) previewFailureRemaining = undefined;
        await route.fulfill({
          json: {
            flow: flows.find(flow => flow.id === id),
            flowJson: failPreview ? null : (documents.get(id) ?? fixture),
            flowJsonError: failPreview ? "Temporary preview error" : null,
          },
        });
      } finally {
        activeDetailReads -= 1;
      }
      return;
    }
    const body = request.postDataJSON() as Record<string, unknown>;
    mutations.push({ method: request.method(), ...body });
    const flow = flows.find(item => item.id === body.flowId);
    if (request.method() === "PUT") {
      const clone = {
        ...flows.find(item => item.id === body.cloneFlowId),
        id: ids.clone,
        name: body.name,
        status: "DRAFT",
        categories: body.categories,
        managedArtifact: undefined,
      };
      flows.push(clone);
      await route.fulfill({
        json: { success: true, flowId: ids.clone, flow: clone },
      });
      return;
    }
    if (body.operation === "update_json") {
      if (validationError) {
        await route.fulfill({
          json: {
            success: true,
            error: "Flow JSON validation failed",
            validation_errors: [
              {
                error: "INVALID_PROPERTY",
                error_type: "JSON_SCHEMA_ERROR",
                message: "Test provider rejected field label",
                line_start: 8,
                column_start: 3,
              },
            ],
          },
        });
        return;
      }
      documents.set(String(body.flowId), JSON.parse(String(body.flowJson)));
    }
    if (body.operation === "update" && flow) {
      if (body.name) flow.name = body.name;
      if (body.categories) flow.categories = body.categories;
    }
    if (body.operation === "publish" && flow) flow.status = "PUBLISHED";
    await route.fulfill({
      json: { success: true, flow, messageId: "mock-message" },
    });
  });
  await page.route("**/favicon.ico", route => route.fulfill({ status: 204 }));
  providerTeardownByPage.set(page, async () => {
    releaseDetailReads();
    // Lazy previews can schedule the next asset as a previous response arrives.
    // Keep the page alive until every already-running mock callback has finished.
    await page.unrouteAll({ behavior: "wait" });
    expect(errors).toEqual([]);
  });
  return {
    mutations,
    errors,
    rejectValidation: () => {
      validationError = true;
    },
    documents,
    flows,
    detailReads,
    maxActiveDetailReads: () => maxActiveDetailReads,
    releaseDetailReads,
  };
}

async function capture(page: Page, name: string) {
  await mkdir(artifactDir, { recursive: true });
  await expect(page.locator("[data-sonner-toast]")).toHaveCount(0, {
    timeout: 7000,
  });
  await page.screenshot({
    path: join(artifactDir, `${name}.png`),
    fullPage: false,
    animations: "disabled",
  });
}

async function openManager(page: Page) {
  await page.goto("/whatsapp-flows-browser.html");
  await expect(page).toHaveTitle("WhatsApp Flows browser validation");
  await expect(page.getByText("Contact form", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("heading", {
      level: 1,
      name: enMessages.WhatsAppFlows.title,
      exact: true,
    })
  ).toHaveCount(1);
  await expect(
    page.getByText(enMessages.WhatsAppFlows.description, { exact: true })
  ).toHaveCount(1);
  await expect(page.getByRole("table")).toHaveCount(0);
  await expect(page.locator("vite-error-overlay, nextjs-portal")).toHaveCount(
    0
  );
}

async function selectAuthoringPane(
  workspace: Locator,
  pane: "outline" | "editor" | "preview"
) {
  const name = {
    outline: "Screens & content",
    editor: "Edit",
    preview: "WhatsApp preview",
  }[pane];
  await workspace
    .getByTestId("flow-authoring-pane-switcher")
    .getByRole("button", { name, exact: true })
    .click();
  await expect(workspace.getByTestId(`flow-authoring-${pane}`)).toBeVisible();
}

async function selectJsonEditor(
  dialog: Locator,
  advancedLabel = enMessages.WhatsAppFlows.editor.advanced
) {
  const jsonTab = dialog.getByRole("tab", { name: "JSON", exact: true });
  if (await jsonTab.count()) {
    await jsonTab.click();
  } else {
    await dialog
      .getByRole("button", { name: advancedLabel, exact: true })
      .click();
    await dialog
      .page()
      .getByRole("button", { name: "JSON", exact: true })
      .click();
  }
  await expect(jsonTab).toHaveAttribute("data-state", "active");
}

async function openPreviewResult(preview: Locator) {
  const result = preview.locator("details");
  await expect(result).toHaveCount(1);
  await expect(result).toHaveJSProperty("open", false);
  await result.locator(":scope > summary").click();
  await expect(result).toHaveJSProperty("open", true);
}

/** Visibility must include every clipping ancestor, not just a non-empty box. */
async function expectFullyVisible(target: Locator) {
  await expect
    .poll(() =>
      target.evaluate(async element => {
        // Let the browser apply overflow and containing-block rules. In
        // particular, a fixed drawer can escape the page body's scroll lock.
        const entry = await new Promise<IntersectionObserverEntry>(resolve => {
          const observer = new IntersectionObserver(entries => {
            observer.disconnect();
            resolve(entries[0]);
          });
          observer.observe(element);
        });
        const rect = entry.boundingClientRect;
        const visible = entry.intersectionRect;
        const center = document.elementFromPoint(
          rect.left + rect.width / 2,
          rect.top + rect.height / 2
        );
        const unclipped =
          rect.width > 0 &&
          rect.height > 0 &&
          rect.left >= visible.left - 1 &&
          rect.right <= visible.right + 1 &&
          rect.top >= visible.top - 1 &&
          rect.bottom <= visible.bottom + 1;
        // Disabled controls deliberately ignore pointer events; their full box
        // must still fit, while enabled controls must receive the center hit.
        const hitTarget =
          element.matches(":disabled") ||
          (!!center && element.contains(center));
        if (!unclipped || !hitTarget) {
          return {
            unclipped,
            hitTarget,
            rect: {
              left: rect.left,
              right: rect.right,
              top: rect.top,
              bottom: rect.bottom,
            },
            clippingRect: {
              left: visible.left,
              right: visible.right,
              top: visible.top,
              bottom: visible.bottom,
            },
            hitElement: center?.tagName,
          };
        }
        return { unclipped, hitTarget };
      })
    )
    .toEqual({ unclipped: true, hitTarget: true });
}

async function expectAboveActions(target: Locator, actions: Locator) {
  const targetBox = await target.boundingBox();
  const actionsBox = await actions.boundingBox();
  expect(targetBox).not.toBeNull();
  expect(actionsBox).not.toBeNull();
  expect(targetBox!.y + targetBox!.height).toBeLessThanOrEqual(actionsBox!.y);
}

async function expectPaneContained(
  pane: Locator,
  body: Locator,
  actions?: Locator
) {
  await expectFullyVisible(pane);
  const paneBox = await pane.boundingBox();
  const bodyBox = await body.boundingBox();
  expect(paneBox).not.toBeNull();
  expect(bodyBox).not.toBeNull();
  expect(paneBox!.height).toBeGreaterThanOrEqual(160);
  expect(paneBox!.x).toBeGreaterThanOrEqual(bodyBox!.x - 1);
  expect(paneBox!.x + paneBox!.width).toBeLessThanOrEqual(
    bodyBox!.x + bodyBox!.width + 1
  );
  expect(paneBox!.y).toBeGreaterThanOrEqual(bodyBox!.y - 1);
  expect(paneBox!.y + paneBox!.height).toBeLessThanOrEqual(
    bodyBox!.y + bodyBox!.height + 1
  );
  expect(
    await pane.evaluate(element => element.scrollWidth <= element.clientWidth)
  ).toBe(true);
  if (actions) await expectAboveActions(pane, actions);
}

async function expectEditorColumns(workspace: Locator) {
  const outline = workspace.getByTestId("flow-authoring-outline");
  const editor = workspace.getByTestId("flow-authoring-editor");
  const preview = workspace.getByTestId("flow-authoring-preview");
  const boxes = await Promise.all(
    [outline, editor, preview].map(pane => pane.boundingBox())
  );
  expect(boxes.every(Boolean)).toBe(true);
  expect(boxes[0]!.x + boxes[0]!.width).toBeLessThanOrEqual(boxes[1]!.x);
  expect(boxes[1]!.x + boxes[1]!.width).toBeLessThanOrEqual(boxes[2]!.x);
  expect(boxes[1]!.width).toBeGreaterThanOrEqual(280);
  expect(boxes[2]!.width).toBeGreaterThanOrEqual(260);
  expect(
    await outline.evaluate(element => {
      const editor = element.parentElement?.querySelector(
        '[data-testid="flow-authoring-editor"]'
      );
      const preview = element.parentElement?.querySelector(
        '[data-testid="flow-authoring-preview"]'
      );
      return (
        !!editor &&
        !!preview &&
        !!(
          element.compareDocumentPosition(editor) &
          Node.DOCUMENT_POSITION_FOLLOWING
        ) &&
        !!(
          editor.compareDocumentPosition(preview) &
          Node.DOCUMENT_POSITION_FOLLOWING
        )
      );
    })
  ).toBe(true);
}

async function scrollRegionToEnd(region: Locator) {
  await region.evaluate(element => {
    element.scrollTop = element.scrollHeight;
  });
  await expect
    .poll(() =>
      region.evaluate(
        element =>
          element.scrollTop + element.clientHeight >= element.scrollHeight - 1
      )
    )
    .toBe(true);
}

async function scrollTargetToEnd(target: Locator, region: Locator) {
  const targetBox = await target.boundingBox();
  const regionBox = await region.boundingBox();
  expect(targetBox).not.toBeNull();
  expect(regionBox).not.toBeNull();
  await region.evaluate(
    (element, delta) => {
      element.scrollTop += delta;
    },
    targetBox!.y + targetBox!.height - regionBox!.y - regionBox!.height + 12
  );
  await expectFullyVisible(target);
  await expectFullyVisible(region);
}

async function expectGalleryGeometry(page: Page) {
  await expect
    .poll(async () => {
      return page
        .locator('[role="listitem"][aria-labelledby]')
        .evaluateAll(cards => {
          const boxes = cards.map(card => card.getBoundingClientRect());
          const gallery = cards[0]
            ?.closest('[role="list"]')
            ?.getBoundingClientRect();
          let overlaps = 0;
          for (let first = 0; first < boxes.length; first += 1) {
            for (let second = first + 1; second < boxes.length; second += 1) {
              const horizontal =
                Math.min(boxes[first].right, boxes[second].right) -
                Math.max(boxes[first].left, boxes[second].left);
              const vertical =
                Math.min(boxes[first].bottom, boxes[second].bottom) -
                Math.max(boxes[first].top, boxes[second].top);
              if (horizontal > 1 && vertical > 1) overlaps += 1;
            }
          }
          return {
            overlaps,
            overflow: document.documentElement.scrollWidth > window.innerWidth,
            invalidBounds: boxes.some(
              box =>
                box.width <= 0 ||
                box.height <= 0 ||
                box.left < -1 ||
                box.right > window.innerWidth + 1 ||
                !gallery ||
                box.top < gallery.top - 1 ||
                box.bottom > gallery.bottom + 1
            ),
          };
        });
    })
    .toEqual({ overlaps: 0, overflow: false, invalidBounds: false });
}

test("desktop manager renders real translated components without provider writes", async ({
  page,
}) => {
  const provider = await mockProviderBoundary(page);
  await openManager(page);
  await expect(
    page.getByRole("link", { name: "Read Flows docs" })
  ).toHaveAttribute(
    "href",
    "https://developers.facebook.com/documentation/business-messaging/whatsapp/flows/guides"
  );
  await expect(
    page
      .getByRole("listitem")
      .filter({ hasText: "Contact form" })
      .getByText("Name", { exact: true })
  ).toBeVisible();
  await capture(page, "desktop-manager");
  expect(provider.mutations).toEqual([]);
  expect(provider.errors).toEqual([]);
});

for (const appearance of [
  { name: "desktop-gallery-light", width: 1440, height: 1000, dark: false },
  { name: "desktop-gallery-dark", width: 1440, height: 1000, dark: true },
  { name: "mobile-gallery", width: 390, height: 844, dark: false },
]) {
  test(`${appearance.name} shows truthful static previews and keeps cards usable`, async ({
    page,
  }) => {
    await page.setViewportSize({
      width: appearance.width,
      height: appearance.height,
    });
    await page.emulateMedia({
      colorScheme: appearance.dark ? "dark" : "light",
      reducedMotion: "reduce",
    });
    if (appearance.dark) {
      await page.addInitScript(() => {
        document.addEventListener("DOMContentLoaded", () =>
          document.documentElement.classList.add("dark")
        );
      });
    }
    const provider = await mockProviderBoundary(page);
    await openManager(page);
    const contact = page
      .getByRole("listitem")
      .filter({ hasText: "Contact form" });
    await expect(
      contact.getByRole("heading", { name: "Contact details", exact: true })
    ).toBeVisible();
    const mobileSurface = contact.getByRole("region", {
      name: "Contact details",
      exact: true,
    });
    await expect(mobileSurface).toBeVisible();
    expect((await mobileSurface.boundingBox())?.width).toBeLessThanOrEqual(340);
    await expect(mobileSurface.getByText("Submit", { exact: true })).toHaveCSS(
      "background-color",
      "rgb(27, 135, 85)"
    );
    await expect(contact).toHaveCSS("border-top-width", "0px");
    await expect(
      contact.getByText("Use the name we should contact you by", {
        exact: true,
      })
    ).toBeVisible();
    await expect(
      contact.locator(
        'input, select, textarea, [contenteditable="true"], [role="combobox"]'
      )
    ).toHaveCount(0);
    const primaryEdit = contact.getByRole("button", {
      name: "Edit",
      exact: true,
    });
    await expect(primaryEdit).toBeVisible();
    if (appearance.width < 760) {
      await expect(primaryEdit).toBeInViewport({ ratio: 1 });
    }
    const preferences = contact.getByRole("button", {
      name: "Your preferences",
      exact: true,
    });
    await preferences.focus();
    await page.keyboard.press("Enter");
    await expect(preferences).toHaveAttribute("aria-pressed", "true");
    await expect(
      contact.getByRole("heading", { name: "Your preferences", exact: true })
    ).toBeVisible();
    for (const text of [
      "What interests you?",
      "Preferred plan",
      "Starter",
      "Growth",
    ]) {
      await expect(contact.getByText(text, { exact: true })).toBeVisible();
    }
    for (const option of ["Consultation", "Product demo"]) {
      await expect(contact.getByText(option, { exact: true })).toHaveCount(0);
    }
    await expect(
      contact.locator('input, select, textarea, [contenteditable="true"]')
    ).toHaveCount(0);
    if (appearance.width < 760) {
      await expect(primaryEdit).toBeInViewport({ ratio: 1 });
    }
    const advanced = page
      .getByRole("listitem")
      .filter({ hasText: "Advanced form" });
    await advanced.scrollIntoViewIfNeeded();
    await expect(
      advanced.getByText("Local preview does not support TextHeading.", {
        exact: true,
      })
    ).toBeVisible();
    await expect(
      advanced.getByText("Advanced Flow", { exact: true })
    ).toHaveCount(0);
    await expect(
      advanced.getByRole("heading", {
        name: "Conditional welcome",
        exact: true,
      })
    ).toBeVisible();
    await expect(advanced.getByText("Welcome", { exact: true })).toHaveCount(0);
    await expect(
      advanced.locator('input, select, textarea, [contenteditable="true"]')
    ).toHaveCount(0);
    await page
      .getByRole("listitem")
      .filter({ hasText: "Scenario registration" })
      .scrollIntoViewIfNeeded();
    await expect(page.getByText("Product news", { exact: true })).toBeVisible();
    await expectGalleryGeometry(page);
    const dimensions = await page
      .locator('[role="listitem"][aria-labelledby]')
      .evaluateAll(cards =>
        cards.map(card => ({
          x: Math.round(card.getBoundingClientRect().x),
          height: Math.round(card.getBoundingClientRect().height),
        }))
      );
    expect(new Set(dimensions.map(card => card.height)).size).toBeGreaterThan(
      1
    );
    expect(new Set(dimensions.map(card => card.x)).size).toBe(
      appearance.width < 760 ? 1 : 3
    );
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect(primaryEdit).toBeInViewport({ ratio: 1 });
    await capture(page, appearance.name);
    await primaryEdit.click();
    await expect(
      page.getByRole("dialog").getByRole("tab", { name: "Visual", exact: true })
    ).toHaveAttribute("data-state", "active");
    expect(provider.mutations).toEqual([]);
    expect(provider.errors).toEqual([]);
  });
}

test("gallery preview failure retries its asset without provider mutations", async ({
  page,
}) => {
  const provider = await mockProviderBoundary(page, {
    failPreviewOnce: ids.draft,
  });
  await openManager(page);
  const contact = page
    .getByRole("listitem")
    .filter({ hasText: "Contact form" });
  await expect(
    contact.getByText("Preview could not be loaded.", { exact: true })
  ).toBeVisible();
  await contact.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(
    contact.getByRole("heading", { name: "Contact details", exact: true })
  ).toBeVisible();
  await expect(contact.getByText("Name", { exact: true })).toBeVisible();
  expect(
    provider.detailReads.filter(read => read.flowId === ids.draft)
  ).toHaveLength(2);
  expect(provider.mutations).toEqual([]);
  expect(provider.errors).toEqual([]);
});

test("gallery initially bounds cards and visible asset reads to three concurrent requests", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  const provider = await mockProviderBoundary(page, {
    flowCount: 24,
    holdDetailReads: true,
  });
  try {
    await openManager(page);
    await expect(
      page.locator('[role="listitem"][aria-labelledby]')
    ).toHaveCount(12);
    await expect.poll(() => provider.detailReads.length).toBeGreaterThan(0);
    expect(provider.maxActiveDetailReads()).toBeLessThanOrEqual(3);
    expect(provider.detailReads.length).toBeLessThanOrEqual(3);
    provider.releaseDetailReads();
    const contact = page
      .getByRole("listitem")
      .filter({ hasText: "Contact form" });
    await expect(contact.getByText("Name", { exact: true })).toBeVisible();
    await page.evaluate(
      () =>
        new Promise<void>(resolve =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        )
    );
    expect(provider.detailReads.length).toBeLessThan(12);
    const initialIds = new Set(
      provider.flows.slice(0, 12).map(flow => String(flow.id))
    );
    expect(
      provider.detailReads.every(
        read => read.includeJson && initialIds.has(read.flowId)
      )
    ).toBe(true);
    expect(provider.maxActiveDetailReads()).toBeLessThanOrEqual(3);
    await expectGalleryGeometry(page);
    await page
      .getByRole("button", {
        name: enMessages.WhatsAppFlows.gallery.loadMore.replace(
          "{count}",
          "12"
        ),
        exact: true,
      })
      .click();
    await expect(
      page.locator('[role="listitem"][aria-labelledby]')
    ).toHaveCount(24);
    await page
      .getByRole("listitem")
      .filter({ hasText: "Gallery form 24" })
      .scrollIntoViewIfNeeded();
    await expect
      .poll(() =>
        provider.detailReads.some(
          read => read.flowId === String(provider.flows[23].id)
        )
      )
      .toBe(true);
    expect(provider.maxActiveDetailReads()).toBeLessThanOrEqual(3);
    expect(provider.mutations).toEqual([]);
    expect(provider.errors).toEqual([]);
  } finally {
    provider.releaseDetailReads();
  }
});

test("list search, status filter, owner link and external draft test send", async ({
  page,
}) => {
  const provider = await mockProviderBoundary(page);
  await openManager(page);
  const search = page.getByRole("textbox", {
    name: "Search Flows",
    exact: true,
  });
  await search.fill("Advanced");
  await expect(page.getByText("Advanced form", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Contact form", { exact: true })
  ).not.toBeVisible();
  await search.fill("");
  await page.getByRole("combobox", { name: "Flow status" }).click();
  await page.getByRole("option", { name: "Draft", exact: true }).click();
  await expect(page.getByText("Contact form", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Published booking", { exact: true })
  ).not.toBeVisible();
  await page.getByRole("combobox", { name: "Flow status" }).click();
  await page.getByRole("option", { name: "All statuses", exact: true }).click();
  await expect(
    page.getByRole("link", { name: "Open scenario" })
  ).toHaveAttribute(
    "href",
    "/panel/w/browser-workspace/scenarios?scenarioId=browser-scenario"
  );
  await page
    .getByRole("button", { name: "More actions for Scenario registration" })
    .click();
  await expect(
    page.getByRole("menuitem", { name: "Create editable copy" })
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page
    .getByRole("button", { name: "More actions for Contact form" })
    .click();
  await page.getByRole("menuitem", { name: "Send test", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByText(/Send this test within 24 hours/)
  ).toBeVisible();
  await expect(
    dialog.getByText(/WhatsApp Web does not support Flows/)
  ).toBeVisible();
  await dialog.getByLabel("Recipient phone").fill("15551234567");
  await dialog
    .getByLabel("Action payload JSON (optional)")
    .fill('{"screen":"START"}');
  await capture(page, "desktop-send-test");
  await dialog.getByRole("button", { name: "Send test", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(provider.mutations).toContainEqual(
    expect.objectContaining({
      method: "POST",
      flowId: ids.draft,
      mode: "draft",
      recipientPhone: "15551234567",
    })
  );
  expect(provider.errors).toEqual([]);
});

test("mobile throttled Flow keeps provider-limited test sending available", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const provider = await mockProviderBoundary(page, {
    draftStatus: "THROTTLED",
  });
  await openManager(page);
  await page
    .getByRole("button", { name: "More actions for Contact form" })
    .click();
  await page.getByRole("menuitem", { name: "Send test", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByText(/Send this test within 24 hours/)
  ).toBeVisible();
  await dialog.getByLabel("Recipient phone").fill("15551234567");
  await dialog
    .getByRole("button", { name: "Send test", exact: true })
    .scrollIntoViewIfNeeded();
  await capture(page, "mobile-send-test");
  await dialog.getByRole("button", { name: "Send test", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(provider.mutations).toContainEqual(
    expect.objectContaining({ method: "POST", flowId: ids.draft })
  );
  expect(provider.mutations[0].mode).not.toBe("draft");
  expect(provider.errors).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    )
  ).toBe(true);
});

test("visual edit saves JSON, survives reopening and requires explicit publish", async ({
  page,
}) => {
  const provider = await mockProviderBoundary(page);
  await openManager(page);
  await page
    .getByRole("listitem")
    .filter({ hasText: "Contact form" })
    .getByRole("button", { name: "Edit", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("tab", { name: "Visual", exact: true })
  ).toHaveAttribute("data-state", "active");
  const fieldLabel = dialog.getByRole("textbox", {
    name: "Field label",
    exact: true,
  });
  await fieldLabel.fill("Your full name");
  await expect(
    dialog.getByText("Unsaved changes", { exact: true })
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Publish", exact: true })
  ).toBeDisabled();
  await expect(
    dialog.getByText(enMessages.WhatsAppFlows.editor.publishNeedsSave, {
      exact: true,
    })
  ).toBeVisible();
  let guardCount = 0;
  const keepEditing = async (
    confirmation: import("@playwright/test").Dialog
  ) => {
    guardCount += 1;
    expect(confirmation.message()).toBe(
      "Discard unsaved changes to this Flow?"
    );
    await confirmation.dismiss();
  };
  page.on("dialog", keepEditing);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  await dialog
    .getByRole("button", { name: "Close", exact: true })
    .last()
    .click();
  await expect(dialog).toBeVisible();
  page.off("dialog", keepEditing);
  expect(guardCount).toBe(2);
  await capture(page, "desktop-editor");
  await dialog.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(
    dialog.getByText("Unsaved changes", { exact: true })
  ).toHaveCount(0);
  await expect(
    dialog.getByRole("button", { name: "Publish", exact: true })
  ).toBeEnabled();
  const saved = provider.mutations.find(
    mutation => mutation.operation === "update_json"
  );
  expect(saved).toEqual(
    expect.objectContaining({ flowId: ids.draft, sourceId: "browser-source" })
  );
  expect(
    JSON.parse(String(saved?.flowJson)).screens[0].layout.children[0]
      .children[0].label
  ).toBe("Your full name");
  expect(
    provider.mutations.filter(mutation => mutation.operation === "publish")
  ).toHaveLength(0);
  await dialog
    .getByRole("button", { name: "Close", exact: true })
    .last()
    .click();
  await page
    .getByRole("listitem")
    .filter({ hasText: "Contact form" })
    .getByRole("button", { name: "Edit", exact: true })
    .click();
  await expect(
    dialog.getByRole("textbox", { name: "Field label", exact: true })
  ).toHaveText("Your full name");
  await dialog.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(
    dialog.getByText(
      "This published version is shown for reference. Create an editable copy to make changes.",
      { exact: true }
    )
  ).toBeVisible();
  expect(
    provider.mutations.filter(mutation => mutation.operation === "publish")
  ).toHaveLength(1);
  expect(provider.errors).toEqual([]);
});

test("advanced Meta JSON is preserved and provider validation blocks publishing", async ({
  page,
}) => {
  const provider = await mockProviderBoundary(page);
  await openManager(page);
  await page
    .getByRole("listitem")
    .filter({ hasText: "Advanced form" })
    .getByRole("button", { name: "Edit", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("tab", { name: "Visual", exact: true })
  ).toBeDisabled();
  const source = dialog.getByRole("textbox", {
    name: "Flow JSON",
    exact: true,
  });
  const original = JSON.parse(await source.inputValue());
  expect(original.screens[0].layout.children[0].visible).toBe(
    "${data.show_heading}"
  );
  const modified = structuredClone(original);
  modified.screens[0].title = "Updated advanced form";
  await source.fill(JSON.stringify(modified, null, 2));
  await dialog.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(
    dialog.getByRole("button", { name: "Save draft", exact: true })
  ).toBeDisabled();
  expect(provider.documents.get(ids.advanced)).toEqual(modified);
  await dialog.getByTestId("flow-editor-body").evaluate(element => {
    element.scrollTop = 0;
  });
  await capture(page, "desktop-advanced-json");
  provider.rejectValidation();
  modified.screens[0].title = "Rejected title";
  await source.fill(JSON.stringify(modified, null, 2));
  await dialog.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(
    dialog.getByText("L8: Test provider rejected field label", { exact: true })
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Publish", exact: true })
  ).toBeDisabled();
  await expect(source).toHaveValue(JSON.stringify(modified, null, 2));
  await dialog.getByTestId("flow-editor-body").evaluate(element => {
    element.scrollTop = 0;
  });
  await capture(page, "desktop-validation-errors");
  expect(provider.errors).toEqual([]);
});

test("mobile published copy opens editable draft, traps keyboard focus and fits viewport", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const provider = await mockProviderBoundary(page);
  await openManager(page);
  await capture(page, "mobile-manager");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    )
  ).toBe(true);
  await page
    .getByRole("listitem")
    .filter({ hasText: "Published booking" })
    .getByRole("button", { name: "View", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByText(
      "This published version is shown for reference. Create an editable copy to make changes.",
      { exact: true }
    )
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Save draft", exact: true })
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await page
    .getByRole("button", { name: "More actions for Published booking" })
    .click();
  await page
    .getByRole("menuitem", { name: "Create editable copy", exact: true })
    .click();
  await expect(
    dialog.getByRole("heading", {
      name: "Create an editable copy",
      exact: true,
    })
  ).toBeVisible();
  await expect(page.getByRole("menu")).toHaveCount(0);
  await dialog.getByLabel("Flow name").focus();
  for (let index = 0; index < 14; index += 1) {
    await page.keyboard.press("Tab");
    expect(
      await dialog.evaluate(element => element.contains(document.activeElement))
    ).toBe(true);
  }
  await dialog.getByLabel("Flow name").fill("Mobile booking copy");
  await capture(page, "mobile-clone");
  await dialog
    .getByRole("button", { name: "Create flow", exact: true })
    .click();
  await expect(
    dialog.getByRole("tab", { name: "Visual", exact: true })
  ).toHaveAttribute("data-state", "active");
  await expect(
    dialog.getByRole("button", { name: "Save draft", exact: true })
  ).toBeVisible();
  expect(provider.mutations).toContainEqual(
    expect.objectContaining({
      method: "PUT",
      cloneFlowId: ids.published,
      name: "Mobile booking copy",
    })
  );
  await expect
    .poll(() =>
      dialog.evaluate(
        element =>
          element
            .getAnimations({ subtree: true })
            .filter(
              animation =>
                animation.effect?.getComputedTiming().iterations !== Infinity
            ).length
      )
    )
    .toBe(0);
  await dialog.getByTestId("flow-editor-body").evaluate(element => {
    element.scrollTop = 0;
  });
  await expect
    .poll(async () => {
      const bounds = await dialog.boundingBox();
      return (bounds?.y ?? 0) + (bounds?.height ?? 0);
    })
    .toBeLessThanOrEqual(844);
  const box = await dialog.boundingBox();
  expect(box?.width).toBeLessThanOrEqual(390);
  expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(844);
  expect(
    await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)
  ).toBe(true);
  await capture(page, "mobile-editor");
  expect(provider.errors).toEqual([]);
});

test("incomplete visual fields and options stay editable and block invalid saves", async ({
  page,
}) => {
  const provider = await mockProviderBoundary(page);
  await openManager(page);
  await page
    .getByRole("listitem")
    .filter({ hasText: "Contact form" })
    .getByRole("button", { name: "Edit", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  const labels = dialog.getByRole("textbox", {
    name: "Field label",
    exact: true,
  });
  await labels.first().fill("");
  await expect(labels.first()).toBeEditable();
  await expect(
    dialog.getByRole("tab", { name: "Visual", exact: true })
  ).toHaveAttribute("data-state", "active");
  await expect(
    dialog.getByText("Label is required", { exact: true })
  ).toBeVisible();
  await labels.first().fill("Name");
  await dialog.getByRole("button", { name: "Add field", exact: true }).click();
  await expect(labels).toHaveCount(1);
  await expect(labels.first()).toBeEditable();
  await expect(
    dialog
      .getByTestId("flow-authoring-outline")
      .getByRole("button", { name: "field_1", exact: true })
  ).toHaveAttribute("aria-pressed", "true");
  await dialog.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(
    dialog.getByText("Enter a valid JSON object.", { exact: true })
  ).toBeVisible();
  expect(provider.mutations).toEqual([]);
  await labels.first().fill("Preference");
  await dialog
    .getByRole("combobox", { name: "Component", exact: true })
    .click();
  await page
    .getByRole("option", { name: "Radio Buttons", exact: true })
    .click();
  await dialog.getByRole("button", { name: "Add option", exact: true }).click();
  const newOption = dialog.getByRole("textbox", {
    name: "Option 3",
    exact: true,
  });
  await expect(newOption).toBeEditable();
  await expect(
    dialog.getByRole("tab", { name: "Visual", exact: true })
  ).toHaveAttribute("data-state", "active");
  await expect(
    dialog.getByText("Option title is required", { exact: true })
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Save draft", exact: true }).click();
  expect(provider.mutations).toEqual([]);
  await capture(page, "desktop-incomplete-option");
  await newOption.fill("Other");
  await dialog.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(
    dialog.getByRole("button", { name: "Save draft", exact: true })
  ).toBeDisabled();
  expect(
    provider.mutations.filter(mutation => mutation.operation === "update_json")
  ).toHaveLength(1);
  expect(provider.errors).toEqual([]);
});

for (const [locale, messages, scenarioMessages] of [
  ["en", enMessages, enScenarioMessages],
  ["ru", ruMessages, ruScenarioMessages],
  ["kz", kzMessages, kzScenarioMessages],
] as const) {
  test(`${locale} manager and editor use translated messages without console errors`, async ({
    page,
  }) => {
    if (locale !== "en") {
      await page.setViewportSize({
        width: locale === "ru" ? 330 : 390,
        height: 686,
      });
    }
    const provider = await mockProviderBoundary(page);
    await page.goto(`/whatsapp-flows-browser.html?locale=${locale}`);
    await expect(page.getByText("Contact form", { exact: true })).toBeVisible();
    await expect(
      page.getByRole("heading", {
        level: 1,
        name: messages.WhatsAppFlows.title,
        exact: true,
      })
    ).toHaveCount(1);
    await expect(
      page.getByText(messages.WhatsAppFlows.description, { exact: true })
    ).toHaveCount(1);
    const bookingCard = page
      .getByRole("listitem")
      .filter({ hasText: "Published booking" });
    await bookingCard.scrollIntoViewIfNeeded();
    for (const placeholder of [
      scenarioMessages.Scenarios.flowFieldSampleDate,
      scenarioMessages.Scenarios.flowFieldSampleOption,
      scenarioMessages.Scenarios.flowFieldSampleAnswer,
    ]) {
      await expect(
        bookingCard.getByText(placeholder, { exact: true })
      ).toBeVisible();
    }
    await expect(page.getByText(/^Scenarios\./)).toHaveCount(0);
    await page
      .getByRole("listitem")
      .filter({ hasText: "Contact form" })
      .getByRole("button", {
        name: messages.WhatsAppFlows.actions.edit,
        exact: true,
      })
      .click();
    const dialog = page.getByRole("dialog");
    await expect(
      dialog.getByRole("tab", {
        name: messages.WhatsAppFlows.editor.visual,
        exact: true,
      })
    ).toHaveAttribute("data-state", "active");
    await expect(dialog.getByText(/^Scenarios\./)).toHaveCount(0);
    if (locale !== "en") {
      const switcher = dialog.getByTestId("flow-authoring-pane-switcher");
      await expectFullyVisible(switcher);
      await expect(switcher.getByRole("button")).toHaveCount(3);
      expect(
        await switcher
          .getByRole("button")
          .evaluateAll(buttons =>
            buttons.every(
              button =>
                button.scrollWidth <= button.clientWidth &&
                button.scrollHeight <= button.clientHeight
            )
          )
      ).toBe(true);
      await capture(page, `${locale}-editor-visual-mobile`);
    }
    await selectJsonEditor(dialog, messages.WhatsAppFlows.editor.advanced);
    await expect(
      dialog.getByRole("textbox", {
        name: messages.WhatsAppFlows.editor.sourceLabel,
        exact: true,
      })
    ).toBeVisible();
    await capture(page, `${locale}-editor`);
    await dialog
      .getByRole("button", {
        name: messages.WhatsAppFlows.editor.close,
        exact: true,
      })
      .last()
      .click();
    await page
      .getByRole("button", {
        name: messages.WhatsAppFlows.actions.more.replace(
          "{name}",
          "Contact form"
        ),
      })
      .click();
    await expect(
      page.getByRole("menuitem", {
        name: messages.WhatsAppFlows.actions.preview,
        exact: true,
      })
    ).toBeVisible();
    await page
      .getByRole("menuitem", {
        name: messages.WhatsAppFlows.actions.sendTest,
        exact: true,
      })
      .click();
    await expect(
      page
        .getByRole("dialog")
        .getByText(messages.WhatsAppFlows.dialogs.send.requirements, {
          exact: true,
        })
    ).toBeVisible();
    expect(provider.mutations).toEqual([]);
    expect(provider.errors).toEqual([]);
  });
}
