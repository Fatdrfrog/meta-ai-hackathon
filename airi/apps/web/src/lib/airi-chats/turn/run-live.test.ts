import type { AiriChatRunEvent } from "@/lib/airi-chats/run-events";
import {
  abortLiveAiriChatRun,
  finishLiveAiriChatRun,
  isLiveAiriChatRun,
  publishLiveAiriChatRunEvent,
  registerLiveAiriChatRun,
  subscribeLiveAiriChatRun,
} from "./run-live";

const at = "2026-10-11T09:00:00.000Z";

function stage(id: string): AiriChatRunEvent {
  return { type: "stage", id, label: id, status: "running", at };
}

function delta(text: string): AiriChatRunEvent {
  return { type: "assistant_delta", threadId: "t1", text, at };
}

describe("live Airi chat runs", () => {
  it("replays what a late subscriber missed, with only the latest preview where it was", () => {
    registerLiveAiriChatRun("run-replay", new AbortController());
    publishLiveAiriChatRunEvent("run-replay", stage("history"));
    publishLiveAiriChatRunEvent("run-replay", delta("Hel"));
    publishLiveAiriChatRunEvent("run-replay", delta("Hello"));
    publishLiveAiriChatRunEvent("run-replay", stage("generation"));

    const seen: AiriChatRunEvent[] = [];
    const subscription = subscribeLiveAiriChatRun("run-replay", event =>
      seen.push(event)
    );
    expect(
      subscription?.replay.map(event =>
        event.type === "assistant_delta" ? event.text : event.type
      )
    ).toEqual(["stage", "Hello", "stage"]);

    publishLiveAiriChatRunEvent("run-replay", delta("Hello there"));
    expect(seen).toEqual([delta("Hello there")]);
    subscription?.unsubscribe();
    finishLiveAiriChatRun("run-replay");
  });

  it("drops the preview from the replay once the answer is published", () => {
    registerLiveAiriChatRun("run-answer", new AbortController());
    publishLiveAiriChatRunEvent("run-answer", delta("Hello"));
    publishLiveAiriChatRunEvent("run-answer", {
      type: "assistant_message",
      message: {
        id: "m1",
        threadId: "t1",
        role: "assistant",
        content: "Hello there",
        createdAt: at,
      },
      at,
    });
    const replay = subscribeLiveAiriChatRun("run-answer", () => {})?.replay;
    expect(replay?.map(event => event.type)).toEqual(["assistant_message"]);
    finishLiveAiriChatRun("run-answer");
  });

  it("releases subscribers when the run finishes and keeps its replay for late attaches", async () => {
    registerLiveAiriChatRun("run-finish", new AbortController());
    const listener = jest.fn();
    const subscription = subscribeLiveAiriChatRun("run-finish", listener);
    publishLiveAiriChatRunEvent("run-finish", stage("history"));
    finishLiveAiriChatRun("run-finish");
    await expect(subscription?.closed).resolves.toBeUndefined();

    // Nothing is delivered after the end.
    publishLiveAiriChatRunEvent("run-finish", stage("late"));
    expect(listener).toHaveBeenCalledTimes(1);
    const late = subscribeLiveAiriChatRun("run-finish", jest.fn());
    expect(late?.replay).toEqual([stage("history")]);
    await expect(late?.closed).resolves.toBeUndefined();
  });

  it("stops a run on this instance, and only while it runs", () => {
    const controller = new AbortController();
    registerLiveAiriChatRun("run-abort", controller);
    const reason = new Error("stop");
    expect(abortLiveAiriChatRun("run-abort", reason)).toBe(true);
    expect(controller.signal.reason).toBe(reason);
    finishLiveAiriChatRun("run-abort");
    expect(abortLiveAiriChatRun("run-abort", reason)).toBe(false);
    expect(abortLiveAiriChatRun("run-elsewhere", reason)).toBe(false);
    expect(isLiveAiriChatRun("run-elsewhere")).toBe(false);
    expect(subscribeLiveAiriChatRun("run-elsewhere", jest.fn())).toBeNull();
  });
});
