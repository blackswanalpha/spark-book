/* ============================================================
   sparkBook · src/shell/PluginRail.tsx
   Hairline plugin rail pinned left-of-explorer.
   - 51px wide, icons-only vertical strip
   - Hairline right border (1px solid var(--border))
   - Extensible plugin registry (terminal, then projects)
   - Settings sits alone at the foot of the rail: it is not a
     plugin, and separating it keeps the registry above honest
     as more plugins arrive.
   ============================================================ */
import { useCallback, useEffect, useState } from "react";
import { Icon } from "@ui/Icon";
import { useTerminal } from "@store/terminal";
import "./PluginRail.css";
import { TerminalDialog } from "./TerminalPanel";
import { SettingsDialog } from "./Settings/SettingsDialog";

export type RailId = "terminal" | "projects";

interface PluginDef {
  id: RailId;
  label: string;
  icon: string;
}

const PLUGINS: PluginDef[] = [
  { id: "terminal", label: "Terminal", icon: "terminal" },
  { id: "projects", label: "Projects", icon: "projects" },
];

export function PluginRail() {
  const isOpen = useTerminal((s) => s.isOpen);
  const toggle = useTerminal((s) => s.toggle);
  const open = useTerminal((s) => s.open);
  const close = useTerminal((s) => s.close);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const active: RailId | null = isOpen ? "terminal" : null;

  const onSelect = useCallback((id: RailId) => {
    if (id === "terminal") {
      toggle();
      return;
    }
    if (id === "projects") {
      // Its own OS window, so it is never "active" in this rail.
      window.dispatchEvent(new CustomEvent("spark:command", { detail: { id: "project.manage" } }));
    }
  }, [toggle]);

  /* The palette and menu reach settings through an event rather than
     importing this component, so the dialog has one owner. */
  useEffect(() => {
    const onOpen = () => setSettingsOpen(true);
    window.addEventListener("spark:settings:open", onOpen);
    return () => window.removeEventListener("spark:settings:open", onOpen);
  }, []);

  return (
    <>
      <nav className="plugin-rail" aria-label="Plugins">
        <div className="plugin-rail__inner">
          {PLUGINS.map((p) => (
            <button
              key={p.id}
              type="button"
              className={`plugin-rail__btn ${active === p.id ? "is-active" : ""}`}
              aria-label={p.label}
              aria-pressed={active === p.id}
              title={p.label}
              onClick={() => onSelect(p.id)}
            >
              <Icon name={p.icon} size={18} />
            </button>
          ))}
          <div className="plugin-rail__spacer" aria-hidden />
          <button
            type="button"
            className={`plugin-rail__btn ${settingsOpen ? "is-active" : ""}`}
            aria-label="Settings"
            aria-pressed={settingsOpen}
            title="Settings"
            onClick={() => setSettingsOpen((v) => !v)}
          >
            <Icon name="settings" size={18} />
          </button>
        </div>
      </nav>

      <TerminalDialog open={isOpen} onOpenChange={(o) => { if (o) open(); else close(); }} />
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
    </>
  );
}
