/* ============================================================
   sparkBook · src/shell/MenuBar.tsx
   In-window menu bar that lives directly below TitleBar.
   Renders a horizontal row of top-level menus (File, Edit,
   Selection, View, Format, Window, Help) with dropdowns
   populated from the central CommandSpec registry.

   Behaviour:
     • Click a top-level to open / close its dropdown.
     • Hovering another top-level while open switches dropdown
       (with a 100 ms grace period to avoid diagonal flicker).
     • Click outside closes the active dropdown.
     • Full keyboard support: Esc, ↑/↓, ←/→, Enter, Space, and
       Alt+<letter> mnemonics (top-level + item jump).
     • Dispatches every command through the same "spark:command"
       CustomEvent channel App.tsx listens to, then closes the
       dropdown and shows a toast.
     • Uses theme tokens, motion primitives, Icon, KbdChord.
     • data-tauri-drag-region={false} so it does NOT trigger
       Tauri window drag (TitleBar handles its own drag region).
   ============================================================ */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence, popoverVariants, staggerItem, staggerParent } from "@motion/index";
import { Icon } from "@ui/Icon";
import { KbdChord } from "@ui/Kbd";
import { useToast } from "@ui/Toast";
import type { CommandSpec } from "@commands/registry";
import "./MenuBar.css";

export interface MenuBarProps {
  commands: CommandSpec[];
  hasActiveDoc?: boolean;
}

interface TopLevel {
  id: string;
  label: string;
  mnemonic: string;            // single letter (uppercased) bound to Alt
  items: CommandSpec[];
}

const TOP_LEVEL_ORDER: { id: string; label: string; mnemonic: string }[] = [
  { id: "File",      label: "File",      mnemonic: "F" },
  { id: "Edit",      label: "Edit",      mnemonic: "E" },
  { id: "Selection", label: "Selection", mnemonic: "S" },
  { id: "View",      label: "View",      mnemonic: "V" },
  { id: "Terminal",  label: "Terminal",  mnemonic: "T" },
  { id: "Format",    label: "Format",    mnemonic: "O" }, // "O" used for F**o**rmat (F taken by File)
  { id: "Window",    label: "Window",    mnemonic: "W" },
  { id: "Help",      label: "Help",      mnemonic: "H" },
];

/* Commands that should be disabled when no document is open. */
const DOC_GATED = new Set<string>([
  "file.save",
  "file.saveAs",
  "file.revert",
  "tab.close",
  "edit.undo",
  "edit.redo",
  "edit.find",
  "edit.replace",
  "code.goToLine",
  "code.toggleComment",
  "code.format",
  "selection.selectAll",
  "selection.copyLineUp",
  "selection.copyLineDown",
  "selection.moveLineUp",
  "selection.moveLineDown",
  "view.markdown",
  "view.rich",
  "view.code",
  "view.image",
  "view.imageEdit",
  "view.switchMode",
  "view.togglePreview",
  "view.toggleWordWrap",
  "format.bold",
  "format.italic",
  "format.inlineCode",
  "format.link",
  "format.headingPromote",
  "format.headingDemote",
  "format.listBullet",
  "format.listNumber",
  "format.quote",
]);

/* Commands whose own run() does the talking — MenuBar should not
   also pop a toast. Keeps the UI quiet for self-explanatory ones. */
const SILENT_COMMANDS = new Set<string>([
  "project.switch",
  "project.close",
  "project.quickOpen",
  "project.findInFiles",
  "project.runTask",
  "project.rerunTask",
  "project.togglePin",
  "terminal.next",
  "terminal.prev",
  "terminal.rename",
  "terminal.close",
  "file.recent",
  "help.about",
  "help.docs",
  "help.releaseNotes",
  "help.reportIssue",
]);

export function MenuBar({ commands, hasActiveDoc = true }: MenuBarProps) {
  const toast = useToast();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const topRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const itemRefs = useRef<Array<Array<HTMLButtonElement | null>>>([]);
  const hoverTimer = useRef<number | null>(null);

  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const [highlight, setHighlight] = useState<number>(0);

  /* Group commands by category in the fixed top-level order. */
  const topLevels = useMemo<TopLevel[]>(() => {
    const byCat = new Map<string, CommandSpec[]>();
    for (const c of commands) {
      if (!c.category) continue;
      const list = byCat.get(c.category) ?? [];
      list.push(c);
      byCat.set(c.category, list);
    }
    return TOP_LEVEL_ORDER
      .map((tl) => ({ ...tl, items: byCat.get(tl.id) ?? [] }))
      .filter((tl) => tl.items.length > 0);
  }, [commands]);

  const isDisabled = useCallback(
    (cmd: CommandSpec) => DOC_GATED.has(cmd.id) && !hasActiveDoc,
    [hasActiveDoc],
  );

  /* ---- open / close helpers ---- */
  const closeMenu = useCallback((returnFocus = false) => {
    const idx = openIndex;
    setOpenIndex(null);
    setHighlight(0);
    if (returnFocus && idx != null) {
      topRefs.current[idx]?.focus();
    }
  }, [openIndex]);

  const openMenu = useCallback((index: number) => {
    setOpenIndex(index);
    setHighlight(0);
  }, []);

  const toggleMenu = useCallback((index: number) => {
    setOpenIndex((cur) => (cur === index ? null : index));
    setHighlight(0);
  }, []);

  const invoke = useCallback((cmd: CommandSpec) => {
    if (isDisabled(cmd)) return;
    window.dispatchEvent(new CustomEvent("spark:command", { detail: { id: cmd.id } }));
    if (!SILENT_COMMANDS.has(cmd.id)) {
      const cat = cmd.category ?? "";
      toast.info(`${cat} → ${cmd.title}`, "Command dispatched");
    }
    closeMenu();
  }, [closeMenu, isDisabled, toast]);

  /* ---- hover-to-switch with grace period ---- */
  const scheduleHoverSwitch = useCallback((index: number) => {
    if (hoverTimer.current != null) {
      window.clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }
    if (openIndex == null || openIndex === index) return;
    hoverTimer.current = window.setTimeout(() => {
      openMenu(index);
    }, 100);
  }, [openIndex, openMenu]);

  const cancelHoverSwitch = useCallback(() => {
    if (hoverTimer.current != null) {
      window.clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }
  }, []);

  /* ---- click outside ---- */
  useEffect(() => {
    if (openIndex == null) return;
    const onDocPointer = (e: MouseEvent) => {
      const root = rootRef.current;
      if (!root) return;
      if (e.target instanceof Node && !root.contains(e.target)) {
        setOpenIndex(null);
        setHighlight(0);
      }
    };
    window.addEventListener("mousedown", onDocPointer);
    return () => window.removeEventListener("mousedown", onDocPointer);
  }, [openIndex]);

  /* ---- Alt+<letter> global handler (only when no menu is open) ---- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      if (openIndex != null) return; // handled by menu-level keydown
      const key = e.key.toUpperCase();
      const idx = topLevels.findIndex((tl) => tl.mnemonic === key);
      if (idx >= 0) {
        e.preventDefault();
        topRefs.current[idx]?.focus();
        openMenu(idx);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openMenu, topLevels, openIndex]);

  /* Cleanup any pending hover timer. */
  useEffect(() => () => {
    if (hoverTimer.current != null) window.clearTimeout(hoverTimer.current);
  }, []);

  return (
    <div
      ref={rootRef}
      className="menubar app__menubar"
      role="menubar"
      aria-label="Application menu"
      data-tauri-drag-region={false}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <ul className="menubar__list">
        {topLevels.map((tl, ti) => {
          const isOpen = openIndex === ti;
          return (
            <li key={tl.id} className="menubar__cell" role="none">
              <button
                ref={(el) => { topRefs.current[ti] = el; }}
                type="button"
                role="menuitem"
                aria-haspopup="menu"
                aria-expanded={isOpen}
                className={`menubar__top${isOpen ? " menubar__top--active" : ""}`}
                onClick={() => toggleMenu(ti)}
                onMouseEnter={() => scheduleHoverSwitch(ti)}
                onMouseLeave={cancelHoverSwitch}
                onKeyDown={(e) => onTopKeyDown(e, ti)}
              >
                <u>{tl.label.charAt(0)}</u>{tl.label.slice(1)}
              </button>

              <AnimatePresence>
                {isOpen && (
                  <Dropdown
                    key={`dropdown-${tl.id}`}
                    items={tl.items}
                    isDisabled={isDisabled}
                    highlight={highlight}
                    setHighlight={setHighlight}
                    topIndex={ti}
                    onInvoke={invoke}
                    registerItem={(i, el) => {
                      if (!itemRefs.current[ti]) itemRefs.current[ti] = [];
                      itemRefs.current[ti][i] = el;
                    }}
                    onItemKeyDown={onItemKeyDown}
                  />
                )}
              </AnimatePresence>
            </li>
          );
        })}
      </ul>
      <div className="menubar__spacer" />
    </div>
  );

  /* ---- keyboard handlers (defined inline as closures; declared as
     functions outside JSX so we can keep them readable). ---- */
  function onTopKeyDown(e: React.KeyboardEvent<HTMLButtonElement>, index: number) {
    const items = topLevels[index].items;
    switch (e.key) {
      case "ArrowDown":
      case "Enter":
      case " ":
        e.preventDefault();
        openMenu(index);
        // Focus the first item after the dropdown renders.
        requestAnimationFrame(() => {
          itemRefs.current[index]?.[0]?.focus();
        });
        break;
      case "ArrowUp":
        e.preventDefault();
        openMenu(index);
        setHighlight(Math.max(0, items.length - 1));
        requestAnimationFrame(() => {
          itemRefs.current[index]?.[items.length - 1]?.focus();
        });
        break;
      case "ArrowRight": {
        e.preventDefault();
        const next = (index + 1) % topLevels.length;
        topRefs.current[next]?.focus();
        if (openIndex != null) openMenu(next);
        break;
      }
      case "ArrowLeft": {
        e.preventDefault();
        const next = (index - 1 + topLevels.length) % topLevels.length;
        topRefs.current[next]?.focus();
        if (openIndex != null) openMenu(next);
        break;
      }
      case "Escape":
        if (openIndex === index) {
          e.preventDefault();
          closeMenu(true);
        }
        break;
      default:
        if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.key.length === 1) {
          const letter = e.key.toLowerCase();
          const i = items.findIndex((it) => it.title.toLowerCase().startsWith(letter));
          if (i >= 0) {
            e.preventDefault();
            setHighlight(i);
            requestAnimationFrame(() => {
              itemRefs.current[index]?.[i]?.focus();
            });
          }
        }
        break;
    }
  }

  function onItemKeyDown(e: React.KeyboardEvent<HTMLButtonElement>, topIndex: number, itemIndex: number) {
    const items = topLevels[topIndex].items;
    const len = items.length;
    switch (e.key) {
      case "ArrowDown": {
        e.preventDefault();
        const next = (itemIndex + 1) % len;
        setHighlight(next);
        itemRefs.current[topIndex]?.[next]?.focus();
        break;
      }
      case "ArrowUp": {
        e.preventDefault();
        const next = (itemIndex - 1 + len) % len;
        setHighlight(next);
        itemRefs.current[topIndex]?.[next]?.focus();
        break;
      }
      case "ArrowRight": {
        e.preventDefault();
        const next = (topIndex + 1) % topLevels.length;
        topRefs.current[next]?.focus();
        openMenu(next);
        break;
      }
      case "ArrowLeft": {
        e.preventDefault();
        const next = (topIndex - 1 + topLevels.length) % topLevels.length;
        topRefs.current[next]?.focus();
        openMenu(next);
        break;
      }
      case "Enter":
      case " ": {
        e.preventDefault();
        invoke(items[itemIndex]);
        break;
      }
      case "Escape":
        e.preventDefault();
        closeMenu(true);
        break;
      case "Tab":
        // Let Tab move focus naturally and close the menu.
        setOpenIndex(null);
        setHighlight(0);
        break;
      default:
        if (e.key.length === 1) {
          const letter = e.key.toLowerCase();
          const i = items.findIndex((it) => it.title.toLowerCase().startsWith(letter));
          if (i >= 0) {
            e.preventDefault();
            setHighlight(i);
            itemRefs.current[topIndex]?.[i]?.focus();
          }
        }
        break;
    }
  }
}

interface DropdownProps {
  items: CommandSpec[];
  isDisabled: (c: CommandSpec) => boolean;
  highlight: number;
  setHighlight: (i: number) => void;
  topIndex: number;
  onInvoke: (c: CommandSpec) => void;
  registerItem: (i: number, el: HTMLButtonElement | null) => void;
  onItemKeyDown: (e: React.KeyboardEvent<HTMLButtonElement>, topIndex: number, itemIndex: number) => void;
}

function Dropdown({
  items, isDisabled, highlight, setHighlight,
  topIndex, onInvoke, registerItem, onItemKeyDown,
}: DropdownProps) {
  return (
    <motion.ul
      className="menubar__dropdown"
      role="menu"
      variants={popoverVariants}
      initial="initial"
      animate="animate"
      exit="exit"
    >
      <motion.div
        variants={staggerParent(0.02)}
        initial="initial"
        animate="animate"
        exit="exit"
        style={{ display: "contents" }}
      >
        {items.map((cmd, i) => {
          const disabled = isDisabled(cmd);
          return (
            <motion.li
              key={cmd.id}
              role="none"
              variants={staggerItem}
              onMouseEnter={() => setHighlight(i)}
            >
              <button
                ref={(el) => registerItem(i, el)}
                type="button"
                role="menuitem"
                aria-disabled={disabled || undefined}
                className={`menubar__item${highlight === i ? " menubar__item--highlight" : ""}`}
                onClick={() => onInvoke(cmd)}
                onKeyDown={(e) => onItemKeyDown(e, topIndex, i)}
                disabled={disabled}
              >
                {cmd.icon ? (
                  <span className="menubar__item-icon">
                    <Icon name={cmd.icon} size={14} />
                  </span>
                ) : (
                  <span className="menubar__item-icon" aria-hidden />
                )}
                <span className="menubar__item-label">{cmd.title}</span>
                {cmd.shortcut ? (
                  <span className="menubar__item-shortcut">
                    <KbdChord chord={cmd.shortcut} />
                  </span>
                ) : null}
              </button>
            </motion.li>
          );
        })}
      </motion.div>
    </motion.ul>
  );
}
