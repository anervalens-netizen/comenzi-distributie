import { managerAiNotConfiguredMessage } from './manager-ai';
import { fail } from './server';

// The Worker has no manager AI credential. Keep the SDK in the Node build.
export async function runManagerAi(): Promise<never> {
  fail(503, managerAiNotConfiguredMessage);
}
