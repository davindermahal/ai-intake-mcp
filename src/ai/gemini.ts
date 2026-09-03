import { DEFAULT_STATE_ROOT } from "../automation/result-file.js";
import { type LaunchOptions, type LaunchResult, launchProvider } from "./launch.js";

export const GEMINI_PROVIDER_NAME = "gemini";

/**
 * Gemini adapter (decision #14). Headless single-shot invocation: `gemini -p "<prompt>"`. Unlike
 * Claude, `permissionProfilePath` never becomes a CLI flag here — Gemini's policy engine is
 * machine-global by tier (gemini-cli issue #18186 makes the per-worktree Workspace tier
 * non-functional), so the deny-list is synced once, out-of-band, to the User tier
 * (`src/ai/gemini-policy.ts`, decision #9) rather than passed per-launch. `permissionProfilePath` is
 * still accepted (and available for logging/audit) so the adapter contract stays uniform across
 * providers.
 *
 * `--skip-trust` (confirmed live during headless-automation QA Phase B, gemini-cli 0.58.0): every
 * launch runs in a freshly created worktree gemini-cli has never seen, so without this flag every
 * single headless launch fails immediately with "Gemini CLI is not running in a trusted directory"
 * — this isn't an edge case, it's the normal path. The flag exists for exactly this — see
 * https://geminicli.com/docs/cli/trusted-folders/#headless-and-automated-environments — and is safe
 * here specifically because `worktreePath` is a disposable directory this project created, not an
 * arbitrary one a user pointed the CLI at.
 *
 * `--include-directories <stateRoot>`: the Claude equivalent of this (`--add-dir`) was confirmed
 * live during Phase E to be required — headless file-tool access is confined to the worktree by
 * default, and the worker's context/progress/result files live under the state tree instead.
 * `--include-directories` is gemini-cli's documented equivalent ("Additional directories to include
 * in the workspace"); added on the same reasoning but **not yet live-confirmed** for Gemini
 * specifically — this account's Google AI Studio billing was blocking real Gemini calls at the time
 * this was written. Re-verify once a real Gemini planning/implementation cycle actually runs.
 */
export function launchGemini(options: LaunchOptions): LaunchResult {
  return launchProvider(options, (promptContent, opts) => {
    const args = [
      "-p",
      promptContent,
      "--skip-trust",
      "--include-directories",
      opts.stateRoot ?? DEFAULT_STATE_ROOT,
    ];
    if (opts.model) args.push("-m", opts.model);
    return { command: "gemini", args };
  });
}
