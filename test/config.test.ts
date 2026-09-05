import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// config.ts reads a hardcoded ~/.config/ai-intake-mcp/.env path — mocking node:fs's readFileSync
// is the only seam available without changing that (a real dev machine may have a real file there,
// which would make env-var-precedence/error-path tests flaky or depend on ambient credentials).
const { readFileSyncMock } = vi.hoisted(() => ({ readFileSyncMock: vi.fn() }));
vi.mock("node:fs", () => ({ readFileSync: readFileSyncMock }));

const { loadGlobalConfig } = await import("../src/config.js");

function enoent(): NodeJS.ErrnoException {
  const err = new Error("no such file") as NodeJS.ErrnoException;
  err.code = "ENOENT";
  return err;
}

const ENV_KEYS = [
  "JIRA_SITE_URL",
  "JIRA_INTAKE_EMAIL",
  "JIRA_INTAKE_API_TOKEN",
  "TRACKER_NATIVE_STATUS_IN_PROGRESS",
  "TRACKER_NATIVE_STATUS_CODE_REVIEW",
  "JIRA_COOKIE_BROWSER",
];

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  readFileSyncMock.mockReset();
  readFileSyncMock.mockImplementation(() => {
    throw enoent();
  });
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe("loadGlobalConfig", () => {
  it("throws when JIRA_SITE_URL is not set", () => {
    process.env.JIRA_INTAKE_EMAIL = "bot@example.com";
    expect(() => loadGlobalConfig()).toThrow(/JIRA_SITE_URL is not set/);
  });

  it("throws when JIRA_INTAKE_EMAIL is not set", () => {
    process.env.JIRA_SITE_URL = "example.atlassian.net";
    expect(() => loadGlobalConfig()).toThrow(/JIRA_INTAKE_EMAIL is not set/);
  });

  it("rethrows a non-ENOENT error reading the env file", () => {
    readFileSyncMock.mockImplementation(() => {
      throw new Error("permission denied");
    });
    process.env.JIRA_SITE_URL = "example.atlassian.net";
    process.env.JIRA_INTAKE_EMAIL = "bot@example.com";
    expect(() => loadGlobalConfig()).toThrow(/permission denied/);
  });

  it("normalizes a bare site URL to https and strips a trailing slash", () => {
    process.env.JIRA_SITE_URL = "example.atlassian.net/";
    process.env.JIRA_INTAKE_EMAIL = "bot@example.com";
    expect(loadGlobalConfig().jiraSiteUrl).toBe("https://example.atlassian.net");
  });

  it("leaves an already-https site URL's scheme untouched", () => {
    process.env.JIRA_SITE_URL = "https://example.atlassian.net/";
    process.env.JIRA_INTAKE_EMAIL = "bot@example.com";
    expect(loadGlobalConfig().jiraSiteUrl).toBe("https://example.atlassian.net");
  });

  it("applies defaults for optional fields when unset", () => {
    process.env.JIRA_SITE_URL = "example.atlassian.net";
    process.env.JIRA_INTAKE_EMAIL = "bot@example.com";
    const config = loadGlobalConfig();
    expect(config.jiraApiToken).toBeUndefined();
    expect(config.trackerNativeStatusInProgress).toBe("In Progress");
    expect(config.trackerNativeStatusCodeReview).toBe("Code Review");
    expect(config.jiraCookieBrowser).toBe("chrome");
  });

  it("reads every field from env vars when set", () => {
    process.env.JIRA_SITE_URL = "example.atlassian.net";
    process.env.JIRA_INTAKE_EMAIL = "bot@example.com";
    process.env.JIRA_INTAKE_API_TOKEN = "secret-token";
    process.env.TRACKER_NATIVE_STATUS_IN_PROGRESS = "Doing";
    process.env.TRACKER_NATIVE_STATUS_CODE_REVIEW = "Review";
    process.env.JIRA_COOKIE_BROWSER = "firefox";
    expect(loadGlobalConfig()).toEqual({
      jiraSiteUrl: "https://example.atlassian.net",
      jiraEmail: "bot@example.com",
      jiraApiToken: "secret-token",
      trackerNativeStatusInProgress: "Doing",
      trackerNativeStatusCodeReview: "Review",
      jiraCookieBrowser: "firefox",
    });
  });

  it("falls back to the env file when a var isn't set in process.env", () => {
    readFileSyncMock.mockReturnValue(
      '# a comment\n\nJIRA_SITE_URL=example.atlassian.net\nJIRA_INTAKE_EMAIL="bot@example.com"\n',
    );
    const config = loadGlobalConfig();
    expect(config.jiraSiteUrl).toBe("https://example.atlassian.net");
    expect(config.jiraEmail).toBe("bot@example.com");
  });

  it("prefers a process.env value over the same key in the env file", () => {
    readFileSyncMock.mockReturnValue("JIRA_SITE_URL=from-file.atlassian.net\nJIRA_INTAKE_EMAIL=file@example.com\n");
    process.env.JIRA_SITE_URL = "from-env.atlassian.net";
    const config = loadGlobalConfig();
    expect(config.jiraSiteUrl).toBe("https://from-env.atlassian.net");
    expect(config.jiraEmail).toBe("file@example.com");
  });

  it("strips single and double quotes around a file value", () => {
    readFileSyncMock.mockReturnValue("JIRA_SITE_URL='example.atlassian.net'\nJIRA_INTAKE_EMAIL=\"bot@example.com\"\n");
    const config = loadGlobalConfig();
    expect(config.jiraSiteUrl).toBe("https://example.atlassian.net");
    expect(config.jiraEmail).toBe("bot@example.com");
  });

  it("strips a trailing inline comment from an unquoted value", () => {
    readFileSyncMock.mockReturnValue(
      "JIRA_SITE_URL=example.atlassian.net\nJIRA_INTAKE_EMAIL=dev@example.com # Personal Account\n",
    );
    const config = loadGlobalConfig();
    expect(config.jiraEmail).toBe("dev@example.com");
  });

  it("preserves a '#' inside a quoted value", () => {
    readFileSyncMock.mockReturnValue(
      'JIRA_SITE_URL=example.atlassian.net\nJIRA_INTAKE_EMAIL="dev@example.com # not a comment"\n',
    );
    const config = loadGlobalConfig();
    expect(config.jiraEmail).toBe("dev@example.com # not a comment");
  });

  it("leaves a '#' with no preceding whitespace untouched", () => {
    readFileSyncMock.mockReturnValue(
      "JIRA_SITE_URL=example.atlassian.net\nJIRA_INTAKE_EMAIL=dev@example.com\nJIRA_COOKIE_BROWSER=chrome#not-a-comment\n",
    );
    const config = loadGlobalConfig();
    expect(config.jiraCookieBrowser).toBe("chrome#not-a-comment");
  });
});
