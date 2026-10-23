/** Response-local timing only: no identifiers, query text or persistent telemetry. */
export async function timedResponse(read:()=>Promise<Response>):Promise<Response> {
  const started=performance.now();
  const result=await read();
  result.headers.append('Server-Timing',`app;dur=${Math.max(0,performance.now()-started).toFixed(1)}`);
  return result;
}
