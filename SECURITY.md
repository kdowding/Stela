# Security policy

## Reporting

Please report suspected vulnerabilities privately via
[GitHub Security Advisories](../../security/advisories/new) rather than public issues.
You'll get a response as quickly as a one-maintainer project allows.

## The model, in brief

Stela intentionally has **no account system**. An identity-aware proxy in front of the app
authenticates users and injects trusted identity headers; Stela does authorization only.
The implications:

- The app's port must **never** be reachable except through the proxy — with header-trust
  enabled, network access equals identity. Production refuses to boot without `AUTH_MODE`
  configured and logs which headers it trusts.
- Artifact HTML is treated as hostile: rendered in an opaque-origin sandboxed iframe under
  a `default-src 'none'` CSP (no network egress), never same-origin with the portal.
- The only outbound request the server makes is `fileUrl` ingest, which is SSRF-hardened
  (https-only, DNS-pinned, private ranges blocked, redirects refused, size/time capped,
  host allowlisted).
- API credentials (admin key, per-user tokens, OAuth tokens) are stored as SHA-256 hashes;
  single-use codes are PKCE-bound.

Findings that assume a deployment where the app port is directly exposed are configuration
issues, not vulnerabilities — but reports about making misconfiguration harder are welcome.
