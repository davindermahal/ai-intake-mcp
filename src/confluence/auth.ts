import { resolveConfluenceAuth, type ResolvedConfluenceAuth } from "@davindermahal/confluence-client";
import type { GlobalConfig } from "../config.js";

/**
 * Turns `@davindermahal/confluence-client`'s "null if incomplete" (transport-only, no product
 * opinion — extract-a-shared-confluence-client-package plan Key decision #1) into this project's own
 * specific, actionable error message — preserves the exact behavior every call site already depended
 * on before this repo's migration onto the shared package.
 */
export function resolveConfluenceAuthOrThrow(config: GlobalConfig): ResolvedConfluenceAuth {
  const auth = resolveConfluenceAuth({
    jiraSiteUrl: config.jiraSiteUrl,
    jiraEmail: config.jiraEmail,
    jiraApiToken: config.jiraApiToken,
    confluenceSiteUrl: config.confluenceSiteUrl,
    confluenceEmail: config.confluenceEmail,
    confluenceApiToken: config.confluenceApiToken,
  });
  if (!auth) {
    throw new Error(
      "No Confluence API token available: set CONFLUENCE_API_TOKEN, or JIRA_INTAKE_API_TOKEN if " +
        "Confluence and Jira share credentials (curated-guide-retrieval.md Key decision #6). " +
        "There is no cookie-auth fallback for Confluence — a real API token is required.",
    );
  }
  return auth;
}
