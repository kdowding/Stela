import { describe, it, expect } from "vitest";
import { extractTitle } from "@stela/shared";

describe("extractTitle", () => {
  it("pulls the title text", () => {
    expect(extractTitle("<!doctype html><title>My Dashboard</title>")).toBe("My Dashboard");
  });

  it("is case-insensitive and ignores attributes", () => {
    expect(extractTitle('<TITLE data-x="1">Hi</TITLE>')).toBe("Hi");
  });

  it("collapses internal whitespace and newlines", () => {
    expect(extractTitle("<title>  Sales\n   Report </title>")).toBe("Sales Report");
  });

  it("decodes the common entities a title might contain", () => {
    expect(extractTitle("<title>Q1 &amp; Q2 &#8212; &#x2713;</title>")).toBe("Q1 & Q2 — ✓");
  });

  it("leaves unknown entities intact", () => {
    expect(extractTitle("<title>&bogus;</title>")).toBe("&bogus;");
  });

  it("returns null when there is no title or it is empty", () => {
    expect(extractTitle("<p>no title here</p>")).toBeNull();
    expect(extractTitle("<title>   </title>")).toBeNull();
  });

  it("takes the first title when there are several", () => {
    expect(extractTitle("<title>First</title><title>Second</title>")).toBe("First");
  });

  it("caps an over-long title at 300 chars (the stored-title contract)", () => {
    expect(extractTitle(`<title>${"x".repeat(500)}</title>`)).toHaveLength(300);
  });
});
