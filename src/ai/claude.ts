import { DEFAULT_STATE_ROOT } from "../automation/result-file.js";
import { type LaunchOptions, type LaunchResult, launchProvider } from "./launch.js";

export const CLAUDE_PROVIDER_NAME = "claude";

/**
 * Claude adapter (decision #14). Headless single-shot invocation: `claude -p "<prompt>"`, with the
 * global permission profile applied via `--settings <path>` (decision #9 — no filesystem sync
 * needed, unlike Gemini; the path is passed straight through).
 *
 * `--add-dir <stateRoot>` (confirmed live during headless-automation QA Phase E, no prior test ever
 * caught this — every mocked/unit test only asserted the args array, never a real sandboxed run):
 * `-p` headless mode confines file tools to the working directory (the worktree) by default, and the
 * worker's context/progress/result files all live under the state tree instead — every single real
 * launch failed immediately, unable to read its own context or report back at all. Without this
 * flag, headless automation cannot function even in the happy path.
 */
export function launchClaude(options: LaunchOptions): LaunchResult {
  return launchProvider(options, (promptContent, opts) => {
    const args = [
      "-p",
      promptContent,
      "--settings",
      opts.permissionProfilePath,
      "--add-dir",
      opts.stateRoot ?? DEFAULT_STATE_ROOT,
    ];
    if (opts.model) args.push("--model", opts.model);
    return { command: "claude", args };
  });
}
