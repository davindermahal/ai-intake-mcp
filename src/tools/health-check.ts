import type { GlobalConfig } from "../config.js";
import type { JiraClient } from "../jira/client.js";

export interface HealthCheckResult {
  ok: boolean;
  details: string[];
}

/**
 * Verifies credentials load, the Jira site is reachable, and that both the configured in-progress
 * and code-review native statuses exist on the board (decision: "health_check" in the tool surface).
 * The hardening phase added the `verify` transition, which mirrors to trackerNativeStatusCodeReview
 * (see `nativeStatusNameFor` in jira/tags.ts) — this check covers both mirror targets. Cosmetic/UX
 * check, not a correctness gate: the state:* label write is authoritative regardless of mirror status.
 */
export async function healthCheck(client: JiraClient, config: GlobalConfig): Promise<HealthCheckResult> {
  const details: string[] = [];

  try {
    const me = await client.get<{ accountId: string; displayName: string }>("/rest/api/3/myself");
    details.push(`Authenticated as ${me.displayName} (${me.accountId}) at ${config.jiraSiteUrl}.`);
  } catch (err) {
    details.push(`Credential/connectivity check failed: ${(err as Error).message}`);
    return { ok: false, details };
  }

  try {
    const statuses = await client.get<{ name: string }[]>("/rest/api/3/status");
    const statusNames = new Set(statuses.map((s) => s.name));
    let ok = true;
    for (const target of [config.trackerNativeStatusInProgress, config.trackerNativeStatusCodeReview]) {
      if (statusNames.has(target)) {
        details.push(`Native status "${target}" exists on this Jira site.`);
      } else {
        details.push(
          `Native status "${target}" was not found — that mirror will silently no-op (the ` +
            `underlying state:* label write is unaffected).`,
        );
        ok = false;
      }
    }
    return { ok, details };
  } catch (err) {
    details.push(`Native status check failed: ${(err as Error).message}`);
    return { ok: false, details };
  }
}
