import { describe, expect, it } from "vitest";
import { commentFooter } from "../src/footer.js";

describe("commentFooter", () => {
  it("names the calling agent when clientInfo.name is present", () => {
    expect(commentFooter({ name: "Claude Code", version: "1.2.3" })).toBe(
      "🤖 _Posted by Claude Code via ai-intake-mcp_",
    );
  });

  it("falls back to a generic label when clientInfo is undefined", () => {
    expect(commentFooter(undefined)).toBe("🤖 _Posted by AI via ai-intake-mcp_");
  });

  it("falls back to a generic label when clientInfo.name is missing", () => {
    expect(commentFooter({ version: "1.2.3" })).toBe("🤖 _Posted by AI via ai-intake-mcp_");
  });
});
