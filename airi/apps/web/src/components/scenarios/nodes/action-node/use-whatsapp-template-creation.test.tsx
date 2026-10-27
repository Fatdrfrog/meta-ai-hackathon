/** @jest-environment jsdom */

import { act, renderHook } from "@testing-library/react";
import { toast } from "sonner";
import { useWhatsAppTemplateCreation } from "./use-whatsapp-template-creation";

jest.mock("sonner", () => ({
  toast: { success: jest.fn(), error: jest.fn() },
}));

function deferred() {
  let resolve!: (value: boolean) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<boolean>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function input() {
  return {
    workspaceId: "workspace-a",
    scenarioId: "scenario-a",
    nodeId: "node-a",
    templateName: "welcome",
    templateLanguage: "en",
    submitGenerated: jest.fn(async () => true),
    refreshTemplates: jest.fn(),
  };
}

describe("useWhatsAppTemplateCreation", () => {
  beforeEach(() => jest.clearAllMocks());

  it("shows only accepted submission success and active failures", async () => {
    const props = input();
    props.submitGenerated
      .mockResolvedValueOnce(false)
      .mockRejectedValueOnce(new Error("Rejected"));
    const { result } = renderHook(() => useWhatsAppTemplateCreation(props));
    await act(async () => result.current.submitGenerated());
    expect(toast.success).not.toHaveBeenCalled();
    await act(async () => result.current.submitGenerated());
    expect(toast.error).toHaveBeenCalledWith(
      "whatsappTemplateSendForReviewFailed",
      { description: "Rejected" }
    );
    await act(async () => result.current.submitGenerated());
    expect(toast.success).toHaveBeenCalledWith("whatsappTemplateSentForReview");
    expect(props.refreshTemplates).toHaveBeenCalledTimes(1);
  });

  it.each(["success", "failure"])(
    "suppresses deferred %s after A to B to A",
    async outcome => {
      const pending = deferred();
      const props = input();
      props.submitGenerated.mockReturnValue(pending.promise);
      const { result, rerender } = renderHook(useWhatsAppTemplateCreation, {
        initialProps: props,
      });
      act(() => void result.current.submitGenerated());
      rerender({ ...props, templateName: "other" });
      rerender(props);
      await act(async () =>
        outcome === "success"
          ? pending.resolve(true)
          : pending.reject(new Error("Late"))
      );
      expect(toast.success).not.toHaveBeenCalled();
      expect(toast.error).not.toHaveBeenCalled();
    }
  );

  it("keeps accepted completion current when the server normalizes the language", async () => {
    const pending = deferred();
    const props = { ...input(), templateLanguage: "ru_RU" };
    props.submitGenerated.mockReturnValue(pending.promise);
    const { result, rerender } = renderHook(useWhatsAppTemplateCreation, {
      initialProps: props,
    });
    act(() => void result.current.submitGenerated());
    rerender({ ...props, templateLanguage: "ru" });
    await act(async () => pending.resolve(true));
    expect(toast.success).toHaveBeenCalledWith("whatsappTemplateSentForReview");
  });

  it.each(["success", "failure"])(
    "suppresses %s and retained commands after unmount",
    async outcome => {
      const pending = deferred();
      const props = input();
      props.submitGenerated.mockReturnValue(pending.promise);
      const { result, unmount } = renderHook(() =>
        useWhatsAppTemplateCreation(props)
      );
      const submit = result.current.submitGenerated;
      act(() => void submit());
      unmount();
      await act(async () =>
        outcome === "success"
          ? pending.resolve(true)
          : pending.reject(new Error("Late"))
      );
      await submit();
      expect(props.submitGenerated).toHaveBeenCalledTimes(1);
      expect(toast.error).not.toHaveBeenCalled();
      expect(toast.success).not.toHaveBeenCalled();
    }
  );

  it("does not let an old create completion close a reopened drawer or refresh", () => {
    const props = input();
    const { result } = renderHook(() => useWhatsAppTemplateCreation(props));
    act(() => result.current.setCreateDrawerOpen(true));
    const oldClose = result.current.setCreateDrawerOpen;
    const oldSuccess = result.current.onCreateSuccess;
    act(() => result.current.setCreateDrawerOpen(false));
    act(() => result.current.setCreateDrawerOpen(true));
    act(() => {
      oldClose(false);
      oldSuccess();
    });
    expect(result.current.createDrawerOpen).toBe(true);
    expect(props.refreshTemplates).not.toHaveBeenCalled();
    act(() => {
      result.current.setCreateDrawerOpen(false);
      result.current.onCreateSuccess();
    });
    expect(result.current.createDrawerOpen).toBe(false);
    expect(props.refreshTemplates).toHaveBeenCalledTimes(1);
  });

  it("closes creation on owner change and ignores its old callbacks", () => {
    const props = input();
    const { result, rerender } = renderHook(useWhatsAppTemplateCreation, {
      initialProps: props,
    });
    act(() => result.current.setCreateDrawerOpen(true));
    const success = result.current.onCreateSuccess;
    rerender({ ...props, workspaceId: "workspace-b" });
    act(() => success());
    expect(result.current.createDrawerOpen).toBe(false);
    expect(props.refreshTemplates).not.toHaveBeenCalled();
  });
});
