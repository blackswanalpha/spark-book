# sparkBook — Worklog

Chronological build log. Each entry is dated, scoped, and linked to the Changelog where the change was released. Times are EAT (UTC+3).

---

## 2026-09-30 — Terminal sessions that survive, project search and tasks

- **Scope:** `src-tauri/src/{project.rs (new),pty.rs,pty_sink.rs,checkpoint.rs,lib.rs}`, `src/shell/project/{ProjectPicker.tsx,ProjectPicker.css,fuzzy.ts,tasks.ts}` (new), `src/shell/{TerminalPanel,ProjectSwitcher,SideBar,MenuBar}.tsx`, `src/shell/Terminal/{TerminalView.tsx,sessions.ts}`, `src/shell/{workspace,openDocument,checkpointManager}.ts`, `src/store/{terminal,projects,checkpoint}.ts`, `src/bridge/{commands,pty}.ts`, `src/commands/registry.ts`, `src/editor/{CodeEditor,MarkdownEditor}/index.tsx`, `src/editor/CodeEditor/viewState.ts`, `src/App.tsx`, `src/ui/Icon.tsx`. PR #39.
- **What:** Go to File, Find in Files and Run Task share one picker (`spark:project:picker` with `{ mode }`), backed by two new async host commands that walk the root on the blocking pool. The host now puts the shell's live directory on every frame (`/proc/<pid>/cwd`, OSC 7 as fallback). The session keeps it as `liveCwd` beside the spawn `cwd`, which keys the view and must not change. Tabs can be named. The panel is hidden rather than unmounted. Projects can be pinned, with the flag carried through the checkpoint in both the TS and Rust copies of `ProjectRecord`/`ProjectSave`.
- **Found by running it:** drove the debug build under Xvfb with a scratch `XDG_*` profile.
  1. `TerminalDialog` returned `null` when closed. `TerminalView` kills its pty on unmount, so every toggle ended every shell. The 0.4.0 rule was "sessions stay mounted while hidden", but it had only been applied to tab switching.
  2. Saved terminal cwd was the spawn directory, so `cd` was lost on relaunch.
  3. `openPath` had no dedupe. Two tabs of one file held two buffers.
  4. `TreeLevel` tested "no children yet" before "load failed", so a failed `read_dir` spun forever.
  5. Opening a deleted project folder switched into it.
  6. `TerminalView` encoded every chord, so Ctrl+` reached the shell as NUL.
  7. The checkpoint mirror lands one debounce after the projects save and boot always preferred it, so a SIGTERM between the two restored the older workspace. `seedProjects` now keeps the newer row by `lastOpened`.
- **Decisions:** `liveCwd` is separate from `cwd` because `cwd` is part of the view key: moving it would respawn the shell under the user. The kernel's answer beats OSC 7 because it needs no shell cooperation and a program's output cannot fake it. A restored-but-closed panel stays unmounted until first opened, so a relaunch spawns no shells nobody asked for. A task's command is dropped when the tab flips to root, so a restart never re-runs a build as root. `setSessionTitle`/`setSessionCwd`/`setStatus` return the state itself on a no-op: a fresh `{}` still notifies zustand, which reset the workspace autosave debounce on every frame. Nothing is written into project folders; tasks are read from files the project already has.
- **Verification:** `npm run ci` (702 tests, 42 new; lint 0 errors, warning count unchanged) and `cargo test` (70). In the real app I checked: tab label after `cd`; Ctrl+Shift+` and Ctrl+PageUp from inside a shell; Ctrl+` hide/show keeping scrollback; quit via SIGTERM and relaunch landing both tabs in their live directories with the name kept; Go to File with `:2`; Find in Files; Run Task running `npm run test` in a named tab; switcher arrows/Enter, pin and the missing-folder marker; the *Folder not found* refusal; *Permission denied* shown for a `chmod 000` folder; an old snapshot with four copies of one file restoring as one tab.

## 2026-08-31 — Projects and workspace restore

- **Scope:** `src/store/projects.ts` (new), `src/shell/workspace.ts` (new), `src/shell/ProjectSwitcher.tsx` (new), `src/editor/CodeEditor/viewState.ts` (new), `src/App.tsx`, `src/store/{documents,terminal,explorer}.ts`, `src/shell/{TitleBar,TerminalPanel,SideBar,Onboarding,SplashScreen,firstRun,MenuBar}.tsx`, `src/editor/{CodeEditor,MarkdownEditor}/index.tsx`, `src/commands/registry.ts`, `src/bridge/commands.ts`, `docs/reference/{projects-json,app-state,renderer-modules,README,build-and-config}.md`, `docs/explanation/state-and-persistence.md`, `docs/how-to/{reset-app-state,customise-keybindings}.md`.
- **What:** A project is an opened folder; each carries a `Workspace` restored on next launch. `projects.json` (`~/.local/share/com.sparkbook.app/`) holds up to 20 projects × 20 tabs, written through `LazyStore` with a synchronous `localStorage` mirror and a total `coerce()` — the exact shape of `store/settings.ts:151-231`, minus the cross-window broadcast (single writer). `App.tsx:184`'s boot effect, whose comment claimed to "open last session" while only opening `/welcome.md`, now hydrates the cache, restores the last project, and falls through to recents/welcome only when nothing came back. Restore order is load-bearing: `setRoot` resets `expanded` to just the root (`explorer.ts:255-288`), so expansion is replayed sequentially afterwards; tabs read in parallel under `allSettled` with missing files dropped; `setActive` runs last because `open()` focuses every doc it creates. `OpenDoc` gained `scrollTop`; CodeEditor and MarkdownEditor restore caret and scroll after `new EditorView` (the scroll write needs a rAF — CodeMirror measures on the next frame and discards anything written before). Terminal panel geometry lifted from `TerminalDialog`'s local state into `useTerminal.panel`, and `restoreTabs` rebuilds tabs at their saved cwd and privilege as fresh shells. New `Switch Project…` / `Close Project` commands and a `ProjectSwitcher` dialog; `file.recent` finally points at the sidebar's Recents tab instead of the command palette.
- **Decisions:** Folder = project, so opening a folder and switching a project are one code path (`spark:folder:open`) and nothing is written into the user's directories. Renderer-side `LazyStore` rather than the staged `app_state_*` host commands — `store:default` was already granted, so this needed **zero Rust changes** (verified: `git status src-tauri/` is empty). The word *session* was avoided throughout: it already means a terminal PTY tab. Sidebar width stays in `useSidebarLayout`'s localStorage as the live value, overridden per project on restore, rather than gutting a tested 140-line hook. Scroll restore is scoped to the two CodeMirror surfaces plus Tiptap's container; `HtmlPreview` and `SvgEditor` are deferred because a byte offset does not map to a stable position in derived output. Boot is latched at module scope — StrictMode double-invokes the effect and a ref would be reset by the remount, giving 2N tabs.
- **Empty state:** reworked around projects at the user's request — the "New document" card is gone, replaced by **New project…** / **Switch project…** / **Open file…** over a Recent projects list carrying each folder's path and tab count. `onCreate` dropped from `OnboardingScreenProps`, `onSwitchProject` and `projects[].tabCount` added.
- **Found while building:** four defects, three of them pre-existing.
  1. `TitleBar.tsx:59`'s close button called `getCurrentWindow().close()` directly, so the ordinary way of quitting bypassed the unsaved-changes guard entirely — and would have skipped the snapshot flush. Routed through `spark:window:close:request`.
  2. `TitleBar`'s title-sync effect called `getCurrentWindow()` unguarded. Outside Tauri that **throws** (`__TAURI_INTERNALS__` is undefined) and `?.` cannot catch a throw, so the whole shell crashed on mount and browser-only dev was completely broken. Confirmed against a stashed tree before fixing. All four window calls now gate on `isTauri`.
  3. `shouldShowWelcome({docsOpen: order.length})` read `order` from a `[]`-deps closure, so it was always `0`.
  4. Mine: the module-scope boot latch and the effect's `cancelled` flag fought each other. StrictMode mounts, cleans up (setting `cancelled`), then mounts again — where the latch returns early. The first run therefore completed with `cancelled === true` and never called `setBootReady(true)`, hanging the splash forever. The `cancelled` flag was removed; the latch alone is the correct guard. Also: autosave only fires on a *subsequent* store change, so a newly opened project sat in the cache with a null root until the user touched something — both the boot and switch paths now `flushWorkspace()` once immediately after starting autosave.
- **Runtime verification:** drove the production build in Chrome against the `MEMORY_FS` fallback. Opened `/` as a project, opened three files, expanded `docs`, reloaded, and confirmed all three tabs returned in order with `hello.ts` active and the tree expanded as left. Confirmed the cache held root, expanded set, per-tab mode and cursor, and `activeIndex: 2`. Also confirmed no autosave write loop (0 cache writes over 3 idle seconds). One caveat: pixel-level *scroll* restore could not be exercised because every file in the mock FS is shorter than the viewport, and a stalled splash fade seen mid-test turned out to be `requestAnimationFrame` being paused in a background tab (`document.hidden`), not a defect.
- **Verification:** `npm run typecheck`, `npm run lint` (0 errors; no warnings in any new file), `npm test` — **389 passed** across 16 files, including 27 new coercion/cache tests, 21 capture→restore round-trip tests, 9 cursor-position tests and 8 terminal-store tests — and `npm run build`. The DOM half of scroll restore is deliberately not unit-tested: jsdom does no layout, so `scrollDOM.scrollTop` never leaves 0; `posFromCursor` was extracted precisely so the position maths could be covered instead.

## 2026-08-29 — Release 0.3.2: red theme (+ boot experience from #14)

- **Scope:** `src/theme/{tokens.css,ThemeProvider.tsx}`, `src/shell/{TitleBar.tsx,TitleBar.css,WelcomeWizard.tsx,WelcomeWizard.css}`, `src/lib/{themeTokens.ts,shiki.ts}`, `package.json`, `src-tauri/{tauri.conf.json,Cargo.toml,Cargo.lock}`, `changelog/{CHANGELOG.md,0.3.2.md}`, `worklog.md`.
- **What:** Added the **red** theme (dark crimson: bg #1c0a0e, surfaces #260f13→#57202b, accent #ef5350) across all theme touchpoints — tokens, provider types/ORDER/resolve, TitleBar menu + 6th swatch (3×2 mini-grid fills exactly), welcome-wizard pick + preview swatch, and Shiki registration (`spark-red`, plus the previously missed `spark-amber`; `highlight()` now takes `HighlightThemeId`). Version bumped 0.3.1 → 0.3.2 so the release also ships the boot-experience work merged from `feature/boot-experience-screens` (#14): real-stage splash, welcome wizard + onboarding, loader overlay, and the updater missing-platform fix (release workflow now guarantees `linux-x86_64` in `latest.json`).
- **Decisions:** Red is a dark theme (pairs with navy=dark-blue, amber=light-warm) so the set spans dark blue / light warm / dark red. Amber's missing Shiki registration was fixed in passing while touching the highlight bridge.
- **Verification:** `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`; `cargo update -p spark-book --offline` synced the lock at 0.3.2.

## 2026-08-28 — Boot experience: splash / loader / first-run setup + updater platform fix

- **Scope:** `src/shell/{SplashScreen,WelcomeWizard,Onboarding,firstRun}.{tsx,ts,css}`, `src/ui/{Loader.tsx,Loader.css}`, `src/App.tsx`, `src/App.css`, `src/version.ts`, `src/bridge/updater.ts`, `src/commands/registry.ts`, `tsconfig.json`, `vite.config.ts`, `.github/workflows/release.yml`, `changelog/CHANGELOG.md`.
- **What:** Ported the boot-experience designlabs (`labs/splash.html`, `labs/loader.html`, `labs/onboarding.html`) to the React shell. Splash stages now track the real boot (theme → IPC → state.json → session → ready), show `v{version}` (`src/version.ts` from `package.json`), and dismiss on boot completion via a `ready` gate instead of a fixed timer. New first-run flow: `spark.onboarded` localStorage flag + `shouldShowWelcome()` (no recents, no docs, never onboarded) opens a 3-step welcome wizard (intro → live theme pick across all 5 themes → ready); the no-docs empty state became `OnboardingScreen` with action cards + recents; re-openable via Help → Show Welcome Screen. `LoaderOverlay` added for indeterminate host work; `prefers-reduced-motion` honoured in loader/wizard/onboarding CSS. Updater: extracted `classifyUpdaterError()` so the missing-`linux-x86_64`-in-`latest.json` failure (`None of the fallback platforms ["linux-x86_64"] …`) is handled as a friendly "No update available for this platform yet" instead of "Update check failed"; release workflow installs `libfuse2`, pins `--bundles appimage,deb` on Linux, and `verify-ota` now fails the release if `latest.json` lacks `linux-x86_64`.
- **Decisions:** First-run flag lives in localStorage (renderer-side analogue of `state.json` first-run defaults per `docs/reference/app-state.md`) — a host-side `app_state_get` bridge is the seam for a future migration. Boot gate (`bootReady`) is computed in `App.tsx` so the splash never lies about progress.
- **Verification:** Reproduced the updater error live (`--log-to-stderr`: `Searching for updater target 'linux-x86_64' in release data` → miss) against the v0.3.1 manifest; `npm run typecheck`, `npm run lint` (no new errors), `npm test` (29 passed incl. new `updater.test.ts` + `firstRun.test.ts`), `npm run tauri build` (.deb 0.3.1 bundled; app boots).

## 2026-08-27 — File explorer port from designlabs

- **Scope:** `src/shell/SideBar.tsx`, `src/shell/SideBar.css`, `src/store/explorer.ts`, `src/bridge/{commands,events}.ts`, `src-tauri/src/lib.rs`, `docs/reference/{renderer-modules,host-commands}.md`, `changelog/CHANGELOG.md`.
- **What:** Ported the designlab file explorer (`designlabs/labs/explorer.html`) to the React shell. Lazy `read_dir` per directory via a new zustand+immer store (`useExplorer`); tree-view keyboard contract (↑↓ →← Enter Home End); toolbar (new file, refresh, collapse, show hidden); loader row; empty-folder state; recents tab preserved. Added host commands `create_file` (refuses to overwrite, returns `FileStat`) and `mkdir` (`mkdir -p`, idempotent) in `src-tauri/src/lib.rs`. Added `watchPath` / `unwatchPath` typed wrappers and `onFileChanged` event subscriber. Explorer folder root sourced from explicit `file.openFolder` first, then falls back to the active document's parent directory.
- **Decisions:** Keep the explorer store separate from the document store — different concern, different lifecycle. Use `window.prompt` for the new-file name this iteration (a proper popover is a follow-up).
- **Verification:** `npm run typecheck`, `npm run lint`, `npm run test`, `npm run build`; `cargo check` on `src-tauri/`.

## 2026-08-27 — Documentation pass (README / explanation / description / changelog scaffolding)

- **Scope:** `README.md`, `explanation.md`, `description.md`, `worklog.md`, `changelog/` — `sparkBook-main/` package.
- **What:** Authored the five artefacts requested for the sparkBook product surface. `README.md` covers quick-start, architecture sketch, scripts, project structure, and docs map. `explanation.md` (this package) distils why the renderer/host split, the IR, and the file-as-truth tenet exist, with trade-offs and seams. `description.md` is the 300-char store listing (validated to 300 chars). `changelog/` seeded with Keep-a-Changelog `CHANGELOG.md` at `0.1.0`.
- **Files:** `sparkBook-main/README.md:1`, `sparkBook-main/explanation.md:1`, `sparkBook-main/description.md:1`, `sparkBook-main/changelog/CHANGELOG.md:1`.
- **Notes:** Docs stay consistent with `docs/explanation/{overview,architecture,data-model}.md` and `src/ir/types.ts:14`, `src/bridge/commands.ts:13`, `src/store/documents.ts:50`. Description string length asserted with `python3 -c "len(open(...).read().strip()) == 300"`.

## 2026-08-27 — Renderer shell and document store

- **Scope:** `src/App.tsx`, `src/store/documents.ts`, `src/commands/registry.ts`, `src/bridge/commands.ts`.
- **What:** Wired `App.tsx:40` — `ThemeProvider`, `ToastProvider`, `SplashScreen`, custom `TitleBar` (OS decorations off), `Tabs`, `SideBar`, `StatusBar`, `CommandPalette`. Central command table in `registry.ts:9` consumed by palette, title-bar menu mirror, and keybinding dispatch. Zustand + Immer store (`documents.ts:50`) holds `docs/order/active/history`, per-doc `past/future` capped at 100 snapshots, `setRaw`/`setIr`/`undo`/`redo`, cursor and dirty flag. Bridge (`commands.ts:13`) wraps `invoke()` with browser-only `MEMORY_FS` fallback for Vite-only dev.
- **Decisions:** Store lives in renderer (fast synchronous undo/mode switch); host only sees bytes on save/load. See `explanation.md:5`.
- **Verification:** `npm run typecheck`, `npm run dev` in browser (mock FS), manual `readFile("/welcome.md")` smoke test.

## 2026-08-26 — Editor surfaces

- **Scope:** `src/editor/CodeEditor`, `src/editor/MarkdownEditor`, `src/editor/RichEditor`, `src/editor/editor.css`.
- **What:** Code surface on CodeMirror 6 with `lineNumbers`, `highlightActiveLine`, `bracketMatching`, `history`, `searchKeymap`, language compartment (`extLangFor`), Shiki-bridged `HighlightStyle` via `highlightBridge.ts:10`, and beam `EditorView.updateListener` → `store.setRaw` + cursor sync. Markdown surface adds markdown language, toolbar (H1–H3, bold/italic/link/lists/blockquote/code), `Compartment` for theme, and live preview via `renderMd.ts` (self-contained md→html). Rich surface on Tiptap StarterKit + lowlight. All three read/write the shared IR (`src/ir/types.ts:14`).
- **Open items:** File-watcher `file:changed` event wiring; Rich slash/floating menus (referenced in `designlabs`).

## 2026-08-26 — Theming, motion, and UI primitives

- **Scope:** `src/theme/`, `src/motion/`, `src/ui/`, `src/shell/`.
- **What:** `ThemeProvider.tsx` — three themes (light/dark/system via `prefers-color-scheme`), CSS variables in `tokens.css`/`base.css`. `motion/index.ts` re-exports `framer-motion`. Primitives: `Button`, `Dialog`, `Dropdown`, `Icon`, `Input`, `Kbd`, `Loader`, `Popover`, `StatusBar`, `Tabs`, `Toast`. Shell: `TitleBar` (custom chrome, `decorations: false` in `tauri.conf.json:22`), `SideBar` (recents via `recentsGet/recentsAdd`), `CommandPalette` (Radix Dialog), `SplashScreen`. Framer `AnimatePresence` transitions for sidebar/status/editor.

## 2026-08-25 — Tauri host

- **Scope:** `src-tauri/src/lib.rs`, `src-tauri/src/main.rs`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`.
- **What:** Host exposes `read_file`/`write_file`/`read_dir`/`stat` (`lib.rs:38`) with `HostError` enum (`NotFound`, `PermissionDenied`, `NotUtf8`, `AlreadyExists`, `InvalidPath`, `Internal`) serialized as `{ kind, data }`. Plugins: `dialog`, `fs`, `store`, `os`, `window-state`, `clipboard-manager`, `process`, `log`. Window config: 1280×800, `titleBarStyle: Overlay` (macOS), `hiddenTitle: true`, strict CSP (`default-src 'self'`). Cargo release profile (`Cargo.toml:32`): `lto = true`, `opt-level = "s"`, `panic = "abort"`.
- **Notes:** `recents_*` / `app_state_*` commands staged for session restore; `notify` file-watch planned (self-write suppression).

## 2026-08-25 — IR and project scaffolding

- **Scope:** `src/ir/types.ts`, `src/ir/ids.ts`, `vite.config.ts`, `tsconfig.json`, `package.json`.
- **What:** IR types (`Document: { version: 1, blocks: Block[] }`, `Block` variants, `Inline` marks) — stable `id` per node, regenerated on load so on-disk stays human-diffable. `vite.config.ts:9` path aliases (`@ui`, `@shell`, `@ir`, …), dev server 1420/strictPort, Tauri-aware HMR (1421). Dependencies pinned: CodeMirror 6.35, Tiptap 2.10, Zustand 4.5, Shiki 1.29, Radix UI, Phosphor Icons, Framer Motion.
- **Decisions:** Versioned IR (`version: 1`) leaves room for migrators without persisting ids.

## 2026-08-24 — Docs and design labs

- **Scope:** `docs/` (Diátaxis), `designlabs/`.
- **What:** `docs/explanation/{overview,architecture,data-model,process-model,state-and-persistence}` and `docs/reference/{host-commands,ir,renderer-modules,…}` authored. `designlabs/` — static, build-free HTML+CSS prototypes for all UI elements (app shell, titlebar, sidebar, explorer, palette, dialogs, toasts, markdown/rich/code editors), with local fonts (Inter, JetBrains Mono WOFF2) and SVG icons, `assets/manifest.json` + `tools/verify_assets.py` (XML parse, WOFF2 magic, SHA-256).

---

## Conventions

- New entries go at the top (reverse-chronological). Keep each entry to: date, scope, what, decisions, verification/open items.
- Link code with `path:line` (e.g., `src/ir/types.ts:14`) so the log stays navigable.
- Promote user-visible changes to `changelog/CHANGELOG.md` under the next unreleased heading; cut a version heading on release.
