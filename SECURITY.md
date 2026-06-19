# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in this project, please report it responsibly.

**Do not open a public issue.**

Instead, use GitHub's [private vulnerability reporting](https://github.com/cirvine-msft/copilot-toolkit/security/advisories/new) to submit a report. I'll acknowledge receipt within 48 hours and aim to provide a fix or mitigation plan within 7 days.

## Scope

This project contains GitHub Copilot CLI extensions that interact with Azure DevOps APIs via the Azure CLI. Security concerns might include:

- Credential or token exposure in extension code
- Unsafe handling of API responses
- Path traversal or injection in shell command parsing

## Security Automation

This repo uses:

- Dependabot for GitHub Actions and the Excalidraw Workbench webview npm package
- Dependency Review on pull requests, failing vulnerable dependency changes at moderate severity or higher
- CodeQL JavaScript analysis on pushes, pull requests, and a weekly schedule

## Supported Versions

Only the latest version on `main` is supported.
