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
 */
export function launchGemini(options: LaunchOptions): LaunchResult {
  return launchProvider(options, (promptContent, opts) => {
    const args = ["-p", promptContent];
    if (opts.model) args.push("-m", opts.model);
    return { command: "gemini", args };
  });
}
