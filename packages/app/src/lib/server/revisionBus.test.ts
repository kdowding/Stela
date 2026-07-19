import { describe, it, expect, vi } from "vitest";
import { emitVersion, subscribeVersion } from "./revisionBus";

describe("revisionBus", () => {
  it("delivers version bumps only to subscribers of that artifact", () => {
    const a = vi.fn();
    const b = vi.fn();
    const unsubA = subscribeVersion("art-1", a);
    const unsubB = subscribeVersion("art-2", b);

    emitVersion("art-1", 2);
    expect(a).toHaveBeenCalledWith(2);
    expect(b).not.toHaveBeenCalled();

    unsubA();
    unsubB();
  });

  it("stops delivering after unsubscribe", () => {
    const cb = vi.fn();
    const unsub = subscribeVersion("art-x", cb);
    emitVersion("art-x", 1);
    unsub();
    emitVersion("art-x", 2);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith(1);
  });

  it("fans out to multiple subscribers on one artifact", () => {
    const c1 = vi.fn();
    const c2 = vi.fn();
    const u1 = subscribeVersion("art-multi", c1);
    const u2 = subscribeVersion("art-multi", c2);
    emitVersion("art-multi", 5);
    expect(c1).toHaveBeenCalledWith(5);
    expect(c2).toHaveBeenCalledWith(5);
    u1();
    u2();
  });

  it("emitting with no subscribers is a no-op", () => {
    expect(() => emitVersion("nobody", 9)).not.toThrow();
  });

  it("isolates one listener throwing from the rest", () => {
    const bad = vi.fn(() => {
      throw new Error("boom");
    });
    const good = vi.fn();
    const u1 = subscribeVersion("art-throw", bad);
    const u2 = subscribeVersion("art-throw", good);
    expect(() => emitVersion("art-throw", 3)).not.toThrow();
    expect(good).toHaveBeenCalledWith(3);
    u1();
    u2();
  });
});
