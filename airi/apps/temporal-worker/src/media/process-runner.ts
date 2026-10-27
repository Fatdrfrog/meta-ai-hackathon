import { spawn } from "node:child_process";

export type ProcessRunInput = {
  command: string;
  args: string[];
  timeoutMs: number;
  signal?: AbortSignal;
  maxOutputBytes?: number;
  pulseIntervalMs?: number;
  onPulse?: () => void;
};

export type ProcessRunDependencies = {
  spawn?: typeof spawn;
};

export function runProcess(
  input: ProcessRunInput,
  dependencies: ProcessRunDependencies = {},
): Promise<{ stdout: string; stderr: string }> {
  if (input.signal?.aborted) {
    return Promise.reject(new Error(`${input.command} was cancelled`));
  }
  return new Promise((resolve, reject) => {
    const child = (dependencies.spawn ?? spawn)(input.command, input.args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const maxOutputBytes = Math.max(1, input.maxOutputBytes ?? 128 * 1024);
    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let terminalError: Error | null = null;
    let timeout: NodeJS.Timeout | null = null;
    let pulse: NodeJS.Timeout | null = null;

    const append = (
      current: Buffer<ArrayBufferLike>,
      chunk: Buffer<ArrayBufferLike>,
    ): Buffer<ArrayBufferLike> => {
      const combined = Buffer.concat([current, chunk]);
      return combined.byteLength <= maxOutputBytes
        ? combined
        : combined.subarray(combined.byteLength - maxOutputBytes);
    };
    const stopControls = () => {
      if (timeout) clearTimeout(timeout);
      if (pulse) clearInterval(pulse);
      timeout = null;
      pulse = null;
      input.signal?.removeEventListener("abort", abort);
    };
    const asError = (error: unknown): Error =>
      error instanceof Error ? error : new Error(String(error));
    const invokePulse = (): Error | null => {
      try {
        input.onPulse?.();
        return null;
      } catch (error) {
        return asError(error);
      }
    };
    const terminate = (error: Error) => {
      if (terminalError) return;
      terminalError = error;
      stopControls();
      try {
        child.kill("SIGKILL");
      } catch {
        // The close event remains the single settlement boundary.
      }
    };
    const abort = () => terminate(new Error(`${input.command} was cancelled`));

    child.stdout.on("data", (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });
    child.on("error", (error) => terminate(error));
    child.once("close", (code) => {
      stopControls();
      if (terminalError) {
        reject(terminalError);
        return;
      }
      const finalPulseError = invokePulse();
      if (finalPulseError) {
        reject(finalPulseError);
        return;
      }
      const result = {
        stdout: stdout.toString("utf8"),
        stderr: stderr.toString("utf8"),
      };
      if (code === 0) {
        resolve(result);
        return;
      }
      reject(
        new Error(
          `${input.command} exited with code ${code}${result.stderr.trim() ? `: ${result.stderr.trim()}` : ""}`,
        ),
      );
    });

    timeout = setTimeout(
      () =>
        terminate(
          new Error(`${input.command} timed out after ${input.timeoutMs}ms`),
        ),
      input.timeoutMs,
    );
    pulse =
      input.onPulse && input.pulseIntervalMs
        ? setInterval(() => {
            const error = invokePulse();
            if (error) terminate(error);
          }, input.pulseIntervalMs)
        : null;

    input.signal?.addEventListener("abort", abort, { once: true });
    if (input.signal?.aborted) {
      abort();
    } else {
      const initialPulseError = invokePulse();
      if (initialPulseError) terminate(initialPulseError);
    }
  });
}
