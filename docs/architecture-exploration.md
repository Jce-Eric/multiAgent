# Architecture Exploration

Date: 2026-09-06

The v0.5 design was selected after ten independent review passes. The constraint for every pass was that existing clients must continue to create sessions, send messages, answer interactions, stop work, and consume SSE without engine-specific behavior.

## Ten review passes

1. **Northbound contract**: The existing five workflows are a useful compatibility facade. Decision: retain all current routes and make changes additive.
2. **Domain model**: Plain text messages cannot represent files, structured values, or artifacts. Decision: retain `content` and add typed `parts` as the forward-compatible representation.
3. **Run lifecycle**: A returned `runId` had no queryable resource. Decision: make Run a first-class persisted entity with an explicit state machine.
4. **Engine selection**: A process owned one engine and hid sessions created by another engine. Decision: introduce an Engine Catalog and bind the selected engine to each Session.
5. **Driver boundary**: ACP engines are configuration-only, while proprietary protocols need code. Decision: keep protocol translation southbound and add a protocol factory registration point.
6. **Event contract**: Event IDs reset on restart and the envelope had no version. Decision: add `specVersion` and `source`, and persist the event cursor when SQLite is enabled.
7. **Persistence**: Messages stored as one JSON aggregate are acceptable for local sessions but Run and event recovery were missing. Decision: add normalized Run and event tables now; defer full message normalization to a later migration.
8. **Workspace isolation**: Direct path handling couples orchestration to local execution. Decision: move validation into `WorkspaceResolver` and expose a compatible local Workspace reference.
9. **Runtime and security**: Process supervision, credentials, and sandboxing should not live in protocol adapters. Decision: preserve these as separate future ports instead of expanding `AgentEngine` with policy concerns.
10. **Compatibility and operations**: A large distributed rewrite would add risk before the stable core exists. Decision: ship a vertical v0.5 slice with multi-engine routing, durable Runs, durable SSE history, OpenAPI, AsyncAPI, and conformance tests.

## Resulting invariants

- The default engine is selected by `--engine`, but a Session may optionally select another configured engine.
- A Session remains permanently bound to its engine.
- Existing `generation.*` events remain supported; `run.*` events are the canonical lifecycle representation.
- Existing `Message.content` remains supported; richer content is added through `Message.parts`.
- Engine-native payloads remain under `agent.event` rather than changing core resources.
- SQLite mode preserves sessions, Runs, and the SSE cursor across gateway restarts.

## Deferred work

- Transactional outbox across Session, Run, Message, and Event writes.
- Persisted Interaction resources and restartable human-in-the-loop execution.
- Artifact storage and content-part upload APIs.
- A2A remote driver and native checkpoint/resume handles.
- PostgreSQL repositories, runtime ownership leases, and cross-instance event fanout.
- Isolated sidecar plugin manifests and a driver conformance kit.
