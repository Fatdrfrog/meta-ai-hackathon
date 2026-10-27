export type QueueSubmission =
  | { accepted: true }
  | { accepted: false; reason: "closed" | "full" };
type ExecutorTask = () => Promise<void>;

export class BoundedExecutor {
  private readonly queue: ExecutorTask[] = [];
  private readonly idleWaiters = new Set<() => void>();
  private active = 0;
  private held = 0;
  private closed = false;
  private pumpScheduled = false;

  constructor(
    private readonly capacity: number,
    private readonly concurrency: number,
  ) {}

  reserve(count: number): QueueSubmission {
    if (this.closed) return { accepted: false, reason: "closed" };
    if (
      !Number.isSafeInteger(count) ||
      count < 0 ||
      this.held + count > this.capacity
    ) {
      return { accepted: false, reason: "full" };
    }
    this.held += count;
    return { accepted: true };
  }

  commitReserved(tasks: readonly ExecutorTask[]): void {
    if (tasks.length === 0) return;
    this.queue.push(...tasks);
    this.schedulePump();
  }

  release(count: number): void {
    this.held -= count;
    if (this.held !== 0) return;
    for (const resolve of this.idleWaiters) resolve();
    this.idleWaiters.clear();
  }

  submit(tasks: readonly ExecutorTask[]): QueueSubmission {
    const reserved = this.reserve(tasks.length);
    if (!reserved.accepted) return reserved;
    this.commitReserved(tasks);
    return reserved;
  }

  close(): void {
    this.closed = true;
  }

  async drain(input: {
    deadlineMs: number;
    monotonicNow(): number;
  }): Promise<boolean> {
    if (this.held === 0) return true;
    const remainingMs = input.deadlineMs - input.monotonicNow();
    if (!(remainingMs > 0)) return false;
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (drained: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.idleWaiters.delete(onIdle);
        resolve(drained);
      };
      const onIdle = () => finish(true);
      const timer = setTimeout(() => finish(false), remainingMs);
      timer.unref?.();
      this.idleWaiters.add(onIdle);
      if (this.held === 0) finish(true);
    });
  }

  private schedulePump(): void {
    if (this.pumpScheduled) return;
    this.pumpScheduled = true;
    queueMicrotask(() => {
      this.pumpScheduled = false;
      this.pump();
    });
  }

  private pump(): void {
    while (this.active < this.concurrency) {
      const task = this.queue.shift();
      if (!task) break;
      this.active += 1;
      void task()
        .catch(() => undefined)
        .finally(() => {
          this.active -= 1;
          this.release(1);
          this.pump();
        });
    }
  }
}
