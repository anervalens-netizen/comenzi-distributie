import * as Sentry from "@sentry/node";
import { readFileSync } from "node:fs";

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
  for (const exception of event.exception?.values ?? []) {
    exception.value = "Application error (private message omitted)";
    for (const frame of exception.stacktrace?.frames ?? []) {
      delete frame.vars;
      delete frame.pre_context;
      delete frame.post_context;
      delete frame.context_line;
    }
  }
  return event;
}

function release() {
 if(process.env.GLITCHTIP_RELEASE) return process.env.GLITCHTIP_RELEASE;
 try { return JSON.parse(readFileSync(new URL('./RELEASE.json',import.meta.url),'utf8')).sha; }
 catch { return undefined; }
}

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
