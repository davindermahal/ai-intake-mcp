import { createCipheriv, pbkdf2Sync } from "node:crypto";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import type { CookieRow, CookieStoreDeps } from "../../src/jira/auth-cookie.js";

const mkdirSyncSpy = vi.fn();
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    mkdirSync: (...args: Parameters<typeof actual.mkdirSync>) => {
      mkdirSyncSpy(...args);
      return actual.mkdirSync(...args);
    },
  };
});

const { bareDomain, decryptChromeLinuxValue, getJiraCookieHeader, readCookieRowsFromChromeDb } = await import(
  "../../src/jira/auth-cookie.js"
);

const SAFE_STORAGE_PASSWORD = "test-safe-storage-password";

/** Mirrors decryptChromeLinuxValue's own scheme so tests can produce fixtures it can decrypt for
 * real — the crypto logic itself stays exercised, unlike the OS/browser plumbing around it. */
function encryptChromeLinuxValue(plaintext: string, safeStoragePassword: string, version: "v10" | "v11" = "v10"): Buffer {
  const key = pbkdf2Sync(safeStoragePassword, "saltysalt", 1, 16, "sha1");
  const iv = Buffer.alloc(16, " ");
  const cipher = createCipheriv("aes-128-cbc", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([Buffer.from(version, "latin1"), ciphertext]);
}

describe("bareDomain", () => {
  it("returns the last two labels of a multi-label hostname", () => {
    expect(bareDomain("example.atlassian.net")).toBe("atlassian.net");
  });

  it("leaves a bare two-label domain untouched", () => {
    expect(bareDomain("atlassian.net")).toBe("atlassian.net");
  });

  it("leaves a single-label hostname untouched", () => {
    expect(bareDomain("localhost")).toBe("localhost");
  });
});

describe("decryptChromeLinuxValue", () => {
  it("round-trips a v10-encrypted value", () => {
    const encrypted = encryptChromeLinuxValue("session-cookie-value", SAFE_STORAGE_PASSWORD, "v10");
    expect(decryptChromeLinuxValue(encrypted, SAFE_STORAGE_PASSWORD)).toBe("session-cookie-value");
  });

  it("round-trips a v11-encrypted value", () => {
    const encrypted = encryptChromeLinuxValue("session-cookie-value", SAFE_STORAGE_PASSWORD, "v11");
    expect(decryptChromeLinuxValue(encrypted, SAFE_STORAGE_PASSWORD)).toBe("session-cookie-value");
  });

  it("throws on an unrecognized encryption version prefix", () => {
    const encrypted = Buffer.concat([Buffer.from("v99", "latin1"), Buffer.alloc(16)]);
    expect(() => decryptChromeLinuxValue(encrypted, SAFE_STORAGE_PASSWORD)).toThrow(
      /Unrecognized Chrome cookie encryption version/,
    );
  });
});

describe("getJiraCookieHeader", () => {
  const unreachableDeps: CookieStoreDeps = {
    cookiesDbExists: () => {
      throw new Error("should not be called");
    },
    findKeyringPassword: () => {
      throw new Error("should not be called");
    },
    readCookieRows: () => {
      throw new Error("should not be called");
    },
  };

  it("rejects an unsupported browser before touching any OS integration", async () => {
    await expect(getJiraCookieHeader("https://example.atlassian.net", "firefox", unreachableDeps)).rejects.toThrow(
      /Unsupported JIRA_COOKIE_BROWSER "firefox"/,
    );
  });

  it("throws when the cookie store doesn't exist", async () => {
    const deps: CookieStoreDeps = { ...unreachableDeps, cookiesDbExists: () => false };
    await expect(getJiraCookieHeader("https://example.atlassian.net", "chrome", deps)).rejects.toThrow(
      /No cookie store found/,
    );
  });

  it("throws when the OS keyring has no stored password", async () => {
    const deps: CookieStoreDeps = {
      ...unreachableDeps,
      cookiesDbExists: () => true,
      findKeyringPassword: async () => undefined,
    };
    await expect(getJiraCookieHeader("https://example.atlassian.net", "chrome", deps)).rejects.toThrow(
      /Could not read "Chrome Safe Storage"/,
    );
  });

  it("throws when no cookies match the site's domain", async () => {
    const deps: CookieStoreDeps = {
      cookiesDbExists: () => true,
      findKeyringPassword: async () => SAFE_STORAGE_PASSWORD,
      readCookieRows: () => [],
    };
    await expect(getJiraCookieHeader("https://example.atlassian.net", "chrome", deps)).rejects.toThrow(
      /No cookies found for atlassian.net/,
    );
  });

  it("throws when every matching cookie has expired", async () => {
    const expired: CookieRow = {
      name: "cloud.session.token",
      encrypted_value: encryptChromeLinuxValue("stale", SAFE_STORAGE_PASSWORD),
      expires_utc: 1, // long past the Chrome epoch, definitely expired
    };
    const deps: CookieStoreDeps = {
      cookiesDbExists: () => true,
      findKeyringPassword: async () => SAFE_STORAGE_PASSWORD,
      readCookieRows: () => [expired],
    };
    await expect(getJiraCookieHeader("https://example.atlassian.net", "chrome", deps)).rejects.toThrow(
      /have expired/,
    );
  });

  it("joins every non-expired cookie into a single header value", async () => {
    const rows: CookieRow[] = [
      { name: "a", encrypted_value: encryptChromeLinuxValue("1", SAFE_STORAGE_PASSWORD), expires_utc: 0 },
      {
        name: "b",
        encrypted_value: encryptChromeLinuxValue("2", SAFE_STORAGE_PASSWORD),
        expires_utc: (Date.now() + 11644473600000) * 1000 + 1_000_000_000,
      },
    ];
    const deps: CookieStoreDeps = {
      cookiesDbExists: () => true,
      findKeyringPassword: async () => SAFE_STORAGE_PASSWORD,
      readCookieRows: () => rows,
    };
    const header = await getJiraCookieHeader("https://example.atlassian.net", "chrome", deps);
    expect(header).toBe("a=1; b=2");
  });

  it("skips a cookie that fails to decrypt instead of aborting the whole header", async () => {
    const corrupt: CookieRow = {
      name: "marketing-tracker",
      encrypted_value: Buffer.concat([Buffer.from("v99", "latin1"), Buffer.alloc(16)]),
      expires_utc: 0,
    };
    const valid: CookieRow = {
      name: "cloud.session.token",
      encrypted_value: encryptChromeLinuxValue("real-session", SAFE_STORAGE_PASSWORD),
      expires_utc: 0,
    };
    const deps: CookieStoreDeps = {
      cookiesDbExists: () => true,
      findKeyringPassword: async () => SAFE_STORAGE_PASSWORD,
      readCookieRows: () => [corrupt, valid],
    };
    const header = await getJiraCookieHeader("https://example.atlassian.net", "chrome", deps);
    expect(header).toBe("cloud.session.token=real-session");
  });
});

describe("readCookieRowsFromChromeDb", () => {
  it("copies the cookies DB into a 0700 temp directory and cleans it up afterward", () => {
    const sourceDir = mkdtempSync(join(tmpdir(), "ai-intake-mcp-cookies-src-"));
    const sourceDb = join(sourceDir, "Cookies");
    const db = new Database(sourceDb);
    db.exec(
      "CREATE TABLE cookies (name TEXT, encrypted_value BLOB, expires_utc INTEGER, host_key TEXT)",
    );
    db.prepare("INSERT INTO cookies VALUES (?, ?, ?, ?)").run(
      "cloud.session.token",
      Buffer.from("v10ciphertext"),
      0,
      ".atlassian.net",
    );
    db.close();

    mkdirSyncSpy.mockClear();
    const rows = readCookieRowsFromChromeDb(sourceDb, "atlassian.net");

    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe("cloud.session.token");

    expect(mkdirSyncSpy).toHaveBeenCalledTimes(1);
    const [tmpDirArg, mkdirOptions] = mkdirSyncSpy.mock.calls[0]!;
    expect(mkdirOptions).toMatchObject({ recursive: true, mode: 0o700 });
    expect(existsSync(tmpDirArg as string)).toBe(false); // cleaned up afterward
  });
});
