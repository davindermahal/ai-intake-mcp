import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface GlobalConfig {
  jiraSiteUrl: string;
  jiraEmail: string;
  jiraApiToken: string | undefined;
  trackerNativeStatusInProgress: string;
  trackerNativeStatusCodeReview: string;
  jiraCookieBrowser: string;
}

const CONFIG_DIR = join(homedir(), ".config", "ai-intake-mcp");
const ENV_PATH = join(CONFIG_DIR, ".env");

function parseEnvFile(contents: string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const rawLine of contents.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    } else {
      // Only an unquoted value can carry a trailing inline comment; strip it and re-trim. The `#`
      // must be preceded by whitespace so a bare "#" inside a value (e.g. a URL fragment) survives.
      const commentStart = value.search(/\s#/);
      if (commentStart !== -1) value = value.slice(0, commentStart).trim();
    }
    vars[key] = value;
  }
  return vars;
}

/**
 * Loads ~/.config/ai-intake-mcp/.env (decision #8). Env vars already present in process.env take
 * precedence, so a wrapping shell/launcher can still override without editing the file.
 */
export function loadGlobalConfig(): GlobalConfig {
  let fileVars: Record<string, string> = {};
  try {
    fileVars = parseEnvFile(readFileSync(ENV_PATH, "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  const get = (key: string): string | undefined => process.env[key] ?? fileVars[key];

  const jiraSiteUrl = get("JIRA_SITE_URL");
  if (!jiraSiteUrl) {
    throw new Error(
      `JIRA_SITE_URL is not set. Populate ${ENV_PATH} with JIRA_SITE_URL, JIRA_INTAKE_EMAIL, and ` +
        `either JIRA_INTAKE_API_TOKEN (preferred) or leave the token blank to use the cookie fallback.`,
    );
  }
  const jiraEmail = get("JIRA_INTAKE_EMAIL");
  if (!jiraEmail) {
    throw new Error(`JIRA_INTAKE_EMAIL is not set. Populate ${ENV_PATH}.`);
  }

  const normalizedSiteUrl = /^https?:\/\//.test(jiraSiteUrl) ? jiraSiteUrl : `https://${jiraSiteUrl}`;

  return {
    jiraSiteUrl: normalizedSiteUrl.replace(/\/+$/, ""),
    jiraEmail,
    jiraApiToken: get("JIRA_INTAKE_API_TOKEN") || undefined,
    trackerNativeStatusInProgress: get("TRACKER_NATIVE_STATUS_IN_PROGRESS") ?? "In Progress",
    trackerNativeStatusCodeReview: get("TRACKER_NATIVE_STATUS_CODE_REVIEW") ?? "Code Review",
    jiraCookieBrowser: get("JIRA_COOKIE_BROWSER") ?? "chrome",
  };
}
