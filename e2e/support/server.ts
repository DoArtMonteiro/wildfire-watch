import type { APIRequestContext, TestInfo } from "@playwright/test";

const WAIT_LIMIT_MS = 60_000;

/**
 * Waits until the local server answers, so a test that starts while
 * e2e/support/start-server.mjs restarts `wrangler dev` waits for it instead of
 * failing on a refused connection. Time spent waiting is added to the test's
 * timeout. A server that never comes back still fails the test.
 */
export async function waitForServer(request: APIRequestContext, testInfo: TestInfo): Promise<void> {
  const started = Date.now();
  for (;;) {
    try {
      const response = await request.get("/api/fires", { timeout: 5_000 });
      if (response.ok()) break;
    } catch {
      // Connection refused while the server restarts.
    }
    if (Date.now() - started > WAIT_LIMIT_MS) throw new Error(`The local server did not answer within ${WAIT_LIMIT_MS / 1_000} s`);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  const waited = Date.now() - started;
  if (waited > 1_000) testInfo.setTimeout(testInfo.timeout + waited);
}
