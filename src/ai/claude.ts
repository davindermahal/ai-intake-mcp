import { type LaunchOptions, type LaunchResult, launchProvider } from "./launch.js";

export const CLAUDE_PROVIDER_NAME = "claude";

/**
 * Claude adapter (decision #14). Headless single-shot invocation: `claude -p "<prompt>"`, with the
 * global permission profile applied via `--settings <path>` (decision #9 — no filesystem sync
 * needed, unlike Gemini; the path is passed straight through).
 */
export function launchClaude(options: LaunchOptions): LaunchResult {
  return launchProvider(options, (promptContent, opts) => {
    const args = ["-p", promptContent, "--settings", opts.permissionProfilePath];
    if (opts.model) args.push("--model", opts.model);
    return { command: "claude", args };
  });
}
