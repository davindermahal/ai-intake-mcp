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

export interface JiraClientOptions {
  config: GlobalConfig;
  /** Substituted directly in tests (see "Resolved: Testing approach") — no real HTTP in unit tests. */
  fetchImpl?: FetchLike;
}

export class JiraClient {
  private readonly config: GlobalConfig;
  private readonly fetchImpl: FetchLike;

  constructor(options: JiraClientOptions) {
    this.config = options.config;
    this.fetchImpl = options.fetchImpl ?? fetch;
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

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      ...(await this.authHeaders()),
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";

    const res = await this.fetchImpl(`${this.config.jiraSiteUrl}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new JiraApiError(res.status, res.statusText, text);
    }
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
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
