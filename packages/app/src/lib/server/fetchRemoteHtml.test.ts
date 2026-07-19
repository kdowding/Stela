import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { fetchRemoteHtml, isBlockedIp } from "./fetchRemoteHtml";

describe("isBlockedIp", () => {
  it("blocks private / loopback / link-local / reserved IPv4", () => {
    for (const ip of [
      "0.0.0.0",
      "10.0.0.1",
      "10.255.255.255",
      "127.0.0.1",
      "169.254.169.254", // Azure IMDS
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "192.0.0.1",
      "192.0.2.1", // TEST-NET-1
      "192.88.99.1", // deprecated 6to4 anycast
      "198.18.0.1", // benchmarking
      "198.51.100.1", // TEST-NET-2
      "203.0.113.1", // TEST-NET-3
      "100.64.0.1",
      "224.0.0.1",
      "255.255.255.255",
    ])
      expect(isBlockedIp(ip), ip).toBe(true);
  });

  it("allows routable public IPv4 (incl. just outside the private ranges)", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "142.250.72.14", "172.15.255.255", "172.32.0.1", "100.63.255.255"])
      expect(isBlockedIp(ip), ip).toBe(false);
  });

  it("blocks loopback / ULA / link-local / multicast / IPv4-mapped IPv6", () => {
    for (const ip of [
      "::1",
      "::",
      "fc00::1",
      "fd12:3456::1",
      "fe80::1",
      "ff02::1",
      "::ffff:169.254.169.254", // IPv4-mapped IMDS
      "::ffff:10.0.0.1",
      "64:ff9b::a9fe:a9fe", // NAT64-wrapped IMDS (a9fe:a9fe = 169.254.169.254)
      "::a9fe:a9fe", // IPv4-compatible IMDS
      "2002:a9fe:a9fe::1", // 6to4-wrapped IMDS
    ])
      expect(isBlockedIp(ip), ip).toBe(true);
  });

  it("allows public IPv6 (incl. 6to4 wrapping a public v4)", () => {
    for (const ip of ["2606:4700:4700::1111", "2001:4860:4860::8888", "2002:808:808::1"])
      expect(isBlockedIp(ip), ip).toBe(false);
  });

  it("fails closed on non-IP input", () => {
    expect(isBlockedIp("not-an-ip")).toBe(true);
  });
});

describe("fetchRemoteHtml — request guards", () => {
  it("rejects a non-https URL", async () => {
    const r = await fetchRemoteHtml("http://example.com/a.html");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/https/i);
  });

  it("rejects credentials embedded in the URL", async () => {
    const r = await fetchRemoteHtml("https://user:pass@example.com/a.html");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/credential/i);
  });

  it("refuses a host that resolves to a private address", async () => {
    const r = await fetchRemoteHtml("https://sneaky.example/a.html", {
      allowedHosts: [],
      resolve: async () => ["10.0.0.5"],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/non-public/i);
  });

  it("refuses a host that isn't on the default allowlist (claudeusercontent.com)", async () => {
    const r = await fetchRemoteHtml("https://evil.example/a.html", { resolve: async () => ["8.8.8.8"] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/allowlist/i);
  });

  it("allows the Claude Design asset domain by default (then still IP-checks)", async () => {
    const r = await fetchRemoteHtml("https://abc.claudeusercontent.com/a.html", {
      resolve: async () => ["10.0.0.1"], // private → proves we passed the allowlist and hit the IP guard
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/non-public/i);
  });

  it("rejects a non-default https port", async () => {
    const r = await fetchRemoteHtml("https://abc.claudeusercontent.com:8443/a.html", {
      resolve: async () => ["8.8.8.8"],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/port/i);
  });

  it("refuses a host that is off a non-empty allowlist", async () => {
    const r = await fetchRemoteHtml("https://evil.example/a.html", {
      allowedHosts: ["assets.claude.ai"],
      resolve: async () => ["8.8.8.8"],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/allowlist/i);
  });

  it("passes the allowlist on a subdomain match (then still IP-checks)", async () => {
    const r = await fetchRemoteHtml("https://cdn.assets.claude.ai/a.html", {
      allowedHosts: ["assets.claude.ai"],
      resolve: async () => ["10.0.0.1"], // blocked → proves we got PAST the allowlist to the IP guard
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/non-public/i);
  });
});

describe("fetchRemoteHtml — transport (local server via allowInsecure)", () => {
  let server: http.Server;
  let base: string;
  // A NAME host (not 127.0.0.1) so Node actually invokes the pinned lookup — a literal-IP host skips
  // lookup entirely, which previously hid the autoSelectFamily lookup bug. resolve pins it to loopback;
  // allowedHosts:[] bypasses the production allowlist so we exercise transport in isolation.
  const local = {
    allowInsecure: true,
    allowedHosts: [] as string[],
    resolve: async () => ["127.0.0.1"],
    isBlockedIp: () => false,
  };

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url === "/ok") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<h1>HELLO</h1>");
      } else if (req.url === "/redirect") {
        res.writeHead(302, { location: "/ok" });
        res.end();
      } else if (req.url === "/big") {
        res.writeHead(200);
        res.end("x".repeat(5000));
      } else if (req.url === "/hang") {
        // never respond — exercises the idle timeout
      } else if (req.url === "/trickle") {
        // drip a byte every 120ms: under any idle timeout, but the absolute deadline must still fire
        res.writeHead(200);
        let n = 0;
        const t = setInterval(() => {
          if (n++ < 30) res.write("x");
          else {
            clearInterval(t);
            res.end();
          }
        }, 120);
        res.on("close", () => clearInterval(t));
      } else {
        res.writeHead(404);
        res.end("no");
      }
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    base = `http://stela.test:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it("fetches a 200 body", async () => {
    const r = await fetchRemoteHtml(`${base}/ok`, local);
    expect(r).toEqual({ ok: true, html: "<h1>HELLO</h1>" });
  });

  it("does NOT follow a redirect", async () => {
    const r = await fetchRemoteHtml(`${base}/redirect`, local);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/redirect/i);
  });

  it("rejects a non-200 status", async () => {
    const r = await fetchRemoteHtml(`${base}/missing`, local);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/HTTP 404/);
  });

  it("enforces the byte cap", async () => {
    const r = await fetchRemoteHtml(`${base}/big`, { ...local, maxBytes: 100 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/exceeds/i);
  });

  it("times out a hung response", async () => {
    const r = await fetchRemoteHtml(`${base}/hang`, { ...local, timeoutMs: 250 });
    expect(r.ok).toBe(false);
    // A silent connection trips both the idle timeout and the absolute deadline at ~250ms (a race);
    // either is a correct "it timed out" outcome.
    if (!r.ok) expect(r.error).toMatch(/deadline|timed out/i);
  });

  it("enforces an absolute deadline against a slow trickle (an idle timeout would not fire)", async () => {
    const r = await fetchRemoteHtml(`${base}/trickle`, { ...local, timeoutMs: 300 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/deadline|timed out/i);
  });
});
