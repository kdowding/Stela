import { dev } from "$app/environment";
import { env } from "$env/dynamic/private";
import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Fail-fast / loud config self-check at server start. No-op in dev. Critical settings throw
 * before the app serves: origin, trusted-header auth, and storage. Non-fatal operational weaknesses
 * are logged loudly so a misconfigured deploy is observable.
 */
export function checkProdConfig(): void {
  if (dev) return;
  if (!env.ORIGIN) {
    throw new Error("[stela] ORIGIN must be set in production — refusing to serve.");
  }

  if (env.AUTH_MODE !== "header") {
    throw new Error(
      "[stela] AUTH_MODE must be set to 'header' in production — refusing to serve.",
    );
  }
  if (env.AUTH_PRESET && env.AUTH_PRESET !== "easyauth") {
    throw new Error(
      `[stela] Unsupported AUTH_PRESET '${env.AUTH_PRESET}' — refusing to serve.`,
    );
  }
  if (!env.AUTH_PRESET && !env.AUTH_HEADER_ID?.trim()) {
    throw new Error(
      "[stela] AUTH_HEADER_ID must name the trusted user-id header in generic header mode — refusing to serve.",
    );
  }
  const storageDriver = env.STORAGE_DRIVER?.trim();
  if (!storageDriver) {
    throw new Error(
      "[stela] STORAGE_DRIVER must be set to 'sqlite' or 'azure' in production — refusing to serve.",
    );
  }
  if (storageDriver === "sqlite") {
    const dataDir = env.DATA_DIR?.trim();
    if (!dataDir) {
      throw new Error(
        "[stela] DATA_DIR must be set explicitly for SQLite in production — refusing to serve.",
      );
    }
    verifyWritableDataDir(dataDir);
  } else if (storageDriver === "azure") {
    // Azure's local fallback is useful in development but must never happen silently in production.
    const account = env.AZURE_STORAGE_ACCOUNT;
    const conn = env.AZURE_STORAGE_CONNECTION_STRING;
    if (!account && !conn) {
      throw new Error(
        "[stela] No Azure storage configured in production — set AZURE_STORAGE_ACCOUNT " +
          "(managed identity) or AZURE_STORAGE_CONNECTION_STRING.",
      );
    }
    if (conn && /UseDevelopmentStorage=true/i.test(conn)) {
      throw new Error(
        "[stela] AZURE_STORAGE_CONNECTION_STRING points at the local emulator in production. Refusing to serve.",
      );
    }
  } else {
    throw new Error(
      `[stela] Unsupported STORAGE_DRIVER '${storageDriver}' — expected 'sqlite' or 'azure'. Refusing to serve.`,
    );
  }

  const trustedHeaders =
    env.AUTH_PRESET === "easyauth"
      ? ["x-ms-client-principal"]
      : [env.AUTH_HEADER_ID, env.AUTH_HEADER_NAME, env.AUTH_HEADER_EMAIL]
          .map((name) => name?.trim())
          .filter((name): name is string => Boolean(name));
  console.error(
    `[stela] SECURITY: trusting identity header${trustedHeaders.length === 1 ? "" : "s"} ` +
      `${trustedHeaders.join(", ")}. Stela must only be reachable through the auth proxy that sets and strips these headers.`,
  );

  if (!env.STELA_API_KEY) {
    console.error("[stela] config: STELA_API_KEY is not set — admin publish is disabled.");
  } else if (env.STELA_API_KEY.length < 24) {
    console.error("[stela] config: STELA_API_KEY is shorter than 24 chars — low entropy.");
  }
  const bodyLimit = Number(env.BODY_SIZE_LIMIT ?? "0");
  if (!Number.isFinite(bodyLimit) || bodyLimit < 10_000_000) {
    console.error("[stela] config: BODY_SIZE_LIMIT is below the 10 MB artifact cap.");
  }
}

/** Create the production data directory when needed, then prove this process can create a file in it. */
function verifyWritableDataDir(dataDir: string): void {
  const directory = resolve(dataDir);
  const probe = resolve(directory, `.stela-write-test-${process.pid}-${randomUUID()}`);
  let descriptor: number | undefined;
  try {
    mkdirSync(directory, { recursive: true });
    descriptor = openSync(probe, "wx");
    closeSync(descriptor);
    descriptor = undefined;
    unlinkSync(probe);
  } catch (cause) {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // Preserve the writability failure below.
      }
    }
    try {
      unlinkSync(probe);
    } catch {
      // The probe may never have been created.
    }
    throw new Error(`[stela] SQLite DATA_DIR '${dataDir}' is not writable — refusing to serve.`, {
      cause,
    });
  }
}
