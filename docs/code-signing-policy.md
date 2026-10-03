# Code signing policy

Free code signing provided by [SignPath.io](https://about.signpath.io/), certificate by [SignPath Foundation](https://signpath.org/).

> Status: the application to SignPath Foundation is in progress. Until it is approved, release binaries are **unsigned**; verify them with the SHA-256 checksum published in each release's notes. The v2.0.0 binary was built before the CI workflow existed; later releases are built by GitHub Actions as described below.

## What is signed

Only the admin app release binary, `AgentUplinkAdmin-<version>-portable.exe`. It is built from this repository's source by GitHub Actions ([`admin-build.yml`](../.github/workflows/admin-build.yml)) — never on a developer's machine — and only artifacts built from this repository are submitted for signing. The hub and MCP server are run from source with Node.js and are not distributed as binaries.

## Team roles

| Role | Members |
|---|---|
| Committers and reviewers | [@pkj8282](https://github.com/pkj8282) |
| Approvers | [@pkj8282](https://github.com/pkj8282) |

Every signing request is approved manually by an approver. Team members use multi-factor authentication for both GitHub and SignPath.

## Privacy policy

This program will not transfer any information to other networked systems unless specifically requested by the user or the person installing or operating it.

Agent-Uplink communicates only with its own hub on `127.0.0.1`; it collects no telemetry.

## Removal

The admin app is a portable executable and installs nothing. To remove it, delete the file. Hub data lives in `%ProgramData%\AgentUplink` ([Configuration](configuration.md#data-folder)) and can be deleted separately.
