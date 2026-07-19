import { describe, it, expect, vi, afterEach } from "vitest";
import { randomBytes } from "node:crypto";
import { rateLimit, clientIp } from "./ratelimit";
import { makeEvent } from "../../test/helpers";

/** Unique bucket name per test so the module-level Map never bleeds across tests. */
const bucket = () => "b-" + randomBytes(8).toString("hex");

describe("rateLimit", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows exactly `limit` calls then throws 429 on the next", () => {
    const name = bucket();
    const id = "id-1";
    // Exactly `limit` calls succeed.
    for (let i = 0; i < 3; i++) {
      expect(() => rateLimit(name, id, 3, 60_000)).not.toThrow();
    }
    // The (limit+1)th call throws a 429 HttpError.
    expect(() => rateLimit(name, id, 3, 60_000)).toThrowError(
      expect.objectContaining({ status: 429 }),
    );
  });

  it("a limit of 1 allows a single call then blocks", () => {
    const name = bucket();
    expect(() => rateLimit(name, "solo", 1, 60_000)).not.toThrow();
    expect(() => rateLimit(name, "solo", 1, 60_000)).toThrowError(
      expect.objectContaining({ status: 429 }),
    );
  });

  it("keeps throwing once over the limit (does not recover within the window)", () => {
    const name = bucket();
    const id = "sticky";
    rateLimit(name, id, 2, 60_000);
    rateLimit(name, id, 2, 60_000);
    expect(() => rateLimit(name, id, 2, 60_000)).toThrowError(
      expect.objectContaining({ status: 429 }),
    );
    // Subsequent calls still blocked while the window is open.
    expect(() => rateLimit(name, id, 2, 60_000)).toThrowError(
      expect.objectContaining({ status: 429 }),
    );
    expect(() => rateLimit(name, id, 2, 60_000)).toThrowError(
      expect.objectContaining({ status: 429 }),
    );
  });

  it("different ids are independent (one being limited does not affect another)", () => {
    const name = bucket();
    // Exhaust id "a".
    rateLimit(name, "a", 1, 60_000);
    expect(() => rateLimit(name, "a", 1, 60_000)).toThrowError(
      expect.objectContaining({ status: 429 }),
    );
    // id "b" in the same bucket is unaffected.
    expect(() => rateLimit(name, "b", 1, 60_000)).not.toThrow();
  });

  it("different bucket names are independent for the same id", () => {
    const a = bucket();
    const b = bucket();
    const id = "shared-id";
    rateLimit(a, id, 1, 60_000);
    expect(() => rateLimit(a, id, 1, 60_000)).toThrowError(
      expect.objectContaining({ status: 429 }),
    );
    // Same id, different bucket → fresh window.
    expect(() => rateLimit(b, id, 1, 60_000)).not.toThrow();
  });

  it("resets after the window elapses (real timers, tiny window)", async () => {
    const name = bucket();
    const id = "id-reset";
    rateLimit(name, id, 1, 30);
    expect(() => rateLimit(name, id, 1, 30)).toThrowError(
      expect.objectContaining({ status: 429 }),
    );
    // Cross the window boundary.
    await new Promise((r) => setTimeout(r, 40));
    // Window reset → calls are allowed again.
    expect(() => rateLimit(name, id, 1, 30)).not.toThrow();
  });

  it("resets after the window elapses (fake timers)", () => {
    vi.useFakeTimers();
    const name = bucket();
    const id = "id-fake";
    rateLimit(name, id, 2, 1000);
    rateLimit(name, id, 2, 1000);
    expect(() => rateLimit(name, id, 2, 1000)).toThrowError(
      expect.objectContaining({ status: 429 }),
    );
    // Advance past the window.
    vi.advanceTimersByTime(1001);
    // Fresh window: limit applies anew.
    expect(() => rateLimit(name, id, 2, 1000)).not.toThrow();
    expect(() => rateLimit(name, id, 2, 1000)).not.toThrow();
    expect(() => rateLimit(name, id, 2, 1000)).toThrowError(
      expect.objectContaining({ status: 429 }),
    );
  });

  it("does not reset before the window elapses (fake timers, boundary)", () => {
    vi.useFakeTimers();
    const name = bucket();
    const id = "id-boundary";
    rateLimit(name, id, 1, 1000);
    // Advance to just before the reset (resetAt = now + windowMs is exclusive boundary; now < resetAt).
    vi.advanceTimersByTime(999);
    expect(() => rateLimit(name, id, 1, 1000)).toThrowError(
      expect.objectContaining({ status: 429 }),
    );
  });

  it("the 429 message includes a retry-after hint in seconds", () => {
    const name = bucket();
    const id = "id-msg";
    rateLimit(name, id, 1, 5000);
    let thrown: unknown;
    try {
      rateLimit(name, id, 1, 5000);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toMatchObject({
      status: 429,
      body: { message: expect.stringMatching(/Try again in \d+s\./) },
    });
  });
});

describe("clientIp", () => {
  it("returns the LAST (proxy-appended) X-Forwarded-For hop — leftmost hops are spoofable", () => {
    const event = makeEvent({ headers: { "x-forwarded-for": "1.2.3.4, 5.6.7.8" } });
    expect(clientIp(event)).toBe("5.6.7.8");
  });

  it("trims whitespace around the last hop", () => {
    const event = makeEvent({ headers: { "x-forwarded-for": "  9.9.9.9 ,  8.8.8.8" } });
    expect(clientIp(event)).toBe("8.8.8.8");
  });

  it("handles a single-hop X-Forwarded-For", () => {
    const event = makeEvent({ headers: { "x-forwarded-for": "10.0.0.1" } });
    expect(clientIp(event)).toBe("10.0.0.1");
  });

  it("falls back to getClientAddress() when no X-Forwarded-For", () => {
    const event = makeEvent({ clientIp: "203.0.113.7" });
    expect(clientIp(event)).toBe("203.0.113.7");
  });

  it("falls back to 'unknown' when getClientAddress() throws", () => {
    const event = makeEvent();
    // Force the socket-address lookup to fail (no XFF header present).
    (event as unknown as { getClientAddress: () => string }).getClientAddress = () => {
      throw new Error("no address");
    };
    expect(clientIp(event)).toBe("unknown");
  });
});
