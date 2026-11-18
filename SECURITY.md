# Security

## Reporting a vulnerability

Please report it privately, not in a public issue: open the repository's **Security** tab and choose
**Report a vulnerability**. You will get a reply within a few working days.

Useful to include: the version, what an attacker can do, and the smallest example that shows it.

## What is in scope

This package holds your platform and gateway credentials in memory, sends prompts and traces to
the services you configure, and (`tas studio`) runs a local web server that can write prompt files.
Anything that leaks credentials, sends data somewhere you did not configure, defeats masking, or
lets a web page or another machine reach the studio server is a vulnerability.

## How releases are protected

- Releases are built by a GitHub Actions workflow from `main` and submitted to npm without any
  stored token (npm trusted publishing). A maintainer approves each one on npm with 2FA.
- Two runtime dependencies (`typebox`, `yaml`). Vendor APIs are called with `fetch`.
- Workflows on pull requests from outside contributors run only after a maintainer approves them,
  with a read-only token and no secrets.
