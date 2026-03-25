# Learnings

Discoveries, gotchas, and decisions recorded by the implementation agent across runs.

---

- **T002**: VS Code `contributes` in package.json does not support declarative status bar items. Status bar items must be created programmatically via `vscode.window.createStatusBarItem()` in the extension code (T021). The task description mentions "status bar item" in contributes but this is not possible in the manifest.
- **T002**: Used `engines.vscode: "^1.85.0"` to match `@types/vscode` version — this is a reasonable baseline for 2024+ VS Code features.
- **T004**: `npm` and `node` are only available inside `nix develop` shell — all commands must be run via `nix develop --command bash -c "..."`.
- **T004**: Created `scripts/build.mjs` using esbuild JS API instead of inline CLI in package.json — cleaner and extensible. A minimal `src/extension.ts` stub is needed for typecheck and build to pass.

