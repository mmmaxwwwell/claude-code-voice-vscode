# Learnings

Discoveries, gotchas, and decisions recorded by the implementation agent across runs.

---

- **T002**: VS Code `contributes` in package.json does not support declarative status bar items. Status bar items must be created programmatically via `vscode.window.createStatusBarItem()` in the extension code (T021). The task description mentions "status bar item" in contributes but this is not possible in the manifest.
- **T002**: Used `engines.vscode: "^1.85.0"` to match `@types/vscode` version — this is a reasonable baseline for 2024+ VS Code features.
- **T004**: `npm` and `node` are only available inside `nix develop` shell — all commands must be run via `nix develop --command bash -c "..."`.
- **T004**: Created `scripts/build.mjs` using esbuild JS API instead of inline CLI in package.json — cleaner and extensible. A minimal `src/extension.ts` stub is needed for typecheck and build to pass.
- **T005**: Audio fixture generator uses stdlib only (no numpy) for synthetic mode, so it works outside the nix devshell. The `--tts` mode requires piper-tts + numpy for realistic speech. Synthetic fixtures use modulated tone bursts that should activate VAD but won't produce meaningful transcriptions — downstream tests needing real transcription should use `--tts` regenerated fixtures.
- **T008**: `uv sync --dev` requires `[tool.uv] dev-dependencies` (or `[dependency-groups] dev`) — the `[project.optional-dependencies] dev` section alone is NOT sufficient. Without the uv-specific section, `uv sync --dev` actually *uninstalls* pytest. Added `[tool.uv] dev-dependencies` to pyproject.toml to fix.
