import { afterEach, describe, expect, it, vi } from "vitest";

function closeSqliteStore(store: object): void {
  if (!("close" in store) || typeof store.close !== "function") {
    throw new Error("Expected a closable SqliteStore");
  }
  store.close();
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("storage driver factory", () => {
  it("defaults to one memoized SqliteStore when STORAGE_DRIVER is unset", async () => {
    vi.stubEnv("STORAGE_DRIVER", "");
    const { getStore } = await import("./index");
    const { SqliteStore } = await import("./sqlite");
    const first = getStore();
    expect(first).toBeInstanceOf(SqliteStore);
    expect(getStore()).toBe(first);
    closeSqliteStore(first);
  });

  it("selects AzureStore explicitly", async () => {
    vi.stubEnv("STORAGE_DRIVER", "azure");
    const { getStore } = await import("./index");
    const { AzureStore } = await import("./azure");
    expect(getStore()).toBeInstanceOf(AzureStore);
  });

  it("selects SqliteStore explicitly", async () => {
    vi.stubEnv("STORAGE_DRIVER", "sqlite");
    const { getStore } = await import("./index");
    const { SqliteStore } = await import("./sqlite");
    const store = getStore();
    expect(store).toBeInstanceOf(SqliteStore);
    closeSqliteStore(store);
  });

  it("rejects an unknown driver", async () => {
    vi.stubEnv("STORAGE_DRIVER", "postgres");
    const { getStore } = await import("./index");
    expect(() => getStore()).toThrow(/Unsupported STORAGE_DRIVER 'postgres'/);
  });
});
