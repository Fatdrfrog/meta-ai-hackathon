import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as contracts from "./index.ts";
import type {
  WhatsAppFlowConfig,
  WhatsAppFlowScreenConfig,
} from "./scenario-channel-configs.ts";

const screen = (): WhatsAppFlowScreenConfig => ({
  id: "WELCOME",
  title: "Welcome",
  terminal: true,
  fields: [
    { id: "name", label: "Name", fieldType: "TextInput" },
    { id: "email", label: "Email", fieldType: "TextInput" },
  ],
  footer: { label: "Complete", action: { name: "complete", payload: {} } },
});
const validate = (value: WhatsAppFlowScreenConfig) =>
  contracts.validateWhatsAppFlowStaticGraph({
    templateId: "custom",
    ctaText: "Open",
    flowNavigationMode: "static_graph",
    screens: [value],
  });

describe("ordered Flow layout contracts", () => {
  it("resolves legacy field order and retains explicit mixed content without mutating it", () => {
    const value = screen();
    assert.deepEqual(contracts.resolveWhatsAppFlowLayoutContent(value), [
      { kind: "field", fieldId: "name" },
      { kind: "field", fieldId: "email" },
    ]);
    value.layoutContent = [
      { kind: "field", fieldId: "name" },
      { kind: "text", id: "note", type: "TextBody", text: "A note" },
      { kind: "field", fieldId: "email" },
    ];
    const resolved = contracts.resolveWhatsAppFlowLayoutContent(value);
    assert.deepEqual(resolved, value.layoutContent);
    resolved.pop();
    assert.equal(value.layoutContent.length, 3);
  });

  it("syncs explicit field rename/removal/addition while preserving literal text positions", () => {
    const value = screen();
    value.layoutContent = [
      { kind: "field", fieldId: "name" },
      { kind: "text", id: "note", type: "TextCaption", text: "Keep this" },
      { kind: "field", fieldId: "email" },
    ];
    const original = structuredClone(value);
    const changed = {
      ...value,
      fields: [
        { ...value.fields[0]!, id: "full_name" },
        { id: "city", label: "City", fieldType: "TextInput" as const },
      ],
    };
    const synced = contracts.syncWhatsAppFlowLayoutContent(changed, {
      from: "name",
      to: "full_name",
    });
    assert.deepEqual(synced.layoutContent, [
      { kind: "field", fieldId: "full_name" },
      { kind: "text", id: "note", type: "TextCaption", text: "Keep this" },
      { kind: "field", fieldId: "city" },
    ]);
    assert.deepEqual(value, original);
    assert.deepEqual(
      contracts.syncWhatsAppFlowLayoutContent(screen()),
      screen(),
    );
  });

  it("rejects stale, duplicate and omitted field references and duplicate text identities", () => {
    for (const content of [
      [{ kind: "field", fieldId: "missing" }],
      [
        { kind: "field", fieldId: "name" },
        { kind: "field", fieldId: "name" },
        { kind: "field", fieldId: "email" },
      ],
      [{ kind: "field", fieldId: "name" }],
      [
        { kind: "field", fieldId: "name" },
        { kind: "field", fieldId: "email" },
        { kind: "text", id: "note", type: "TextBody", text: "One" },
        { kind: "text", id: "note", type: "TextBody", text: "Two" },
      ],
    ]) {
      const value = screen();
      value.layoutContent = content as NonNullable<
        WhatsAppFlowScreenConfig["layoutContent"]
      >;
      assert.ok(
        validate(value).some(
          (issue) => issue.code === "flow_layout_content_invalid",
        ),
      );
    }
  });

  it("rejects success on a non-terminal screen even when false", () => {
    const value = screen();
    value.terminal = false;
    value.success = false;
    assert.ok(
      validate(value).some(
        (issue) => issue.code === "flow_screen_success_invalid",
      ),
    );
  });

  it("does not permit ordered text content in a mode whose generator would ignore it", () => {
    const value = screen();
    value.layoutContent = [
      { kind: "text", id: "note", type: "TextBody", text: "Keep this" },
    ];
    const config: WhatsAppFlowConfig = {
      templateId: "custom",
      ctaText: "Open",
      screens: [value],
    };
    assert.ok(
      contracts
        .validateWhatsAppFlowStaticGraph(config)
        .some((issue) => issue.code === "flow_layout_content_invalid"),
    );
  });
});
