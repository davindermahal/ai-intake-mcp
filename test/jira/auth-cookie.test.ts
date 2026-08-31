import { createCipheriv, pbkdf2Sync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  bareDomain,
  decryptChromeLinuxValue,
  getJiraCookieHeader,
  type CookieRow,
  type CookieStoreDeps,
} from "../../src/jira/auth-cookie.js";

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
});
