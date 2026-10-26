# Development ownership

All application source, tests, manifests, lockfiles, migrations and runtime configuration belong under `src/`. Planning and acceptance reports belong under `docs/`.

Read `docs/development-requirements.md`, `docs/auto-publish-development.md` and `src/contracts/README.md` before implementation. The v2 automatic publication and author-managed update rules supersede older human-review requirements. Shared contracts are owned by the coordinator. Workers must not modify another module, shared contracts or root build scripts without coordination.

Stack: TypeScript, React frontend, Node.js backend, SQLite for local persistence. Current local Node is 26; target Node >=24. Use separate module manifests and lockfiles to avoid parallel dependency edits. No production identity or Agent provider has been supplied: explicit local demo adapters are acceptable, but must never be represented as real platform authentication or real Agent acceptance.

Use Chinese user-facing text. Do not implement subscriptions or external notifications. Running tasks never switch Skill versions. Provisional session rules D1-D3 are configurable/documented defaults, not confirmed requirements.

Workers commit only their owned files in their assigned worktree. Run meaningful tests and record commands, results, commit SHA, limitations and unverified integrations in the assigned acceptance report. Do not merge, push, delete worktrees or change the management branch. Preserve completed branches for user-managed review and merge.


Current v2: no manual review or admin conflict merge. Publication requires a current draft base; author explicitly confirms draft synchronization first. Broadcast only committed publications. Legacy review APIs must not remain an alternate publication path.
