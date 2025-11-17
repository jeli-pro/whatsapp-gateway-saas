# Phase Rules: `initialization` for init.agent-swarm.md

## 1. Testing
- **Structure**: Tests located in `[e2e|integration|unit]/[domain].test.ts`.
- **Execution**: `npm test` must pass. No skipped tests.
- **Mocks**: External network APIs only. Mocking internal logic is an anti-pattern.

## 2. State & Blueprint
- **Work Unit**: The spec is the multi-line `INSTRUCTIONS` inside the `/** TODO: ... */` block.
- **Completion**: Task is complete *only when* the source `TODO` block is deleted and tests pass.
- **Logging**: `.nocaflow/initialization/agent-log/{plan_id}.{part_id}.log`.
