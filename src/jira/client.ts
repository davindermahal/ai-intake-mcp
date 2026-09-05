import type { GlobalConfig } from "../config.js";

/** The one chokepoint every Jira call goes through (decision #9) — token-vs-cookie is decided here. */

export type FetchLike = typeof fetch;

export class JiraApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly statusText: string,
    public readonly body: string,
  ) {
    super(`Jira API error ${status} ${statusText}: ${body}`);
  }
}

const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 8000;

function backoffMs(attempt: number): number {
  return Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
}

/** Retry-After is either a whole number of seconds, or an HTTP-date (RFC 7231 §7.1.3). */
function retryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  if (/^\d+$/.test(header.trim())) return Number(header) * 1000;
  const dateMs = Date.parse(header);
  return Number.isNaN(dateMs) ? undefined : Math.max(0, dateMs - Date.now());
}

export interface JiraClientOptions {
  config: GlobalConfig;
  /** Substituted directly in tests (see "Resolved: Testing approach") — no real HTTP in unit tests. */
  fetchImpl?: FetchLike;
  /** Substituted in tests to avoid real delays during retry-backoff assertions. */
  sleepImpl?: (ms: number) => Promise<void>;
}

export class JiraClient {
  private readonly config: GlobalConfig;
  private readonly fetchImpl: FetchLike;
  private readonly sleepImpl: (ms: number) => Promise<void>;

  constructor(options: JiraClientOptions) {
    this.config = options.config;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleepImpl = options.sleepImpl ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  private async authHeaders(): Promise<Record<string, string>> {
    if (this.config.jiraApiToken) {
      const basic = Buffer.from(`${this.config.jiraEmail}:${this.config.jiraApiToken}`).toString(
        "base64",
      );
      return { Authorization: `Basic ${basic}` };
    }
    // Lazy-imported: cookie mode pulls in keytar/better-sqlite3 (native modules), which token-mode
    // developers shouldn't need to have installable/loadable on their machine at all.
    const { getJiraCookieHeader } = await import("./auth-cookie.js");
    const cookie = await getJiraCookieHeader(this.config.jiraSiteUrl, this.config.jiraCookieBrowser);
    return { Cookie: cookie, "X-Atlassian-Token": "no-check" };
  }

  /**
   * Retries transient failures — HTTP 429 and 5xx, plus network-level errors (fetch throwing) — up
   * to MAX_ATTEMPTS, honoring `Retry-After` when a 429/5xx response provides one and falling back to
   * capped exponential backoff otherwise. A non-retryable 4xx (other than 429) throws immediately.
   */
  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      ...(await this.authHeaders()),
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const isLastAttempt = attempt === MAX_ATTEMPTS - 1;
      let res: Response;
      try {
        res = await this.fetchImpl(`${this.config.jiraSiteUrl}${path}`, {
          method,
          headers,
          body: body !== undefined ? JSON.stringify(body) : undefined,
        });
      } catch (err) {
        if (isLastAttempt) throw err;
        await this.sleepImpl(backoffMs(attempt));
        continue;
      }

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        if ((res.status === 429 || res.status >= 500) && !isLastAttempt) {
          await this.sleepImpl(retryAfterMs(res.headers.get("Retry-After")) ?? backoffMs(attempt));
          continue;
        }
        throw new JiraApiError(res.status, res.statusText, text);
      }
      if (res.status === 204) return undefined as T;
      const text = await res.text();
      return (text ? JSON.parse(text) : undefined) as T;
    }
    // Unreachable: the loop always returns or throws before MAX_ATTEMPTS is exhausted.
    throw new Error("Jira request retry loop exited unexpectedly.");
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>("GET", path);
  }

  post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("POST", path, body);
  }

  put<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("PUT", path, body);
  }

  delete<T>(path: string): Promise<T> {
    return this.request<T>("DELETE", path);
  }
}
