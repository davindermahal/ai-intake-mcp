import type { ClientInfo } from "../footer.js";
import { commentFooter } from "../footer.js";
import type { JiraClient } from "../jira/client.js";
import { addComment } from "../jira/tags.js";

/** Not assignee-gated by default (decision #3); footer stamped per decision #10. */
export async function trackerAddComment(
  client: JiraClient,
  key: string,
  text: string,
  clientInfo: ClientInfo | undefined,
): Promise<{ id: string }> {
  return addComment(client, key, text, commentFooter(clientInfo));
}
