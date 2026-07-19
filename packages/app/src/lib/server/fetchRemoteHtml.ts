import https from "node:https";
import http from "node:http";
import { isIP, type LookupFunction } from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";

/**
 * Fetch an artifact's HTML from a short-lived, model-supplied URL (the Claude Design "mint a public
 * file URL" hand-off), so the model never has to transcribe hundreds of KB of base64 into a tool call.
 *
 * This is the ONLY place Stela makes an outbound request, so it is hardened against SSRF — a
 * model-supplied URL could otherwise be aimed at cloud metadata (169.254.169.254 → managed-identity
 * token) or internal services:
 *   • https only (http allowed ONLY under the test-only allowInsecure flag); no credentials in the URL
 *   • resolve DNS ourselves and reject if ANY address is private / loopback / link-local / reserved
 *   • PIN the connection to the validated IP via a custom lookup, so the name can't re-resolve to a
 *     private address between check and connect (DNS rebinding); TLS still validates against the host
 *   • no redirect following, a hard byte cap, and a connect/read timeout
 *   • optional host allowlist (populate ALLOWED_HOSTS once the Design asset domain is known)
 *
 * The IP classifier and the resolver are injectable so each guard — and the transport itself — is
 * unit-testable without real network access.
 */

const MAX_BYTES = 10_000_000; // 10 MB — mirrors the publish HTML cap
const TIMEOUT_MS = 10_000;

// The Claude Design "mint a public file URL" host is <projectId>.claudeusercontent.com on a shared
// parent. We pin the registrable domain (defence-in-depth on top of the IP checks): fileUrl can ONLY
// fetch from there, so a literal-IP or alternate-encoding host can never match this suffix. Add hosts
// here to allow other sources; an empty array would mean "any public host" (still IP-filtered).
const ALLOWED_HOSTS: string[] = ["claudeusercontent.com"];

export type FetchResult = { ok: true; html: string } | { ok: false; error: string };

export interface FetchRemoteOpts {
  maxBytes?: number;
  timeoutMs?: number;
  allowedHosts?: string[];
  /** Resolve a hostname to its IP addresses. Default: DNS A/AAAA lookup (all records). */
  resolve?: (hostname: string) => Promise<string[]>;
  /** Classify an IP as non-public. Default: {@link isBlockedIp}. */
  isBlockedIp?: (ip: string) => boolean;
  /** TEST ONLY: permit http:// (so a local mock server can exercise the real transport). */
  allowInsecure?: boolean;
}

const err = (error: string): FetchResult => ({ ok: false, error });

// ---------------------------------------------------------------------------
// IP classification (exported for exhaustive unit testing)
// ---------------------------------------------------------------------------

function ipv4Blocked(a: number, b: number, c: number, _d: number): boolean {
  if (a === 0) return true; //            0.0.0.0/8     "this" network
  if (a === 10) return true; //           10/8          private
  if (a === 127) return true; //          127/8         loopback
  if (a === 169 && b === 254) return true; // 169.254/16 link-local (incl. Azure IMDS 169.254.169.254)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12 private
  if (a === 192 && b === 168) return true; // 192.168/16 private
  if (a === 192 && b === 0 && c === 0) return true; // 192.0.0/24   IETF protocol assignments
  if (a === 192 && b === 0 && c === 2) return true; // 192.0.2/24   TEST-NET-1
  if (a === 192 && b === 88 && c === 99) return true; // 192.88.99/24 deprecated 6to4 anycast
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18/15 benchmarking
  if (a === 198 && b === 51 && c === 100) return true; // 198.51.100/24 TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // 203.0.113/24  TEST-NET-3
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT
  if (a >= 224) return true; //           224/4 multicast + 240/4 reserved + 255.255.255.255
  return false;
}

/** Expand any valid IPv6 string to its 8 16-bit groups, resolving `::` and embedded IPv4. */
function expandIPv6(addr: string): number[] | null {
  let s = addr.replace(/^\[|\]$/g, "").replace(/%.*$/, ""); // drop brackets + zone id
  const v4 = s.match(/^(.*:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (v4) {
    const p = v4[2].split(".").map(Number);
    if (p.some((n) => Number.isNaN(n) || n > 255)) return null;
    s = v4[1] + (((p[0] << 8) | p[1]) >>> 0).toString(16) + ":" + (((p[2] << 8) | p[3]) >>> 0).toString(16);
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = 8 - head.length - tail.length;
  if (halves.length === 1 ? head.length !== 8 : fill < 0) return null;
  const groups = [...head, ...Array(halves.length === 2 ? fill : 0).fill("0"), ...tail];
  if (groups.length !== 8) return null;
  const nums = groups.map((g) => (g === "" ? 0 : parseInt(g, 16)));
  if (nums.some((n) => Number.isNaN(n) || n < 0 || n > 0xffff)) return null;
  return nums;
}

const embeddedV4Blocked = (hi: number, lo: number): boolean =>
  ipv4Blocked(hi >> 8, hi & 0xff, lo >> 8, lo & 0xff);

function ipv6Blocked(addr: string): boolean {
  const g = expandIPv6(addr);
  if (!g) return true; // unparseable → fail closed
  // Any address that embeds an IPv4 → classify the embedded IPv4, so a private/IMDS target can't hide
  // behind an IPv6 wrapper that infrastructure may translate back to v4. Covers ::ffff:0:0/96 (mapped),
  // ::/96 (compatible, incl. :: and ::1), 64:ff9b::/96 (NAT64), and 2002::/16 (6to4).
  const topZero = g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0;
  if (topZero && (g[5] === 0xffff || g[5] === 0)) return embeddedV4Blocked(g[6], g[7]); // ::ffff: / ::-compat
  if (g[0] === 0x0064 && g[1] === 0xff9b && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0) {
    return embeddedV4Blocked(g[6], g[7]); // NAT64 64:ff9b::/96
  }
  if (g[0] === 0x2002) return embeddedV4Blocked(g[1], g[2]); // 6to4 2002::/16
  if (g[0] >= 0xfc00 && g[0] <= 0xfdff) return true; // fc00::/7 unique-local
  if (g[0] >= 0xfe80 && g[0] <= 0xfebf) return true; // fe80::/10 link-local
  if (g[0] >= 0xff00) return true; // ff00::/8 multicast
  return false;
}

/** True if `ip` is anything other than a routable public address (so we must refuse to fetch it). */
export function isBlockedIp(ip: string): boolean {
  const fam = isIP(ip);
  if (fam === 4) {
    const o = ip.split(".").map(Number);
    if (o.length !== 4 || o.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true;
    return ipv4Blocked(o[0], o[1], o[2], o[3]);
  }
  if (fam === 6) return ipv6Blocked(ip);
  return true; // not an IP at all → fail closed
}

async function defaultResolve(hostname: string): Promise<string[]> {
  const recs = await dnsLookup(hostname, { all: true });
  return recs.map((r) => r.address);
}

// ---------------------------------------------------------------------------
// The hardened fetch
// ---------------------------------------------------------------------------

export async function fetchRemoteHtml(rawUrl: string, opts: FetchRemoteOpts = {}): Promise<FetchResult> {
  const maxBytes = opts.maxBytes ?? MAX_BYTES;
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
  const allowedHosts = opts.allowedHosts ?? ALLOWED_HOSTS;
  const resolve = opts.resolve ?? defaultResolve;
  const blocked = opts.isBlockedIp ?? isBlockedIp;

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return err(`'${rawUrl}' is not a valid URL.`);
  }

  const isHttps = url.protocol === "https:";
  if (!isHttps && !(opts.allowInsecure && url.protocol === "http:")) {
    return err("fileUrl must be an https:// URL.");
  }
  if (url.username || url.password) return err("fileUrl must not contain credentials.");
  // Default https port only. The allowlist/IP guard validate host + IP, not port, so without this a
  // non-standard port on an allowed public host would be reachable. Gate on https so the test-only
  // allowInsecure path keeps using ephemeral local ports.
  if (isHttps && url.port && Number(url.port) !== 443) {
    return err("fileUrl must use the default https port (443).");
  }

  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (allowedHosts.length && !allowedHosts.some((h) => host === h || host.endsWith("." + h))) {
    return err(`fileUrl host '${host}' is not on the allowlist.`);
  }

  let addrs: string[];
  try {
    addrs = await resolve(host);
  } catch {
    return err(`Could not resolve '${host}'.`);
  }
  if (!addrs.length) return err(`Could not resolve '${host}'.`);
  // Reject if ANY resolved address is non-public — don't cherry-pick a public one from a mixed set.
  const badIp = addrs.find((a) => blocked(a));
  if (badIp) {
    // Log the offending IP server-side, but don't echo it to the caller — gratuitous info disclosure,
    // and a resolve oracle if the host allowlist is ever relaxed to user-controllable hosts.
    console.error(`Stela: refusing fileUrl for ${host} — resolved to non-public address ${badIp}`);
    return err("fileUrl resolves to a non-public address; refusing to fetch.");
  }
  const pinnedIp = addrs[0];

  const lib = isHttps ? https : http;
  const port = url.port ? Number(url.port) : isHttps ? 443 : 80;
  // Pin the socket to the already-validated IP so the agent can't re-resolve to a private address
  // (DNS rebinding). TLS SNI/cert validation still uses the hostname via `servername`.
  const fam = isIP(pinnedIp) || 4;
  // autoSelectFamily (default-on in Node 20+) invokes lookup with { all: true } and expects an ARRAY of
  // {address, family}; the positional (address, family) form arrives as `undefined` → ERR_INVALID_IP_ADDRESS
  // and the connection fails. Support both shapes so pinning works whether or not happy-eyeballs is active.
  const pinnedLookup = ((
    _hostname: string,
    options: { all?: boolean } | undefined,
    cb: (
      err: NodeJS.ErrnoException | null,
      address: string | { address: string; family: number }[],
      family?: number,
    ) => void,
  ) => (options?.all ? cb(null, [{ address: pinnedIp, family: fam }]) : cb(null, pinnedIp, fam))) as unknown as LookupFunction;

  return await new Promise<FetchResult>((settle) => {
    let done = false;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const finish = (r: FetchResult) => {
      if (!done) {
        done = true;
        clearTimeout(deadline);
        settle(r);
      }
    };

    const req = lib.request(
      {
        protocol: url.protocol,
        host,
        servername: isHttps ? host : undefined,
        port,
        path: url.pathname + url.search,
        method: "GET",
        lookup: pinnedLookup,
        headers: { accept: "text/html,*/*", "user-agent": "Stela-Ingest/1" },
        timeout: timeoutMs,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          res.destroy();
          req.destroy();
          return finish(err(`fileUrl redirected (HTTP ${status}); provide a direct link.`));
        }
        if (status !== 200) {
          res.destroy();
          req.destroy();
          return finish(err(`fileUrl returned HTTP ${status}.`));
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (c: Buffer) => {
          size += c.length;
          if (size > maxBytes) {
            res.destroy();
            req.destroy();
            finish(err(`fileUrl body exceeds the ${Math.round(maxBytes / 1e6)} MB limit.`));
          } else {
            chunks.push(c);
          }
        });
        res.on("end", () => finish({ ok: true, html: Buffer.concat(chunks).toString("utf8") }));
        res.on("error", () => finish(err("Error reading the fileUrl response.")));
      },
    );
    // Absolute deadline. The socket `timeout` is only an IDLE timeout, so a slow-trickle endpoint
    // (a byte just under timeoutMs apart) could otherwise pin the socket open indefinitely; this caps
    // total wall-clock regardless of incremental data.
    deadline = setTimeout(() => {
      req.destroy();
      finish(err(`fileUrl exceeded the ${timeoutMs} ms deadline.`));
    }, timeoutMs);
    req.on("timeout", () => {
      req.destroy();
      finish(err(`fileUrl timed out after ${timeoutMs} ms.`));
    });
    req.on("error", () => finish(err("Could not fetch fileUrl.")));
    req.end();
  });
}
