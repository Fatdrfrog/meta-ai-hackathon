/** @jest-environment jsdom */

import "@testing-library/jest-dom";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  LabelHTMLAttributes,
  ReactNode,
  TextareaHTMLAttributes,
} from "react";
import { ServiceMessageMediaField } from "./service-message-media-field";

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
  useFormatter: () => ({ number: String }),
}));
jest.mock("@/lib/utils", () => ({
  cn: (...values: unknown[]) => values.filter(Boolean).join(" "),
}));
jest.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    variant: _variant,
    size: _size,
    ...props
  }: ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: string;
    size?: string;
  }) => <button {...props}>{children}</button>,
}));
jest.mock("@/components/ui/input", () => ({
  Input: (props: InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
}));
jest.mock("@/components/ui/textarea", () => ({
  Textarea: (props: TextareaHTMLAttributes<HTMLTextAreaElement>) => (
    <textarea {...props} />
  ),
}));
jest.mock("@/components/ui/label", () => ({
  Label: ({ children, ...props }: LabelHTMLAttributes<HTMLLabelElement>) => (
    <label {...props}>{children}</label>
  ),
}));
jest.mock("@/components/ui/toggle-group", () => ({
  ToggleGroup: () => null,
  ToggleGroupItem: () => null,
}));
jest.mock("../../../scenario-info-hint", () => ({
  ScenarioInfoHint: () => null,
}));
jest.mock("../../../scenario-collapsible-section", () => ({
  ScenarioCollapsibleSection: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
}));
jest.mock("./service-message-attachment-preview", () => ({
  ServiceMessageAttachmentPreview: () => null,
}));

const labels = { uploadLabel: "Add media", removeLabel: "Remove media" };

it("keeps the generated script and voice fixed while the request is pending", () => {
  render(
    <ServiceMessageMediaField
      {...labels}
      voiceScriptDefault="Original script"
      generateVoice={jest.fn(() => new Promise<undefined>(() => {}))}
      onDeliverAsVoiceChange={jest.fn()}
      onChange={jest.fn()}
    />
  );
  fireEvent.click(
    screen.getByRole("button", { name: "whatsappServiceMediaGenerateVoice" })
  );
  expect(
    screen.getByRole("textbox", {
      name: "whatsappServiceMediaVoiceScriptLabel",
    })
  ).toBeDisabled();
  expect(
    screen.getByRole("textbox", {
      name: "whatsappServiceMediaVoiceIdPlaceholder",
    })
  ).toBeDisabled();
});

it("deduplicates voice generation before the loading state renders", () => {
  const generateVoice = jest.fn(() => new Promise<undefined>(() => {}));
  render(
    <ServiceMessageMediaField
      {...labels}
      voiceScriptDefault="Original script"
      generateVoice={generateVoice}
      onDeliverAsVoiceChange={jest.fn()}
      onChange={jest.fn()}
    />
  );
  const generate = screen.getByRole("button", {
    name: "whatsappServiceMediaGenerateVoice",
  });
  act(() => {
    fireEvent.click(generate);
    fireEvent.click(generate);
  });
  expect(generateVoice).toHaveBeenCalledTimes(1);
});

it("deduplicates uploads before the loading state renders", () => {
  const upload = jest.fn(() => new Promise<undefined>(() => {}));
  render(
    <ServiceMessageMediaField
      {...labels}
      upload={upload}
      onChange={jest.fn()}
    />
  );
  const input = document.querySelector('input[type="file"]')!;
  const file = new File(["voice"], "voice.ogg", { type: "audio/ogg" });
  act(() => {
    fireEvent.change(input, { target: { files: [file] } });
    fireEvent.change(input, { target: { files: [file] } });
  });
  expect(upload).toHaveBeenCalledTimes(1);
});
