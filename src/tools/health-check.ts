import type { GlobalConfig } from "../config.js";
import type { JiraClient } from "../jira/client.js";

export interface HealthCheckResult {
  ok: boolean;
  details: string[];
}

/**
 * Verifies credentials load and the Jira site is reachable, and that the configured in-progress
 * native status exists (decision: "health_check" in the tool surface). Deliberately does not check
 * TRACKER_NATIVE_STATUS_CODE_REVIEW — v1's scope never reaches it. Cosmetic/UX check, not a
 * correctness gate: the state:* label write is authoritative regardless of this mirror status.
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
    const found = statuses.some((s) => s.name === config.trackerNativeStatusInProgress);
    if (found) {
      details.push(`Native status "${config.trackerNativeStatusInProgress}" exists on this Jira site.`);
      return { ok: true, details };
    }
    details.push(
      `Native status "${config.trackerNativeStatusInProgress}" was not found — the in-progress ` +
        `mirror will silently no-op (the underlying state:* label write is unaffected).`,
    );
    return { ok: false, details };
  } catch (err) {
    details.push(`Native status check failed: ${(err as Error).message}`);
    return { ok: false, details };
  }
}
