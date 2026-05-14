# Security Policy

## Supported Versions

The latest tagged release is supported. Earlier versions receive only security
fixes that backport cleanly.

## Reporting a Vulnerability

Please do **not** open a public GitHub issue for security vulnerabilities.

Instead, email the maintainers with:
- a description of the issue
- minimum reproducer
- impact assessment
- your contact for follow-up

You will receive an acknowledgement within 72 hours and a planned-fix timeline
within 7 days. If the issue is high-severity (RCE, auth bypass, data leak), the
maintainers will coordinate a private fix and a coordinated public disclosure.

## Threat Model

The gateway routes prompts that may contain proprietary data to multiple LLM
providers. The most sensitive failure modes are:

1. **Prompt-injection bypass** — the pre-classifier or post-validator misses
   injection attempts and leaks system prompts or tool definitions.
2. **Audit-log corruption** — calls succeed but compression / cost metadata is
   wrong, so cost tracking lies.
3. **Bridge auth leakage** — a subscription bridge somehow exposes its OAuth
   token or session cookie via the audit log or response.
4. **Dashboard auth bypass** — endpoints under `/api/dashboard/*` serve real
   user data; the `DASHBOARD_AUTH_TOKEN` check must not be bypassable.
5. **Build-drift exploit** — running stale compiled code could re-introduce a
   previously-fixed vulnerability. The launch-time `check-build-drift.mjs`
   guard addresses this; if you find a way around it, please report it.

## Out of Scope

- Issues affecting only out-of-band external services (Anthropic API, OpenAI
  API) that the gateway proxies to but doesn't control.
- Social-engineering attacks on subscription accounts.
- Self-imposed loss of subscription quotas by misrouting.
