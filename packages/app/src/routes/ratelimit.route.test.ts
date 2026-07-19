import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { GET as authorize } from "./cli/authorize/+server";
import { makeEvent, testUser } from "../test/helpers";

const uid = (p: string) => `${p}-${randomBytes(4).toString("hex")}`;

// tests-4: assert the limiter actually fires at the route level (the unit tests cover the limiter
// itself). A unique user id keeps the module-level limiter Map isolated from other tests.
describe("route rate limiting", () => {
  it("/cli/authorize -> 429 after exceeding 30 calls/min for one user id", async () => {
    const user = testUser({ id: uid("rl-auth") });
    const challenge = "a".repeat(43);
    const call = () =>
      authorize(
        makeEvent({
          path: "/cli/authorize",
          query: { port: "51999", state: "teststate1234", code_challenge: challenge },
          locals: { user },
        }),
      );
    let got429 = false;
    let ok = 0;
    for (let i = 0; i < 35; i++) {
      try {
        await call();
        ok++;
      } catch (e) {
        if ((e as { status?: number })?.status === 429) {
          got429 = true;
          break;
        }
        throw e;
      }
    }
    expect(ok).toBe(30); // exactly the limit succeed
    expect(got429).toBe(true); // then it blocks
  });
});
