import { commentFooter } from "../footer.js";

/** Every comment the orchestrator itself posts (start/completion/bounce/heartbeat/escalation — as
 * opposed to a comment a human or an interactive MCP session posts) carries this fixed footer. It
 * still ends in `commentFooter`'s stable `"via ai-intake-mcp_"` fingerprint, so `src/automation/
 * repickup.ts`'s re-pickup detection (decision #18) works the same for orchestrator-authored
 * comments as it does for interactive ones. */
export const AUTOMATION_COMMENT_FOOTER = commentFooter({ name: "ai-intake-mcp automation" });
