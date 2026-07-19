// Force production behavior for this module graph — checkProdConfig() is a no-op when dev=true.
vi.mock("$app/environment", () => ({ dev: false, building: false, browser: false, version: "test" }));

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkProdConfig } from "./startup";

const GOOD_KEY = "a".repeat(32);
const GOOD_BODY_LIMIT = "12000000";

/** Stub a complete valid production config; tests override the one branch they exercise. */
function stubValidConfig() {
  vi.stubEnv("ORIGIN", "https://stela.example");
  vi.stubEnv("AUTH_MODE", "header");
  vi.stubEnv("AUTH_PRESET", "easyauth");
  vi.stubEnv("AUTH_HEADER_ID", "");
  vi.stubEnv("AUTH_HEADER_NAME", "");
  vi.stubEnv("AUTH_HEADER_EMAIL", "");
  vi.stubEnv("STELA_API_KEY", GOOD_KEY);
  vi.stubEnv("BODY_SIZE_LIMIT", GOOD_BODY_LIMIT);
  vi.stubEnv("STORAGE_DRIVER", "azure");
  vi.stubEnv("DATA_DIR", "");
  vi.stubEnv("AZURE_STORAGE_ACCOUNT", "stelastorage");
  vi.stubEnv("AZURE_STORAGE_CONNECTION_STRING", "");
}

describe("checkProdConfig (production)", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stubValidConfig();
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    errorSpy.mockRestore();
  });

  const messages = (): string[] =>
    errorSpy.mock.calls.map((call: unknown[]) => String(call[0]));
  const nonSecurityMessages = (): string[] =>
    messages().filter((message) => !message.includes("[stela] SECURITY:"));

  describe("ORIGIN (fail-fast)", () => {
    it("throws when ORIGIN is unset", () => {
      vi.stubEnv("ORIGIN", "");
      expect(() => checkProdConfig()).toThrow(/ORIGIN must be set/);
    });

    it("throws before reaching logging checks when ORIGIN is unset", () => {
      vi.stubEnv("ORIGIN", "");
      vi.stubEnv("STELA_API_KEY", "short");
      vi.stubEnv("BODY_SIZE_LIMIT", "1");
      expect(() => checkProdConfig()).toThrow();
      expect(errorSpy).not.toHaveBeenCalled();
    });

    it("does not throw when ORIGIN is set with otherwise-valid config", () => {
      expect(() => checkProdConfig()).not.toThrow();
    });

    it("logs no non-security errors for a fully valid config", () => {
      checkProdConfig();
      expect(nonSecurityMessages()).toEqual([]);
    });
  });

  describe("trusted-header auth (fail-fast and loud)", () => {
    it("throws when AUTH_MODE is missing", () => {
      vi.stubEnv("AUTH_MODE", "");
      expect(() => checkProdConfig()).toThrow(/AUTH_MODE must be set to 'header'/);
    });

    it("throws when AUTH_MODE is unsupported", () => {
      vi.stubEnv("AUTH_MODE", "oidc");
      expect(() => checkProdConfig()).toThrow(/AUTH_MODE must be set to 'header'/);
    });

    it("throws for an unsupported AUTH_PRESET", () => {
      vi.stubEnv("AUTH_PRESET", "unknown");
      expect(() => checkProdConfig()).toThrow(/Unsupported AUTH_PRESET/);
    });

    it("throws in generic header mode when AUTH_HEADER_ID is missing", () => {
      vi.stubEnv("AUTH_PRESET", "");
      vi.stubEnv("AUTH_HEADER_ID", "");
      expect(() => checkProdConfig()).toThrow(/AUTH_HEADER_ID/);
    });

    it("does not require AUTH_HEADER_ID for the Easy Auth preset", () => {
      vi.stubEnv("AUTH_HEADER_ID", "");
      expect(() => checkProdConfig()).not.toThrow();
    });

    it("logs the exact generic trusted headers and proxy-only warning", () => {
      vi.stubEnv("AUTH_PRESET", "");
      vi.stubEnv("AUTH_HEADER_ID", "x-auth-user");
      vi.stubEnv("AUTH_HEADER_NAME", "x-auth-name");
      vi.stubEnv("AUTH_HEADER_EMAIL", "x-auth-email");
      checkProdConfig();
      expect(errorSpy).toHaveBeenCalledWith(
        "[stela] SECURITY: trusting identity headers x-auth-user, x-auth-name, x-auth-email. " +
          "Stela must only be reachable through the auth proxy that sets and strips these headers.",
      );
    });

    it("names only x-ms-client-principal in the Easy Auth preset warning", () => {
      checkProdConfig();
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringMatching(/trusting identity header x-ms-client-principal\./),
      );
    });
  });

  describe("STELA_API_KEY (loud log, non-fatal)", () => {
    it("logs an error when STELA_API_KEY is missing", () => {
      vi.stubEnv("STELA_API_KEY", "");
      checkProdConfig();
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("STELA_API_KEY is not set"),
      );
    });

    it("logs an error when STELA_API_KEY is shorter than 24 chars", () => {
      vi.stubEnv("STELA_API_KEY", "a".repeat(23));
      checkProdConfig();
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("shorter than 24 chars"));
    });

    it("does not log a key error at the 24-character boundary", () => {
      vi.stubEnv("STELA_API_KEY", "a".repeat(24));
      checkProdConfig();
      expect(nonSecurityMessages()).toEqual([]);
    });

    it("does not throw when the API key is missing", () => {
      vi.stubEnv("STELA_API_KEY", "");
      expect(() => checkProdConfig()).not.toThrow();
    });
  });

  describe("BODY_SIZE_LIMIT (loud log, non-fatal)", () => {
    it("logs when BODY_SIZE_LIMIT is below the 10 MB cap", () => {
      vi.stubEnv("BODY_SIZE_LIMIT", "9999999");
      checkProdConfig();
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("BODY_SIZE_LIMIT is below"));
    });

    it("logs when BODY_SIZE_LIMIT is unset", () => {
      vi.stubEnv("BODY_SIZE_LIMIT", "");
      checkProdConfig();
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("BODY_SIZE_LIMIT is below"));
    });

    it("logs when BODY_SIZE_LIMIT is non-numeric", () => {
      vi.stubEnv("BODY_SIZE_LIMIT", "not-a-number");
      checkProdConfig();
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("BODY_SIZE_LIMIT is below"));
    });

    it("does not log a body-limit error at exactly 10,000,000", () => {
      vi.stubEnv("BODY_SIZE_LIMIT", "10000000");
      checkProdConfig();
      expect(nonSecurityMessages()).toEqual([]);
    });

    it("does not throw when BODY_SIZE_LIMIT is too low", () => {
      vi.stubEnv("BODY_SIZE_LIMIT", "1");
      expect(() => checkProdConfig()).not.toThrow();
    });
  });

  describe("storage (fail-fast)", () => {
    it("throws when STORAGE_DRIVER is missing", () => {
      vi.stubEnv("STORAGE_DRIVER", "");
      expect(() => checkProdConfig()).toThrow(/STORAGE_DRIVER must be set/);
    });

    it("throws for an unknown storage driver", () => {
      vi.stubEnv("STORAGE_DRIVER", "postgres");
      expect(() => checkProdConfig()).toThrow(/Unsupported STORAGE_DRIVER/);
    });

    it("requires DATA_DIR for the sqlite driver", () => {
      vi.stubEnv("STORAGE_DRIVER", "sqlite");
      vi.stubEnv("DATA_DIR", "");
      expect(() => checkProdConfig()).toThrow(/DATA_DIR must be set explicitly/);
    });

    it("creates and verifies a sqlite DATA_DIR while ignoring Azure-only settings", () => {
      const scratch = mkdtempSync(join(tmpdir(), "stela-startup-"));
      const dataDir = join(scratch, "new-data-dir");
      try {
        vi.stubEnv("STORAGE_DRIVER", "sqlite");
        vi.stubEnv("DATA_DIR", dataDir);
        vi.stubEnv("AZURE_STORAGE_ACCOUNT", "");
        vi.stubEnv("AZURE_STORAGE_CONNECTION_STRING", "UseDevelopmentStorage=true");
        expect(() => checkProdConfig()).not.toThrow();
        expect(existsSync(dataDir)).toBe(true);
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    });

    it("rejects a sqlite DATA_DIR that cannot be created or written", () => {
      const scratch = mkdtempSync(join(tmpdir(), "stela-startup-"));
      const file = join(scratch, "not-a-directory");
      writeFileSync(file, "x");
      try {
        vi.stubEnv("STORAGE_DRIVER", "sqlite");
        vi.stubEnv("DATA_DIR", join(file, "child"));
        expect(() => checkProdConfig()).toThrow(/not writable/);
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    });

    it("requires an account or connection string for the azure driver", () => {
      vi.stubEnv("AZURE_STORAGE_ACCOUNT", "");
      vi.stubEnv("AZURE_STORAGE_CONNECTION_STRING", "");
      expect(() => checkProdConfig()).toThrow(/No Azure storage configured/);
    });

    it("throws when the connection string points at local Azurite", () => {
      vi.stubEnv("AZURE_STORAGE_ACCOUNT", "");
      vi.stubEnv("AZURE_STORAGE_CONNECTION_STRING", "UseDevelopmentStorage=true");
      expect(() => checkProdConfig()).toThrow(/local emulator/);
    });

    it("does not throw when AZURE_STORAGE_ACCOUNT is set", () => {
      expect(() => checkProdConfig()).not.toThrow();
    });

    it("does not require DATA_DIR for the azure driver", () => {
      vi.stubEnv("DATA_DIR", "");
      expect(() => checkProdConfig()).not.toThrow();
    });
  });

  it("logs both non-fatal operational errors when both are present", () => {
    vi.stubEnv("STELA_API_KEY", "");
    vi.stubEnv("BODY_SIZE_LIMIT", "5");
    checkProdConfig();
    expect(nonSecurityMessages()).toEqual([
      expect.stringContaining("STELA_API_KEY is not set"),
      expect.stringContaining("BODY_SIZE_LIMIT is below"),
    ]);
  });
});

describe("checkProdConfig (dev no-op)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("never throws or logs in dev, even with a fully broken config", async () => {
    vi.resetModules();
    vi.doMock("$app/environment", () => ({ dev: true, building: false, browser: false, version: "test" }));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("ORIGIN", "");
    vi.stubEnv("AUTH_MODE", "");
    vi.stubEnv("AUTH_HEADER_ID", "");
    vi.stubEnv("STELA_API_KEY", "");
    vi.stubEnv("BODY_SIZE_LIMIT", "1");
    const { checkProdConfig: devCheck } = await import("./startup");
    expect(() => devCheck()).not.toThrow();
    expect(errorSpy).not.toHaveBeenCalled();
    vi.doUnmock("$app/environment");
  });
});
