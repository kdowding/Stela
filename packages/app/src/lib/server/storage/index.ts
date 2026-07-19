import { env } from "$env/dynamic/private";
import { AzureStore } from "./azure";
import { SqliteStore } from "./sqlite";
import type { Store } from "./types";

let instance: Store | null = null;

/** The app's single storage entry point. Driver choice is read once with the memoized instance. */
export function getStore(): Store {
  if (!instance) {
    const driver = env.STORAGE_DRIVER?.trim() || "sqlite";
    if (driver === "sqlite") instance = new SqliteStore();
    else if (driver === "azure") instance = new AzureStore();
    else throw new Error(`[stela] Unsupported STORAGE_DRIVER '${driver}'. Expected 'sqlite' or 'azure'.`);
  }
  return instance;
}

export type { Store } from "./types";
export { LastVersionError } from "./types";
