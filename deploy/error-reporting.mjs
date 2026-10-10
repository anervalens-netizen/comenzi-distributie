import * as Sentry from "@sentry/node";
import { readFileSync } from "node:fs";
import { basename, dirname, isAbsolute } from "node:path";
import { createBackendFrameNormalizer } from "./backend-frame-identity.mjs";
import { fileURLToPath } from "node:url";
const mappedWorkers = new Set(["sales-parser-worker.mjs", "sales-view-worker.mjs", "stock-parser-worker.mjs", "client-history-import-worker.mjs"]);

export function normalizeWorkerFrame(frame) {
  const value = frame.abs_path || frame.filename;
  if (typeof value !== "string") return;
  let local; try { local = value.startsWith("file://") ? fileURLToPath(value) : isAbsolute(value) ? value : undefined; } catch { return; }
  if (!local || !mappedWorkers.has(basename(local))) return;
  const mapped = "app:///workers/" + basename(local);
  frame.filename = mapped; frame.abs_path = mapped;
}

export function scrubErrorEvent(event) {
  delete event.request;
  delete event.user;
  delete event.extra;
  delete event.breadcrumbs;
  delete event.contexts;
  delete event.message;
  delete event.transaction;
  event.tags = Object.fromEntries(Object.entries(event.tags ?? {}).filter(([key]) =>
    ["application", "component", "request_id", "error_id", "validation.run", "glitchtip.synthetic"].includes(key)));
  const backendImages = new Map();
  for (const exception of event.exception?.values ?? []) {
    exception.value = "Application error (private message omitted)";
    for (const frame of exception.stacktrace?.frames ?? []) {
      normalizeWorkerFrame(frame);
      const image = normalizeBackendFrame(frame);
      if (image) backendImages.set(image.code_file,image);
      delete frame.vars;
      delete frame.pre_context;
      delete frame.post_context;
      delete frame.context_line;
    }
  }
  if (backendImages.size) {
    const otherImages = (Array.isArray(event.debug_meta?.images) ? event.debug_meta.images : []).filter(image => image && !backendImages.has(image.code_file));
    event.debug_meta = {...event.debug_meta,images:[...otherImages,...backendImages.values()]};
  }
  return event;
}

function release() {
 if(process.env.GLITCHTIP_RELEASE) return process.env.GLITCHTIP_RELEASE;
 try { return JSON.parse(readFileSync(new URL('./RELEASE.json',import.meta.url),'utf8')).sha; }
 catch { return undefined; }
}

// Legacy releases without backend evidence retain their original frame identity.
// A mismatched manifest must never label a frame as belonging to another release.
const normalizeBackendFrame = (() => {
 try {
  const manifest = JSON.parse(readFileSync(new URL('./.private-source-maps/backend/manifest.json',import.meta.url),'utf8'));
  return createBackendFrameNormalizer({root:dirname(fileURLToPath(import.meta.url)),release:release(),manifest});
 } catch { return () => {}; }
})();

if (process.env.GLITCHTIP_DSN) {
  Sentry.init({
    dsn: process.env.GLITCHTIP_DSN, environment: process.env.GLITCHTIP_ENVIRONMENT || "production",
    release: release(), dataCollection: {userInfo:false,cookies:false,httpHeaders:{request:false,response:false},httpBodies:[],queryParams:false,genAI:{inputs:false,outputs:false},databaseQueryData:false,stackFrameVariables:false,frameContextLines:0}, tracesSampleRate: 0,
    defaultIntegrations: false,
    integrations: [Sentry.onUncaughtExceptionIntegration(), Sentry.onUnhandledRejectionIntegration({ mode: "strict" })],
    initialScope: { tags: { application: "comenzi", component: "backend" } },
    beforeSend: scrubErrorEvent,
  });
}

export function captureError(error, requestId) {
  return Sentry.withScope(scope => {
    if (requestId) scope.setTag("request_id", requestId);
    return Sentry.captureException(error);
  });
}
export const flushErrors = Sentry.flush;

globalThis.__mobiupCaptureError = captureError;
