// The deployed Node entrypoint supplies the SDK hook before routes load.
// Other adapters and isolated tooling may leave reporting unconfigured.
export function captureError(error: unknown): void {
  const reporter = (globalThis as { __mobiupCaptureError?: (error: unknown) => unknown }).__mobiupCaptureError;
  reporter?.(error);
}
