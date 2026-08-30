#!/usr/bin/env node
/**
 * Standalone health check — used by install.sh to verify credentials at the end of setup, and
 * runnable directly any time: `npm run health-check`. Thin wrapper around the same healthCheck()
 * the MCP tool calls; never prints the API token, only non-secret results.
 */
import { loadGlobalConfig } from "../src/config.js";
import { JiraClient } from "../src/jira/client.js";
import { healthCheck } from "../src/tools/health-check.js";

async function main(): Promise<void> {
  const config = loadGlobalConfig();
  const client = new JiraClient({ config });
  const result = await healthCheck(client, config);
  for (const line of result.details) console.log(result.ok ? line : `ERROR: ${line}`);
  if (!result.ok) process.exit(1);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
