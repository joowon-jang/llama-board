# Security Policy

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability. Report it
privately through the repository's GitHub security advisory flow or contact the
maintainer listed in the repository profile with a minimal reproduction.

Do not include API keys, tokens, passwords, model credentials, or other secrets
in a report. Replace them with `[REDACTED]`.

## Scope

Reports involving runtime archive verification, archive path traversal,
process lifecycle, local endpoint exposure, installer integrity, and Tauri
capabilities are in scope.

## Local authentication boundary

The app binds the managed server to loopback and creates a new bearer key for
each server start. The upstream `llama-server` interface currently receives
that key through its command-line API-key option, so another process running as
the same Windows user may be able to observe the key through process
inspection. The key is not intended to protect against same-user local
inspection; it protects the loopback endpoint from unrelated local clients and
is cleared when the server stops. Do not share the local endpoint or key with
other users or applications.

## Supported versions

The latest release and the default branch receive security fixes. Older
releases may require upgrading before a fix is available.
