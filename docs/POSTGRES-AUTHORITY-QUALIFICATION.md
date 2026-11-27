# PostgreSQL authority integration contract

This candidate joins the explicit authority schema builder with the asynchronous
session and account repositories. It does not change the selected runtime engine,
wire HTTP handlers, copy production data, or claim a complete application migration.

`tools/test-authority-session-postgres.mjs` runs only with an explicitly supplied
disposable database URL and a separate matching database name. It requires an
isolated Unix socket, actual PostgreSQL 19, a fresh database with no application
relations, and the independent fixture marker expected by the test. The caller
owns the container, resource limits, durable execution, logs and final cleanup.
There is no fallback to an ambient application connection.

The contract runs the schema builder's 36 SQL cases, then all 61 shared session
and authority cases against that same created, populated and activated schema.
It does not substitute the shared contract's simplified fixture DDL. Three
integration cases check independent business-schema ownership, positive and
negative reader/writer password authentication, and preservation of the original
data generation. The four schema-builder checks are reported separately because
they do not execute SQL.

The two repository instances use the restricted writer role and the transport's
same dedicated-client transaction lock. Concurrent logout, expiry, active/role,
password, scope, profile and assignment changes therefore exercise the same
authorization boundary as imports. The read role's SQL grants and both roles'
password rejection are tested independently.

Every role, schema and row is fictional. The fixture removes only its generated
roles and schemas, verifies their absence, and closes both repository instances
and its bootstrap connection. It reports a failure when setup, a case, cleanup or
a connection observer fails. The caller must also require the exact case-ID set,
bounded source-proven negative SQL diagnostics, no OOM, unchanged source and
unchanged production identities; a successful process exit alone is insufficient.

Full business readers/writers, imports, projections, publication, the complete
data transfer and production recovery remain separate qualification gates.
