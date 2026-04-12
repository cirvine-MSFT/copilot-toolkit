# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in this project, please report it responsibly.

**Do not open a public issue.**

Instead, please email [cirvine-msft](https://github.com/cirvine-msft) directly or use GitHub's [private vulnerability reporting](https://github.com/cirvine-msft/copilot-toolkit/security/advisories/new).

I'll acknowledge receipt within 48 hours and aim to provide a fix or mitigation plan within 7 days.

## Scope

This project contains GitHub Copilot CLI extensions that interact with Azure DevOps APIs via the Azure CLI. Security concerns might include:

- Credential or token exposure in extension code
- Unsafe handling of API responses
- Path traversal or injection in shell command parsing

## Supported Versions

Only the latest version on `main` is supported.
