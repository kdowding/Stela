import { describe, it, expect, vi } from "vitest";
import { emitNotification, subscribeNotifications } from "./notificationBus";

// the recipient-scoped pub/sub the notification SSE stream rides on had no coverage. Mirrors
// revisionBus.test.ts (pure in-memory).
describe("notificationBus", () => {
  it("delivers only to the named recipient", () => {
    const a = vi.fn();
    const b = vi.fn();
    const ua = subscribeNotifications("user-a", a);
    const ub = subscribeNotifications("user-b", b);
    emitNotification(["user-a"]);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).not.toHaveBeenCalled();
    ua();
    ub();
  });

  it("fires a recipient's listener once even when listed twice in one emit (dedup)", () => {
    const cb = vi.fn();
    const u = subscribeNotifications("user-dup", cb);
    emitNotification(["user-dup", "user-dup"]);
    expect(cb).toHaveBeenCalledTimes(1);
    u();
  });

  it("fans out to multiple listeners on one recipient", () => {
    const c1 = vi.fn();
    const c2 = vi.fn();
    const u1 = subscribeNotifications("user-multi", c1);
    const u2 = subscribeNotifications("user-multi", c2);
    emitNotification(["user-multi"]);
    expect(c1).toHaveBeenCalledTimes(1);
    expect(c2).toHaveBeenCalledTimes(1);
    u1();
    u2();
  });

  it("isolates one throwing listener from the rest", () => {
    const bad = vi.fn(() => {
      throw new Error("boom");
    });
    const good = vi.fn();
    const u1 = subscribeNotifications("user-throw", bad);
    const u2 = subscribeNotifications("user-throw", good);
    expect(() => emitNotification(["user-throw"])).not.toThrow();
    expect(good).toHaveBeenCalledTimes(1);
    u1();
    u2();
  });

  it("stops delivering after unsubscribe (and reaps the now-empty channel)", () => {
    const cb = vi.fn();
    const u = subscribeNotifications("user-reap", cb);
    emitNotification(["user-reap"]);
    u();
    emitNotification(["user-reap"]);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("emitting to a recipient with no subscribers is a no-op", () => {
    expect(() => emitNotification(["nobody"])).not.toThrow();
  });
});
