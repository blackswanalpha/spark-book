/* ============================================================
   sparkBook · src/App.tsx
   Top-level shell.  Wires together:
     • ThemeProvider  (3 themes + system)
     • ToastProvider
     • Splash overlay
     • Custom TitleBar (replaces OS default)
     • Tabs | Sidebar | Editor | StatusBar
     • CommandPalette
   The default OS title bar is suppressed via src-tauri config
   (decorations: false, titleBarStyle: "Overlay" on macOS) so
   the rendered titlebar IS the chrome.
   ============================================================ */
import { Suspense, lazy, useCallback, useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "@motion/index";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { TitleBar } from "@shell/TitleBar";
import { MenuBar } from "@shell/MenuBar";
import { SideBar } from "@shell/SideBar";
import { PluginRail } from "@shell/PluginRail";
import { Tabs } from "@ui/Tabs";
import { StatusBar } from "@ui/StatusBar";
import { CommandPalette } from "@shell/CommandPalette";
import { CodeEditor } from "@editor/CodeEditor";
import { MarkdownEditor } from "@editor/MarkdownEditor";
import { RichEditor } from "@editor/RichEditor";
import { HtmlPreview } from "@editor/HtmlPreview";
import { SvgEditor } from "@editor/SvgEditor";
/* The binary + timeline surfaces are code-split: pdf.js alone is larger
   than the rest of the renderer, and a markdown session should never pay
   for it. `lazy` needs module scope — see the note by TerminalStandalone. */
const ImageViewer = lazy(() => import("@editor/ImageViewer").then((m) => ({ default: m.ImageViewer })));
const ImageEditor = lazy(() => import("@editor/ImageEditor").then((m) => ({ default: m.ImageEditor })));
const AnimationBuilder = lazy(() => import("@editor/AnimationBuilder").then((m) => ({ default: m.AnimationBuilder })));
const PdfReader = lazy(() => import("@editor/PdfReader").then((m) => ({ default: m.PdfReader })));
const MediaPlayer = lazy(() => import("@editor/MediaPlayer").then((m) => ({ default: m.MediaPlayer })));
import { SplashScreen } from "@shell/SplashScreen";
import { WelcomeWizard } from "@shell/WelcomeWizard";
import { OnboardingScreen } from "@shell/Onboarding";
import { shouldShowWelcome } from "@shell/firstRun";
import { openPath } from "@shell/openDocument";
import { ThemeProvider, useTheme } from "@theme/ThemeProvider";
import { ToastProvider, useToast } from "@ui/Toast";
import { useDocs, switchableModes } from "@store/documents";
import { useExplorer } from "@store/explorer";
import { hydrateSettings } from "@store/settings";
import { useProjects, hydrateProjects, projectId } from "@store/projects";
import { useTerminal } from "@store/terminal";
import {
  restoreWorkspace,
  startWorkspaceAutosave,
  flushWorkspace,
  registerLayoutBridge,
  markHydrated,
  isRestoring,
} from "@shell/workspace";
import {
  bootCheckpoint,
  seedProjects,
  startCheckpointMirror,
  flushCheckpoint,
} from "@shell/checkpointManager";
import { readFile, recentsAdd, recentsGet, isTauri, openWithOS, stat } from "@bridge/commands";
import { checkForUpdates, checkForUpdatesOnBoot, getRuntimeVersion } from "@bridge/updater";
import { APP_VERSION } from "@version";
import { restoreZoom, zoomIn, zoomOut, zoomReset } from "@shell/zoom";
import { useSidebarLayout, SIDEBAR_MAX } from "@shell/useSidebarLayout";
import { buildCommands, bindPalette, type CommandSpec, setCurrentRoot } from "@commands/registry";
import { Icon } from "@ui/Icon";
import OpenDialog from "@ui/OpenDialog";
import SaveAsModal from "@shell/SaveAsModal";
import UnsavedChangesModal, { type UnsavedChoice } from "@shell/UnsavedChangesModal";
import ProjectSwitcher from "@shell/ProjectSwitcher";
import ProjectPicker from "@shell/project/ProjectPicker";
import "./App.css";

/** Tab icon per document mode. */
const MODE_ICON: Record<string, string> = {
  markdown: "mode-markdown",
  rich: "mode-rich",
  html: "mode-html",
  svg: "mode-svg",
  code: "mode-code",
  image: "mode-image",
  imageedit: "mode-imageedit",
  animation: "mode-animation",
  pdf: "mode-pdf",
  video: "mode-video",
  audio: "mode-audio",
};

/* Boot latches. Module scope rather than a ref because StrictMode
   remounts the component, which would reset a ref and re-run the
   restore. */
let bootStarted = false;
let teardownAutosave: (() => void) | null = null;
let teardownCheckpoint: (() => void) | null = null;

/* Help menu links point at the public repository. */
const REPO_URL = "https://github.com/blackswanalpha/spark-book";

function Shell() {
  const { resolved } = useTheme();
  const toast = useToast();
  const docs = useDocs((s) => s.docs);
  const order = useDocs((s) => s.order);
  const active = useDocs((s) => s.active);
  const setActive = useDocs((s) => s.setActive);
  const open = useDocs((s) => s.open);
  const sidebar = useSidebarLayout();
  const [showStatus, setShowStatus] = useState(true);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [recents, setRecents] = useState<{ path: string; name: string }[]>([]);

  /* SaveAs modal state */
  const [saveAsOpen, setSaveAsOpen] = useState(false);
  const [saveAsDocId, setSaveAsDocId] = useState<string | null>(null);
  const [saveAsBusy, setSaveAsBusy] = useState(false);
  const [saveAsError, setSaveAsError] = useState<string | null>(null);

  /* Unsaved-changes modal state */
  const [unsavedOpen, setUnsavedOpen] = useState(false);
  const [unsavedDocId, setUnsavedDocId] = useState<string | null>(null);
  const [unsavedContext, setUnsavedContext] = useState<string>("");
  const [unsavedBusy, setUnsavedBusy] = useState(false);
  const [unsavedError, setUnsavedError] = useState<string | null>(null);

  /* Boot + first-run wizard state */
  const [bootReady, setBootReady] = useState(false);
  const [welcomeOpen, setWelcomeOpen] = useState(false);

  const pendingCloseRef = useRef<(() => void) | null>(null);

  /* The command table closes over store getters, not over React state, so
     it only needs rebuilding when the set of commands could change. Holding
     it in state (rather than assigning a ref during render) keeps the menu
     and palette re-rendering when it does. */
  const [commands, setCommands] = useState<CommandSpec[]>(() => buildCommands());
  const commandsRef = useRef<CommandSpec[]>(commands);
  commandsRef.current = commands;

  const runCommand = useCallback((id: string) => {
    commandsRef.current.find((c) => c.id === id)?.run();
  }, []);

  useEffect(() => {
    const rebuild = () => setCommands(buildCommands());
    window.addEventListener("spark:commands:invalidate", rebuild);
    return () => window.removeEventListener("spark:commands:invalidate", rebuild);
  }, []);

  useEffect(() => { bindPalette({ open: () => setPaletteOpen(true), close: () => setPaletteOpen(false) }); }, []);

  /* Settings: read the persisted file and subscribe to changes made in
     the pop-out terminal window. */
  useEffect(() => hydrateSettings(), []);

  /* Layout bridge: sidebar geometry lives in a React hook and the status
     bar toggle is local state, so neither is reachable from the plain
     workspace module. Hand it accessors instead of lifting the state. */
  const showStatusRef = useRef(showStatus);
  showStatusRef.current = showStatus;
  const sidebarRef = useRef(sidebar);
  sidebarRef.current = sidebar;
  useEffect(() => {
    registerLayoutBridge({
      getWidth: () => sidebarRef.current.width,
      getCollapsed: () => sidebarRef.current.collapsed,
      getShowStatus: () => showStatusRef.current,
      setWidth: (px) => sidebarRef.current.setWidth(px),
      setCollapsed: (v) => sidebarRef.current.setCollapsed(v),
      setShowStatus: (v) => setShowStatus(v),
    });
    return () => registerLayoutBridge(null);
  }, []);

  /* Toast bridge: registry runs outside React and dispatches events
     that we forward to the in-tree toast API. */
  useEffect(() => {
    const onSuccess = (e: Event) => {
      const d = (e as CustomEvent<{ title: string; body?: string }>).detail;
      if (d?.title) toast.success(d.title, d.body);
    };
    const onError = (e: Event) => {
      const d = (e as CustomEvent<{ title: string; body?: string }>).detail;
      if (d?.title) toast.error(d.title, d.body);
    };
    const onInfo = (e: Event) => {
      const d = (e as CustomEvent<{ title: string; body?: string }>).detail;
      if (d?.title) toast.info(d.title, d.body);
    };
    window.addEventListener("spark:toast:success", onSuccess);
    window.addEventListener("spark:toast:error", onError);
    window.addEventListener("spark:toast:info", onInfo);
    return () => {
      window.removeEventListener("spark:toast:success", onSuccess);
      window.removeEventListener("spark:toast:error", onError);
      window.removeEventListener("spark:toast:info", onInfo);
    };
  }, [toast]);

  /* Listen for "open Save As" requests (dispatched by file.save when
     the active doc has no path). */
  useEffect(() => {
    const onOpen = (e: Event) => {
      const detail = (e as CustomEvent<{ docId: string }>).detail;
      setSaveAsDocId(detail?.docId ?? active ?? null);
      setSaveAsError(null);
      setSaveAsOpen(true);
    };
    window.addEventListener("spark:saveas:open", onOpen);
    return () => window.removeEventListener("spark:saveas:open", onOpen);
  }, [active]);

  /* Tab close request: route through the unsaved-changes guard. */
  useEffect(() => {
    const onClose = (e: Event) => {
      const detail = (e as CustomEvent<{ id: string }>).detail;
      const id = detail?.id;
      if (!id) return;
      const doc = useDocs.getState().docs[id];
      if (!doc) return;
      if (!doc.dirty) {
        useDocs.getState().close(id);
        toast.info("Tab closed");
        return;
      }
      pendingCloseRef.current = () => {
        useDocs.getState().close(id);
        toast.info("Tab closed");
      };
      setUnsavedDocId(id);
      setUnsavedContext("");
      setUnsavedError(null);
      setUnsavedOpen(true);
    };
    window.addEventListener("spark:tab:close:request", onClose);
    return () => window.removeEventListener("spark:tab:close:request", onClose);
  }, [toast]);

  /* Window close request: guard the active doc, then close the Tauri
     window. */
  useEffect(() => {
    // The last thing this window does: land both snapshots, then stop
    // the mirror so a tick already queued cannot write on the way out.
    const closeWindow = async () => {
      flushWorkspace();
      await flushCheckpoint();
      teardownCheckpoint?.();
      teardownCheckpoint = null;
      try { await getCurrentWindow().close(); } catch {}
    };
    const onClose = async () => {
      // Snapshot before anything tears down. This now runs on every quit
      // path: the titlebar X routes through this event too.
      flushWorkspace();
      const id = active;
      const doc = id ? useDocs.getState().docs[id] : null;
      if (!doc?.dirty) {
        await closeWindow();
        return;
      }
      pendingCloseRef.current = closeWindow;
      setUnsavedDocId(id);
      setUnsavedContext("Quitting will discard your unsaved changes.");
      setUnsavedError(null);
      setUnsavedOpen(true);
    };
    window.addEventListener("spark:window:close:request", onClose);
    return () => window.removeEventListener("spark:window:close:request", onClose);
  }, [active]);

  // Boot: read the projects cache, restore the last project's workspace,
  // then fall through to recents / welcome only when nothing came back.
  // StrictMode double-invokes this effect, and a second pass would open
  // every restored tab twice, so the run is latched at module scope.
  useEffect(() => {
    if (bootStarted) return;
    bootStarted = true;
    // Deliberately no `cancelled` flag. StrictMode mounts, cleans up, and
    // mounts again; a per-effect cancel would abort this run while the
    // module latch blocks the second one, and boot would never finish.
    // The latch already guarantees a single run, and React 18 tolerates
    // a setState from an effect whose component has gone.
    (async () => {
      await hydrateProjects();
      markHydrated();

      // The checkpoint is the cross-window authority: it holds the
      // project rows every window writes through and the window list the
      // last quit left behind. Claiming it here is also what reopens the
      // other windows — this window keeps the first row of the plan and
      // the host opens one window per row after it.
      const boot = await bootCheckpoint().catch(() => null);
      if (boot) {
        seedProjects(boot.projects, boot.projectId);
        // Started before the restore, not after: the mirror only reacts
        // to the projects store and skips writing while a restore is
        // replaying, so there is no window where a change is missed.
        teardownCheckpoint = startCheckpointMirror(boot.label);
      }

      let restored = 0;
      const project = useProjects.getState().active();
      if (project) {
        try {
          const result = await restoreWorkspace(project.workspace);
          restored = result.opened;
          if (result.missing.length > 0) {
            toast.info(
              `${result.missing.length} file${result.missing.length === 1 ? "" : "s"} from your last session ${result.missing.length === 1 ? "is" : "are"} no longer available`,
              result.missing.length === 1 ? result.missing[0] : undefined,
            );
          }
          setCurrentRoot(project.rootPath);
        } catch {
          /* a broken snapshot must never block the editor from opening */
        }
      }

      let recentsCount = 0;
      try {
        const r = await recentsGet();
        recentsCount = r.length;
        setRecents(r.map((path) => ({ path, name: path.split("/").pop() || path })));
      } catch {}

      if (restored === 0) {
        // Read the store, not the `order` captured by this []-deps effect:
        // that closure holds the first render's value and is always 0.
        const docsOpen = useDocs.getState().order.length;
        const projectsCount = useProjects.getState().projects.length;
        if (shouldShowWelcome({ recentsCount, docsOpen, projectsCount })) {
          setWelcomeOpen(true);
          setBootReady(true);
          teardownAutosave = startWorkspaceAutosave();
          return;
        }
        // Projects exist but none is in front (the last one was closed or
        // removed): offer the picker rather than guessing.
        if (projectsCount > 0 && !project) {
          setBootReady(true);
          window.dispatchEvent(new CustomEvent("spark:projects:open"));
          teardownAutosave = startWorkspaceAutosave();
          return;
        }
        try {
          if (docsOpen === 0) {
            const text = await readFile("/welcome.md");
            open({ name: "welcome.md", path: "/welcome.md", mode: "markdown", raw: text });
            await recentsAdd("/welcome.md").catch(() => {});
          }
        } catch (e: any) {
          toast.error("Could not open welcome document", e?.kind || "Unknown error");
        }
      }

      setBootReady(true);
      // Started only now: subscribing before restore finishes would let
      // the restore's own store writes overwrite the snapshot it is
      // still reading from.
      teardownAutosave = startWorkspaceAutosave();
      flushWorkspace();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Global keybindings
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const isMod = isMac() ? e.metaKey : e.ctrlKey;
      if (isMod && e.shiftKey && (e.key === "P" || e.key === "p")) { e.preventDefault(); setPaletteOpen(true); }
      // Ctrl+P: Quick Open. Before Ctrl+S etc. only for readability — no
      // other branch takes an unshifted P.
      else if (isMod && !e.shiftKey && !e.altKey && (e.key === "p" || e.key === "P")) { e.preventDefault(); runCommand("project.quickOpen"); }
      else if (isMod && e.shiftKey && (e.key === "f" || e.key === "F")) { e.preventDefault(); runCommand("project.findInFiles"); }
      else if (isMod && e.shiftKey && (e.key === "b" || e.key === "B")) { e.preventDefault(); runCommand("project.runTask"); }
      // Shift first: the unshifted branch below also matches "S".
      else if (isMod && e.shiftKey && (e.key === "s" || e.key === "S")) { e.preventDefault(); runCommand("file.saveAs"); }
      else if (isMod && (e.key === "s" || e.key === "S")) { e.preventDefault(); runCommand("file.save"); }
      // Before the new-document branch: with Shift held the browser
      // reports "N", which that branch would otherwise swallow.
      else if (isMod && e.shiftKey && (e.key === "n" || e.key === "N")) { e.preventDefault(); runCommand("window.new"); }
      else if (isMod && !e.shiftKey && (e.key === "n" || e.key === "N")) { e.preventDefault(); runCommand("file.new"); }
      // Shifted variants first, for the same reason as Shift+N above.
      else if (isMod && e.shiftKey && (e.key === "w" || e.key === "W")) { e.preventDefault(); runCommand("window.close"); }
      else if (isMod && (e.key === "w" || e.key === "W")) { e.preventDefault(); runCommand("tab.close"); }
      else if (isMod && e.shiftKey && (e.key === "o" || e.key === "O")) { e.preventDefault(); runCommand("file.openFolder"); }
      else if (isMod && (e.key === "o" || e.key === "O")) { e.preventDefault(); runCommand("file.open"); }
      else if (isMod && e.shiftKey && (e.key === "e" || e.key === "E")) { e.preventDefault(); runCommand("project.switch"); }
      else if (isMod && e.key === ",") { e.preventDefault(); runCommand("view.settings"); }
      // "+" is what Shift+= reports; accept both so either press zooms in.
      else if (isMod && (e.key === "=" || e.key === "+")) { e.preventDefault(); runCommand("view.zoomIn"); }
      else if (isMod && e.key === "-") { e.preventDefault(); runCommand("view.zoomOut"); }
      else if (isMod && e.key === "0") { e.preventDefault(); runCommand("view.zoomReset"); }
      // Ctrl+B is also bold in the markdown and rich editors, which handle
      // it first and cancel the event; toggling the sidebar as well made
      // every bold hide or show the file tree.
      else if (isMod && (e.key === "b" || e.key === "B") && !e.shiftKey && !e.defaultPrevented) { e.preventDefault(); sidebar.toggle(); }
      // By physical key: with Shift held the browser reports "~", not "`".
      else if (isMod && e.shiftKey && e.code === "Backquote") { e.preventDefault(); runCommand("view.terminalNew"); }
      else if (isMod && (e.key === "`" || e.code === "Backquote")) { e.preventDefault(); runCommand("view.toggleTerminal"); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [runCommand, sidebar]);

  // Listen to "spark:command" events from menus
  useEffect(() => {
    const onCmd = (e: Event) => {
      const id = (e as CustomEvent<{ id: string }>).detail?.id;
      if (!id) return;
      const c = commandsRef.current.find((x) => x.id === id);
      c?.run();
    };
    window.addEventListener("spark:command", onCmd);
    return () => window.removeEventListener("spark:command", onCmd);
  }, []);

  // Sidebar/Status bar toggles
  useEffect(() => {
    const sb = () => sidebar.toggle();
    const st = () => setShowStatus((v) => !v);
    window.addEventListener("spark:toggleSidebar", sb);
    window.addEventListener("spark:toggleStatusBar", st);
    return () => {
      window.removeEventListener("spark:toggleSidebar", sb);
      window.removeEventListener("spark:toggleStatusBar", st);
    };
  }, [sidebar]);

  // Subscribe the explorer to host file:changed events once.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    useExplorer.getState().subscribeToFileChanges().then((fn) => {
      if (cancelled) { fn(); } else { unlisten = fn; }
    });
    return () => { cancelled = true; unlisten?.(); };
  }, []);

  // OTA: silent check on boot + manual check via Help → Check for Updates
  useEffect(() => {
    const cancelBoot = isTauri ? checkForUpdatesOnBoot(toast) : null;
    const onCheck = () => {
      void checkForUpdates({
        silent: false,
        onInfo: toast.info,
        onSuccess: toast.success,
        onError: toast.error,
      });
    };
    window.addEventListener("spark:help:checkForUpdates", onCheck);
    return () => {
      cancelBoot?.();
      window.removeEventListener("spark:help:checkForUpdates", onCheck);
    };
  }, [toast]);

  // Help → Show Welcome Screen (re-opens the first-run wizard)
  useEffect(() => {
    const onWelcome = () => setWelcomeOpen(true);
    window.addEventListener("spark:help:welcome", onWelcome);
    return () => window.removeEventListener("spark:help:welcome", onWelcome);
  }, []);

  // Help → About / Documentation / Release Notes / Report Issue. Links
  // leave the app: the host hands them to the OS opener, a browser tab
  // opens them in a new tab.
  useEffect(() => {
    const openUrl = (url: string) => {
      if (!isTauri) { window.open(url, "_blank", "noopener"); return; }
      openWithOS(url).catch(() => toast.error("Could not open link", url));
    };
    const onAbout = () => {
      void getRuntimeVersion().then((v) => toast.info(`sparkBook v${v ?? APP_VERSION}`));
    };
    const onDocs = () => openUrl(REPO_URL);
    const onNotes = () => openUrl(`${REPO_URL}/releases`);
    const onIssue = () => openUrl(`${REPO_URL}/issues/new`);
    window.addEventListener("spark:help:about", onAbout);
    window.addEventListener("spark:help:docs", onDocs);
    window.addEventListener("spark:help:releaseNotes", onNotes);
    window.addEventListener("spark:help:reportIssue", onIssue);
    return () => {
      window.removeEventListener("spark:help:about", onAbout);
      window.removeEventListener("spark:help:docs", onDocs);
      window.removeEventListener("spark:help:releaseNotes", onNotes);
      window.removeEventListener("spark:help:reportIssue", onIssue);
    };
  }, [toast]);

  // Window → Minimize / Maximize. Same calls as the title bar buttons;
  // a browser tab has no window to drive, so both are no-ops there.
  useEffect(() => {
    if (!isTauri) return;
    const onMin = () => {
      try { getCurrentWindow().minimize().catch(() => {}); } catch { /* window metadata missing */ }
    };
    const onMax = async () => {
      try {
        const w = getCurrentWindow();
        if (await w.isMaximized()) await w.unmaximize();
        else await w.maximize();
      } catch { /* window metadata missing */ }
    };
    window.addEventListener("spark:window:minimize", onMin);
    window.addEventListener("spark:window:maximize", onMax);
    return () => {
      window.removeEventListener("spark:window:minimize", onMin);
      window.removeEventListener("spark:window:maximize", onMax);
    };
  }, []);

  // View → Zoom. The saved level is applied once on mount.
  useEffect(() => {
    restoreZoom();
    window.addEventListener("spark:view:zoom:in", zoomIn);
    window.addEventListener("spark:view:zoom:out", zoomOut);
    window.addEventListener("spark:view:zoom:reset", zoomReset);
    return () => {
      window.removeEventListener("spark:view:zoom:in", zoomIn);
      window.removeEventListener("spark:view:zoom:out", zoomOut);
      window.removeEventListener("spark:view:zoom:reset", zoomReset);
    };
  }, []);

  // Folder open: this is also the project-switch path, so the outgoing
  // project's workspace is flushed before anything is torn down, and the
  // incoming one is restored from its own snapshot.
  useEffect(() => {
    const onFolderOpen = (e: Event) => {
      const path = (e as CustomEvent<{ path: string | null }>).detail?.path ?? null;
      const detail = (e as CustomEvent<{ projectId?: string }>).detail;
      if (!path && !detail?.projectId) return;

      const targetId = detail?.projectId ?? projectId(path);
      if (targetId === useProjects.getState().activeId) {
        // Re-opening the folder already in front: just re-root the tree.
        if (path) void useExplorer.getState().setRoot(path);
        return;
      }

      void (async () => {
        // A remembered folder that was deleted or unmounted since: say
        // so and stay put. Switching anyway tore down the open project
        // and left the tree spinning on a directory that is not there.
        if (path) {
          const ok = await stat(path).then((st) => st.isDir, () => false);
          if (!ok) {
            toast.error("Folder not found", `${path} no longer exists. Remove it from the project list if it is gone for good.`);
            return;
          }
        }
        flushWorkspace();
        await flushCheckpoint();
        teardownAutosave?.();
        teardownAutosave = null;

        // Close every tab before switching; the outgoing snapshot is
        // already saved, and leaving them open would leak one project's
        // files into the next.
        const docs = useDocs.getState();
        for (const id of [...docs.order]) docs.close(id);
        // Same for the shells: a terminal rooted in the old project is the
        // same leak, and autosave would write it into the new snapshot.
        useTerminal.getState().reset();

        const project = useProjects.getState().openProject(path);
        setCurrentRoot(project.rootPath);

        const ws = project.workspace;
        // A project opened for the first time has an empty snapshot, so
        // fall back to simply rooting the tree at the chosen folder.
        if (ws.tabs.length === 0 && !ws.explorer.root && path) {
          await useExplorer.getState().setRoot(path);
        } else {
          const result = await restoreWorkspace(ws);
          if (result.missing.length > 0) {
            toast.info(
              `${result.missing.length} file${result.missing.length === 1 ? "" : "s"} could not be reopened`,
            );
          }
        }
        teardownAutosave = startWorkspaceAutosave();
        // Autosave only fires on a *subsequent* store change, so without
        // this the newly-rooted project would sit in the cache with a
        // null root until the user happened to touch something.
        flushWorkspace();
      })();
    };
    window.addEventListener("spark:folder:open", onFolderOpen);
    return () => window.removeEventListener("spark:folder:open", onFolderOpen);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Close the active project: keep its snapshot, drop it from the front.
  useEffect(() => {
    const onCloseProject = () => {
      flushWorkspace();
      void flushCheckpoint();
      teardownAutosave?.();
      teardownAutosave = null;
      const docs = useDocs.getState();
      for (const id of [...docs.order]) docs.close(id);
      useTerminal.getState().reset();
      void useExplorer.getState().setRoot("/");
      useExplorer.setState({ root: null, explicitRoot: false, expanded: new Set<string>() });
      useProjects.getState().clearActive();
      setCurrentRoot(null);
      teardownAutosave = startWorkspaceAutosave();
    };
    window.addEventListener("spark:project:close", onCloseProject);
    return () => window.removeEventListener("spark:project:close", onCloseProject);
  }, []);

  const activeDoc = active ? docs[active] : null;

  const projectList = useProjects((s) => s.projects);
  const activeProjectId = useProjects((s) => s.activeId);
  const activeProject = projectList.find((p) => p.id === activeProjectId) ?? null;

  const explorerRoot = useExplorer((s) => s.root);
  const explicitRoot = useExplorer((s) => s.explicitRoot);
  useEffect(() => {
    // Restore owns the root while it runs. setRoot already sets
    // explicitRoot, so this is belt-and-braces against a future reorder
    // of the restore steps.
    if (isRestoring()) return;
    if (explicitRoot) return;
    if (explorerRoot) return;
    const path = activeDoc?.path;
    if (!path) return;
    const parent = path.split(/[\\/]/).slice(0, -1).join("/") || "/";
    void useExplorer.getState().setRoot(parent);
  }, [explicitRoot, explorerRoot, activeDoc?.path]);

  const tabList = order.map((id) => {
    const d = docs[id];
    return {
      id,
      label: d.name + (d.dirty ? "" : ""),
      icon: MODE_ICON[d.mode] ?? "mode-code",
      dirty: d.dirty,
      closable: true,
    };
  });

  return (
    <div className="app" data-theme-resolved={resolved}>
      <TitleBar
        title={activeDoc?.name || "Untitled"}
        dirty={activeDoc?.dirty}
        platform={isTauri ? (navigator.userAgent.includes("Mac") ? "macos" : "windows") : "windows"}
      />

      <MenuBar commands={commands} hasActiveDoc={!!activeDoc} />

      <div className="app__rail">
        <PluginRail />
      </div>

      <AnimatePresence initial={false}>
        {!sidebar.collapsed && (
          <motion.aside
            key="sidebar"
            ref={sidebar.paneRef as React.Ref<HTMLElement>}
            className="app__sidebar"
            style={{ width: sidebar.width }}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            // Width is driven by the drag, so animating it here would fight
            // the pointer. Only opacity animates.
            transition={{ duration: sidebar.dragging ? 0 : 0.18, ease: [0.2, 0.6, 0.3, 1] }}
          >
            <SideBar
              recents={recents}
              onOpen={async (path) => {
                try {
                  await openPath(path);
                } catch (e: any) {
                  toast.error("Open failed", e?.kind || "Unknown error");
                }
              }}
              activePath={activeDoc?.path || undefined}
              onRequestOpenFolder={() => {
                window.dispatchEvent(new CustomEvent("spark:command", { detail: { id: "file.openFolder" } }));
              }}
              onInfo={(msg) => toast.info(msg)}
              onError={(title, detail) => toast.error(title, detail)}
              onCollapse={() => sidebar.setCollapsed(true)}
            />
          </motion.aside>
        )}
      </AnimatePresence>

      <div
        className={`app__sidebar-resizer ${sidebar.dragging ? "is-dragging" : ""} ${
          sidebar.collapsed ? "is-collapsed" : ""
        }`}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize explorer"
        aria-valuenow={sidebar.collapsed ? 0 : sidebar.width}
        aria-valuemin={0}
        aria-valuemax={SIDEBAR_MAX}
        tabIndex={0}
        onPointerDown={sidebar.startResize}
        onKeyDown={sidebar.onHandleKeyDown}
        onDoubleClick={sidebar.reset}
        title={
          sidebar.collapsed
            ? "Drag or press Enter to show the explorer"
            : "Drag to resize · double-click to reset · Enter to hide"
        }
      >
        <span className="app__sidebar-resizer-grip" aria-hidden />
        {sidebar.collapsed && (
          <button
            type="button"
            className="app__sidebar-reveal"
            aria-label="Show explorer"
            title="Show explorer (Ctrl+B)"
            /* The button sits inside the resize handle, whose
               pointerdown starts a drag and captures the pointer — which
               retargets everything that follows away from the button, so
               its click never arrived and "show explorer" did nothing.
               Keep the press to the button. */
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => sidebar.setCollapsed(false)}
          >
            <Icon name="sidebar-toggle" size={14} />
          </button>
        )}
      </div>

      <SplashScreen ready={bootReady} />

      <main className="app__main">
        {order.length > 0 ? (
          <>
            <Tabs
              tabs={tabList}
              activeId={active || ""}
              onSelect={setActive}
              onClose={(id) => { window.dispatchEvent(new CustomEvent("spark:tab:close:request", { detail: { id } })); }}
            />
            <div className="app__editor">
              <AnimatePresence mode="wait">
                {activeDoc && (
                  <motion.div
                    key={activeDoc.id + activeDoc.mode}
                    className="app__editor-inner"
                    initial={{ opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -2 }}
                    transition={{ duration: 0.14 }}
                  >
                    {activeDoc.mode === "markdown" && <MarkdownEditor docId={activeDoc.id} />}
                    {activeDoc.mode === "rich"     && <RichEditor     docId={activeDoc.id} />}
                    {activeDoc.mode === "html"     && <HtmlPreview    docId={activeDoc.id} />}
                    {activeDoc.mode === "svg"      && <SvgEditor      docId={activeDoc.id} />}
                    {activeDoc.mode === "code"     && <CodeEditor     docId={activeDoc.id} />}
                    {(activeDoc.mode === "image" || activeDoc.mode === "imageedit"
                      || activeDoc.mode === "animation" || activeDoc.mode === "pdf"
                      || activeDoc.mode === "video" || activeDoc.mode === "audio") && (
                      <Suspense fallback={<div className="app__surface-loading">Loading surface…</div>}>
                        {activeDoc.mode === "image"     && <ImageViewer      docId={activeDoc.id} />}
                        {activeDoc.mode === "imageedit" && <ImageEditor      docId={activeDoc.id} />}
                        {activeDoc.mode === "animation" && <AnimationBuilder docId={activeDoc.id} />}
                        {activeDoc.mode === "pdf"       && <PdfReader        docId={activeDoc.id} />}
                        {(activeDoc.mode === "video" || activeDoc.mode === "audio") && <MediaPlayer docId={activeDoc.id} />}
                      </Suspense>
                    )}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </>
        ) : (
          <OnboardingScreen
            recents={recents}
            projects={projectList.map((p) => ({
              id: p.id,
              name: p.name,
              rootPath: p.rootPath,
              tabCount: p.workspace.tabs.length,
            }))}
            projectName={activeProject?.name}
            onOpenProject={(id) => {
              const p = useProjects.getState().get(id);
              if (!p) return;
              window.dispatchEvent(
                new CustomEvent("spark:folder:open", { detail: { path: p.rootPath, projectId: p.id } }),
              );
            }}
            onSwitchProject={() => runCommand("project.switch")}
            onOpenFolder={() => runCommand("file.openFolder")}
            onOpenFile={() => runCommand("file.open")}
            onOpenRecent={async (path) => {
              try {
                await openPath(path);
              } catch (e: any) {
                toast.error("Open failed", e?.kind || "Unknown error");
              }
            }}
            onPalette={() => runCommand("view.commandPalette")}
          />
        )}
      </main>

      <AnimatePresence>
        {showStatus && activeDoc && (
          <motion.div
            key="status"
            className="app__status-wrap"
            initial={{ y: 24, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 24, opacity: 0 }}
            transition={{ duration: 0.18, ease: [0.2, 0.6, 0.3, 1] }}
          >
            <StatusBar
              mode={activeDoc.mode}
              language={activeDoc.language}
              line={activeDoc.cursor.line}
              col={activeDoc.cursor.col}
              dirty={activeDoc.dirty}
              modes={switchableModes(activeDoc)}
              onModeSelect={(m) => useDocs.getState().setMode(activeDoc.id, m)}
            />
          </motion.div>
        )}
      </AnimatePresence>

      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        commands={commands}
      />
      <WelcomeWizard open={welcomeOpen} onOpenChange={setWelcomeOpen} />
      <OpenDialog />
      <ProjectSwitcher />
      <ProjectPicker />
      <SaveAsModal
        open={saveAsOpen}
        onOpenChange={(o) => {
          setSaveAsOpen(o);
          if (!o) { setSaveAsError(null); setSaveAsDocId(null); }
        }}
        currentName={saveAsDocId ? (docs[saveAsDocId]?.name ?? "Untitled") : "Untitled"}
        currentPath={saveAsDocId ? (docs[saveAsDocId]?.path ?? null) : null}
        busy={saveAsBusy}
        errorMessage={saveAsError}
        onConfirm={async (path) => {
          if (!saveAsDocId) return;
          setSaveAsBusy(true);
          setSaveAsError(null);
          const result = await useDocs.getState().saveDocumentAs(saveAsDocId, { defaultPath: path });
          setSaveAsBusy(false);
          if (result.ok) {
            toast.success("File saved");
            setSaveAsOpen(false);
            if (pendingCloseRef.current) {
              const fn = pendingCloseRef.current;
              pendingCloseRef.current = null;
              fn();
            }
          } else if (result.reason === "cancelled") {
            // user closed native dialog with cancel; leave modal open
          } else {
            setSaveAsError(result.error instanceof Error ? result.error.message : String(result.error ?? "Unknown error"));
          }
        }}
      />
      <UnsavedChangesModal
        open={unsavedOpen}
        onOpenChange={(o) => {
          if (!unsavedBusy) {
            setUnsavedOpen(o);
            if (!o) { setUnsavedDocId(null); setUnsavedError(null); pendingCloseRef.current = null; }
          }
        }}
        documentName={unsavedDocId ? (docs[unsavedDocId]?.name ?? "Untitled") : "Untitled"}
        context={unsavedContext}
        busy={unsavedBusy}
        errorMessage={unsavedError}
        onChoose={async (choice: UnsavedChoice) => {
          const id = unsavedDocId;
          if (!id) return;
          if (choice === "cancel") {
            setUnsavedOpen(false);
            pendingCloseRef.current = null;
            return;
          }
          if (choice === "discard") {
            setUnsavedOpen(false);
            const fn = pendingCloseRef.current;
            pendingCloseRef.current = null;
            if (fn) fn();
            return;
          }
          // "save"
          const doc = useDocs.getState().docs[id];
          if (!doc) { setUnsavedOpen(false); return; }
          setUnsavedBusy(true);
          setUnsavedError(null);
          if (!doc.path) {
            setUnsavedBusy(false);
            setUnsavedOpen(false);
            setSaveAsDocId(id);
            setSaveAsError(null);
            setSaveAsOpen(true);
            return;
          }
          const result = await useDocs.getState().saveDocument(id);
          setUnsavedBusy(false);
          if (result.ok) {
            toast.success("File saved");
            setUnsavedOpen(false);
            const fn = pendingCloseRef.current;
            pendingCloseRef.current = null;
            if (fn) fn();
          } else {
            setUnsavedError(result.error instanceof Error ? result.error.message : String(result.error ?? "Unknown error"));
          }
        }}
      />
    </div>
  );
}

function isMac() {
  return typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
}

function isTerminalWindow(): boolean {
  try {
    return new URLSearchParams(window.location.search).has("terminal");
  } catch {
    return false;
  }
}

/* Declared at module scope. Calling React.lazy() inside a component body
   builds a NEW lazy type on every render, which React treats as a
   different component: the terminal would unmount, remount and kill its
   shell on each parent update. */
const TerminalStandaloneInner = lazy(() =>
  import("@shell/TerminalPanel").then((m) => ({ default: m.TerminalStandaloneInner })),
);
type PoppedTab = import("@shell/TerminalPanel").PoppedTab;

/** The panel's tabs as the pop-out URL carries them; garbage is no tabs. */
function parsePoppedTabs(raw: string | null): PoppedTab[] | undefined {
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return undefined;
    const tabs = parsed.filter(
      (t): t is PoppedTab => typeof t?.cwd === "string" && typeof t?.label === "string",
    );
    return tabs.length
      ? tabs.map((t) => ({
          cwd: t.cwd,
          label: t.label,
          privilege: t.privilege === "root" ? "root" : "user",
          adopt: typeof t.adopt === "string" ? t.adopt : undefined,
        }))
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Terminal-only window (`index.html?terminal=1`), opened as a separate
 * OS window. The session runs in the Rust host, so the cwd it was opened
 * with is all this view needs: each tab keeps the directory it spawned
 * in, and "+" starts beside the active one.
 */
function TerminalStandalone() {
  const params = new URLSearchParams(window.location.search);
  const cwd = params.get("cwd") || "/";
  const initialPrivilege = params.get("privilege") === "root" ? "root" : "user";
  const initialMobile = params.get("mobile") === "1";
  const tabs = parsePoppedTabs(params.get("tabs"));
  const activeIndex = Number(params.get("active") ?? 0) || 0;

  /* This window has its own store instance, so it hydrates settings for
     itself and then follows the main window over the same broadcast. */
  useEffect(() => hydrateSettings(), []);

  return (
    <Suspense
      fallback={
        <div style={{ padding: 12, color: "var(--text-muted)", background: "var(--term-bg)", height: "100vh" }}>
          Loading terminal…
        </div>
      }
    >
      <TerminalStandaloneInner
        cwd={cwd}
        privilege={initialPrivilege}
        initialMobile={initialMobile}
        tabs={tabs}
        activeIndex={activeIndex}
      />
    </Suspense>
  );
}

export default function App() {
  if (isTerminalWindow()) {
    return (
      <ThemeProvider>
        <TerminalStandalone />
      </ThemeProvider>
    );
  }
  return (
    <ThemeProvider>
      <ToastProvider>
        <Shell />
      </ToastProvider>
    </ThemeProvider>
  );
}
