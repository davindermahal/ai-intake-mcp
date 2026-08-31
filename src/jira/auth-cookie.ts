import { createDecipheriv, pbkdf2Sync } from "node:crypto";
import { copyFileSync, existsSync, unlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import keytar from "keytar";

/**
 * Cookie fallback for developers who can't get a Jira API token issued (decision #9). v1 scope is
 * deliberately narrow: Chrome/Chromium on Linux only, matching this team's actual dev environment —
 * not the harness's cross-browser/cross-OS breadth. Extend only if a developer actually needs it.
 *
 * A fresh cookie is extracted on every call, never cached to disk — same contract as the harness.
 */

const PROFILE_DIR: Record<string, string> = {
  chrome: join(homedir(), ".config", "google-chrome", "Default"),
  chromium: join(homedir(), ".config", "chromium", "Default"),
};

const KEYRING_SERVICE: Record<string, string> = {
  chrome: "Chrome Safe Storage",
  chromium: "Chromium Safe Storage",
};

export function bareDomain(hostname: string): string {
  const parts = hostname.split(".");
  return parts.length <= 2 ? hostname : parts.slice(-2).join(".");
}

export function decryptChromeLinuxValue(encrypted: Buffer, safeStoragePassword: string): string {
  const prefix = encrypted.subarray(0, 3).toString("latin1");
  if (prefix !== "v10" && prefix !== "v11") {
    throw new Error(`Unrecognized Chrome cookie encryption version: ${prefix}`);
  }
  const key = pbkdf2Sync(safeStoragePassword, "saltysalt", 1, 16, "sha1");
  const iv = Buffer.alloc(16, " ");
  const ciphertext = encrypted.subarray(3);
  const decipher = createDecipheriv("aes-128-cbc", key, iv);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

export interface CookieRow {
  name: string;
  encrypted_value: Buffer;
  expires_utc: number;
}

/**
 * The OS/browser-integration surface, injectable so `getJiraCookieHeader`'s fallback ordering and
 * error handling can be unit-tested with fakes (hardening-phase plan, decision #4) — the real
 * default wiring (native keytar/better-sqlite3, a live browser profile) is exactly what a unit test
 * can't honestly exercise; that stays a real-system check (`scripts/health-check.ts`), not something
 * this refactor pretends to cover.
 */
export interface CookieStoreDeps {
  cookiesDbExists: (path: string) => boolean;
  findKeyringPassword: (service: string) => Promise<string | null | undefined>;
  readCookieRows: (cookiesDbPath: string, domain: string) => CookieRow[];
}

function readCookieRowsFromChromeDb(cookiesDbPath: string, domain: string): CookieRow[] {
  // Chrome keeps an exclusive lock on its live Cookies DB — read from a throwaway copy instead.
  const tmpCopy = join(tmpdir(), `ai-intake-mcp-cookies-${process.pid}-${Date.now()}.sqlite`);
  copyFileSync(cookiesDbPath, tmpCopy);
  try {
    const db = new Database(tmpCopy, { readonly: true });
    try {
      return db
        .prepare(`SELECT name, encrypted_value, expires_utc FROM cookies WHERE host_key LIKE ?`)
        .all(`%${domain}%`) as CookieRow[];
    } finally {
      db.close();
    }
  } finally {
    unlinkSync(tmpCopy);
  }
}

const defaultDeps: CookieStoreDeps = {
  cookiesDbExists: existsSync,
  findKeyringPassword: (service) => keytar.findPassword(service),
  readCookieRows: readCookieRowsFromChromeDb,
};

/**
 * Returns a `Cookie:` header value carrying every non-expired cookie Chrome/Chromium holds for
 * `siteUrl`'s domain (and its parent, e.g. cookies scoped to `.atlassian.net`). Fails loudly (not
 * silently) if the browser isn't installed, has no session, or the OS keyring can't be unlocked —
 * a live, unlocked desktop session with a logged-in browser is required, same as the harness today.
 */
export async function getJiraCookieHeader(
  siteUrl: string,
  browser: string,
  deps: CookieStoreDeps = defaultDeps,
): Promise<string> {
  const profileDir = PROFILE_DIR[browser];
  const keyringService = KEYRING_SERVICE[browser];
  if (!profileDir || !keyringService) {
    throw new Error(
      `Unsupported JIRA_COOKIE_BROWSER "${browser}" — v1 only supports "chrome" or "chromium" on Linux.`,
    );
  }

  const cookiesDbPath = join(profileDir, "Cookies");
  if (!deps.cookiesDbExists(cookiesDbPath)) {
    throw new Error(
      `No cookie store found at ${cookiesDbPath} — is ${browser} installed and has it been run at least once?`,
    );
  }

  const safeStoragePassword = await deps.findKeyringPassword(keyringService);
  if (!safeStoragePassword) {
    throw new Error(
      `Could not read "${keyringService}" from the OS keyring — is this a live, unlocked desktop ` +
        `session with ${browser} installed and the keyring service running (libsecret/GNOME Keyring)?`,
    );
  }

  const domain = bareDomain(new URL(siteUrl).hostname);
  const rows = deps.readCookieRows(cookiesDbPath, domain);

  if (rows.length === 0) {
    throw new Error(
      `No cookies found for ${domain} in ${browser}'s cookie store — log into Jira in ${browser} first.`,
    );
  }

  const nowChromeEpoch = (Date.now() + 11644473600000) * 1000;
  const pairs = rows
    .filter((row) => row.expires_utc === 0 || row.expires_utc > nowChromeEpoch)
    .map((row) => `${row.name}=${decryptChromeLinuxValue(row.encrypted_value, safeStoragePassword)}`);

  if (pairs.length === 0) {
    throw new Error(
      `All cookies found for ${domain} in ${browser} have expired — log into Jira in ${browser} again.`,
    );
  }
  return pairs.join("; ");
}
