import type { GlobalConfig } from "../config.js";

/**
 * The one chokepoint every Confluence call goes through (curated-guide-retrieval.md Key decision
 * #6) — site/email/token resolution (`confluence* ?? jira*`) is decided here.
 */

export type FetchLike = typeof fetch;

export class ConfluenceApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly statusText: string,
    public readonly body: string,
  ) {
    super(`Confluence API error ${status} ${statusText}: ${body}`);
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

export interface ConfluenceClientOptions {
  config: GlobalConfig;
  /** Substituted directly in tests — no real HTTP in unit tests. */
  fetchImpl?: FetchLike;
  /** Substituted in tests to avoid real delays during retry-backoff assertions. */
  sleepImpl?: (ms: number) => Promise<void>;
}

export class ConfluenceClient {
  private readonly config: GlobalConfig;
  private readonly fetchImpl: FetchLike;
  private readonly sleepImpl: (ms: number) => Promise<void>;

  constructor(options: ConfluenceClientOptions) {
    this.config = options.config;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleepImpl = options.sleepImpl ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  private siteUrl(): string {
    const raw = this.config.confluenceSiteUrl ?? this.config.jiraSiteUrl;
    const normalized = /^https?:\/\//.test(raw) ? raw : `https://${raw}`;
    return normalized.replace(/\/+$/, "");
  }

  private authHeaders(): Record<string, string> {
    const email = this.config.confluenceEmail ?? this.config.jiraEmail;
    const apiToken = this.config.confluenceApiToken ?? this.config.jiraApiToken;
    if (!apiToken) {
      throw new Error(
        "No Confluence API token available: set CONFLUENCE_API_TOKEN, or JIRA_INTAKE_API_TOKEN if " +
          "Confluence and Jira share credentials (curated-guide-retrieval.md Key decision #6). " +
          "There is no cookie-auth fallback for Confluence — a real API token is required.",
      );
    }
    const basic = Buffer.from(`${email}:${apiToken}`).toString("base64");
    return { Authorization: `Basic ${basic}` };
  }

  /**
   * Retries transient failures — HTTP 429 and 5xx, plus network-level errors (fetch throwing) — up
   * to MAX_ATTEMPTS, honoring `Retry-After` when a 429/5xx response provides one and falling back to
   * capped exponential backoff otherwise. A non-retryable 4xx (other than 429) throws immediately.
   */
  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      ...this.authHeaders(),
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const isLastAttempt = attempt === MAX_ATTEMPTS - 1;
      let res: Response;
      try {
        res = await this.fetchImpl(`${this.siteUrl()}${path}`, {
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
        throw new ConfluenceApiError(res.status, res.statusText, text);
      }
      if (res.status === 204) return undefined as T;
      const text = await res.text();
      return (text ? JSON.parse(text) : undefined) as T;
    }
    // Unreachable: the loop always returns or throws before MAX_ATTEMPTS is exhausted.
    throw new Error("Confluence request retry loop exited unexpectedly.");
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
}

export interface ConfluencePageBody {
  id: string;
  title: string;
  body: { storage: { value: string; representation: "storage" } };
}

/**
 * Fetches a Confluence page's storage-format body by its full page URL (as it appears in the
 * index table's Link column) — `/wiki/rest/api/content?...` needs a page ID, but index rows carry
 * whatever full URL a human pasted in, so this resolves either shape:
 * `.../wiki/spaces/<SPACE>/pages/<ID>/<title-slug>` or `.../wiki/pages/viewpage.action?pageId=<ID>`.
 */
export function extractPageIdFromUrl(url: string): string | undefined {
  const spacesMatch = url.match(/\/pages\/(\d+)(?:\/|$)/);
  if (spacesMatch) return spacesMatch[1];
  const viewpageMatch = url.match(/[?&]pageId=(\d+)/);
  if (viewpageMatch) return viewpageMatch[1];
  return undefined;
}

export async function fetchPageByUrl(client: ConfluenceClient, url: string): Promise<ConfluencePageBody> {
  const pageId = extractPageIdFromUrl(url);
  if (!pageId) {
    throw new Error(`Could not extract a Confluence page ID from URL: ${url}`);
  }
  return client.get<ConfluencePageBody>(`/wiki/rest/api/content/${pageId}?expand=body.storage`);
}
