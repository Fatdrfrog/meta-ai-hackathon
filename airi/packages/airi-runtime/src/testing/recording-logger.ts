// Test-only logger for node:test suites in airi-runtime and the worker. It
// records every call so tests can assert on what a handler logged. Production
// code must not import this entry.

type LogContext = Record<string, unknown> | undefined;

export type RecordedLogEntry = [message: string, context: LogContext];
export type RecordedErrorEntry = [
  message: string,
  error: unknown,
  context: LogContext,
];

export function createRecordingLogger() {
  const errors: RecordedErrorEntry[] = [];
  const infos: RecordedLogEntry[] = [];
  const successes: RecordedLogEntry[] = [];
  const warnings: RecordedLogEntry[] = [];

  return {
    errors,
    infos,
    successes,
    warnings,
    logger: {
      error: (
        message: string,
        error?: unknown,
        context?: Record<string, unknown>,
      ) => {
        errors.push([message, error, context]);
      },
      info: (message: string, context?: Record<string, unknown>) => {
        infos.push([message, context]);
      },
      success: (message: string, context?: Record<string, unknown>) => {
        successes.push([message, context]);
      },
      warn: (message: string, context?: Record<string, unknown>) => {
        warnings.push([message, context]);
      },
    },
  };
}
