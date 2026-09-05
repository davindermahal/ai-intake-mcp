/** Comment footer naming the calling agent (decision #10), sourced from MCP's own `clientInfo`. */

export interface ClientInfo {
  name?: string;
  version?: string;
}

export function commentFooter(clientInfo: ClientInfo | undefined): string {
  if (!clientInfo?.name) return "🤖 _Posted by AI via ai-intake-mcp_";
  return `🤖 _Posted by ${clientInfo.name} via ai-intake-mcp_`;
}
