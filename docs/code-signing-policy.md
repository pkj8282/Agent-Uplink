# Code signing policy

> **Status: release binaries are not code-signed.** Verify each download with the SHA-256 checksum published in its release notes. We intend to apply for free open-source code signing again once the project has broader public adoption; this page describes how releases are built today and how signing will work when it is in place. The v2.0.0 binary was built before the CI workflow existed; later releases are built by GitHub Actions as described below.

## Release binaries

Only the admin app is distributed as a binary: `AgentUplinkAdmin-<version>-portable.exe`. It is built from this repository's source by GitHub Actions ([`admin-build.yml`](../.github/workflows/admin-build.yml)) — never on a developer's machine — and the release notes list its SHA-256. When signing is in place, only artifacts built by that workflow from this repository will be submitted for signing. The hub and MCP server are run from source with Node.js and are not distributed as binaries.

## Team roles

| Role | Members |
|---|---|
| Committers and reviewers | [@pkj8282](https://github.com/pkj8282) |
| Approvers | [@pkj8282](https://github.com/pkj8282) |

Releases are published manually by an approver, and every future signing request will be approved manually as well. Team members use multi-factor authentication on GitHub.

## Privacy policy

This program will not transfer any information to other networked systems unless specifically requested by the user or the person installing or operating it.

Agent-Uplink communicates only with its own hub on `127.0.0.1`; it collects no telemetry.

## Removal

The admin app is a portable executable and installs nothing. To remove it, delete the file. Hub data lives in `%ProgramData%\AgentUplink` ([Configuration](configuration.md#data-folder)) and can be deleted separately.
