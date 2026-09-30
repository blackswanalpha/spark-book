/* ============================================================
   sparkBook · src/shell/projects/CreateDialogs.tsx

   New Project and Clone Repository, the two ways the Projects window
   makes a project that does not exist yet. Both end by handing the
   new folder back; opening it is the window's job.

   A running clone holds its dialog open: Escape, the close button and
   the backdrop do nothing until it finishes or is cancelled, so a
   clone can never be orphaned behind a dialog that has gone.
   ============================================================ */
import { useEffect, useRef, useState } from "react";
import { Dialog, DialogFooter } from "@ui/Dialog";
import { Input } from "@ui/Input";
import { Button } from "@ui/Button";
import { hostErrorMessage, isTauriHost } from "@bridge/checkpoint";
import {
  joinPath,
  openFolderDialog,
  projectClone,
  projectCloneCancel,
  projectCreate,
} from "@bridge/commands";
import { folderNameProblem, repoName } from "./model";

const CLONE_PROGRESS_EVENT = "project://clone-progress";

function LocationField({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  return (
    <div className="pwd__row">
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label="Location"
        spellCheck={false}
        disabled={disabled}
      />
      <Button
        type="button"
        variant="secondary"
        disabled={disabled}
        onClick={async () => {
          const picked = await openFolderDialog();
          if (picked) onChange(picked);
        }}
      >
        Browse…
      </Button>
    </div>
  );
}

function locationProblem(loc: string): string | null {
  const l = loc.trim();
  if (!l) return "Choose a location.";
  if (!(l.startsWith("/") || /^[A-Za-z]:[\\/]/.test(l) || l.startsWith("\\\\"))) {
    return "The location must be a full path.";
  }
  return null;
}

/* ---------- New Project ---------- */

export function NewProjectDialog({
  open,
  onOpenChange,
  defaultLocation,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultLocation: string;
  onCreated: (path: string) => void;
}) {
  const [name, setName] = useState("");
  const [location, setLocation] = useState(defaultLocation);
  const [git, setGit] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName("");
    setLocation(defaultLocation);
    setError(null);
    setTouched(false);
    setBusy(false);
  }, [open, defaultLocation]);

  const problem = folderNameProblem(name) ?? locationProblem(location);
  const target = !folderNameProblem(name) && !locationProblem(location) ? joinPath(location.trim(), name.trim()) : null;

  const submit = async () => {
    setTouched(true);
    if (problem || busy) return;
    setBusy(true);
    setError(null);
    try {
      const made = await projectCreate(location.trim(), name.trim(), git);
      if (made.gitError) {
        window.dispatchEvent(
          new CustomEvent("spark:toast:info", {
            detail: { title: "Folder created without a Git repository", body: made.gitError },
          }),
        );
      }
      onOpenChange(false);
      onCreated(made.path);
    } catch (e) {
      setError(hostErrorMessage(e));
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !busy && onOpenChange(o)}
      title="New Project"
      description="Creates an empty folder and opens it as a project."
      size="md"
    >
      <form
        className="pwd"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label className="pwd__label" htmlFor="pwd-name">Name</label>
        <Input
          id="pwd-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="my-project"
          autoFocus
          spellCheck={false}
          invalid={touched && Boolean(folderNameProblem(name))}
          disabled={busy}
        />
        <span className="pwd__label">Location</span>
        <LocationField value={location} onChange={setLocation} disabled={busy} />
        <label className="pwd__check">
          <input type="checkbox" checked={git} onChange={(e) => setGit(e.target.checked)} disabled={busy} />
          Create a Git repository
        </label>
        <p className="pwd__hint" aria-live="polite">
          {touched && problem ? <span className="pwd__err">{problem}</span> : target ? <>Will create <code>{target}</code></> : " "}
        </p>
        {error && <p className="pwd__err" role="alert">{error}</p>}
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          <Button type="submit" variant="primary" loading={busy} disabled={busy || (touched && Boolean(problem))}>
            Create
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

/* ---------- Clone ---------- */

export function CloneDialog({
  open,
  onOpenChange,
  defaultLocation,
  onCloned,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultLocation: string;
  onCloned: (path: string) => void;
}) {
  const [url, setUrl] = useState("");
  const [location, setLocation] = useState(defaultLocation);
  const [name, setName] = useState("");
  /** True once the user typed a folder name; the URL stops overwriting it. */
  const [nameEdited, setNameEdited] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const cancelling = useRef(false);

  useEffect(() => {
    if (!open) return;
    setUrl("");
    setName("");
    setNameEdited(false);
    setLocation(defaultLocation);
    setError(null);
    setProgress("");
    setTouched(false);
    setBusy(false);
  }, [open, defaultLocation]);

  useEffect(() => {
    if (!nameEdited) setName(repoName(url));
  }, [url, nameEdited]);

  // Progress lines only while a clone runs; the listener goes with it.
  useEffect(() => {
    if (!busy || !isTauriHost) return;
    let off: (() => void) | null = null;
    let disposed = false;
    void import("@tauri-apps/api/webviewWindow")
      .then(({ getCurrentWebviewWindow }) =>
        getCurrentWebviewWindow().listen<string>(CLONE_PROGRESS_EVENT, (e) => setProgress(String(e.payload))),
      )
      .then((un) => (disposed ? un() : (off = un)), () => {});
    return () => {
      disposed = true;
      off?.();
    };
  }, [busy]);

  const urlProblem = url.trim() ? (/\s/.test(url.trim()) || url.trim().startsWith("-") ? "That is not a repository URL." : null) : "Enter a repository URL.";
  const problem = urlProblem ?? folderNameProblem(name) ?? locationProblem(location);
  const target = !folderNameProblem(name) && !locationProblem(location) ? joinPath(location.trim(), name.trim()) : null;

  const submit = async () => {
    setTouched(true);
    if (problem || busy) return;
    setBusy(true);
    setError(null);
    setProgress("Starting…");
    cancelling.current = false;
    try {
      const path = await projectClone(url.trim(), location.trim(), name.trim());
      setBusy(false);
      onOpenChange(false);
      onCloned(path);
    } catch (e) {
      const msg = hostErrorMessage(e);
      setBusy(false);
      setProgress("");
      if (!(cancelling.current && msg === "cancelled")) setError(msg);
    }
  };

  const cancel = () => {
    if (busy) {
      cancelling.current = true;
      setProgress("Cancelling…");
      void projectCloneCancel();
    } else {
      onOpenChange(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !busy && onOpenChange(o)}
      title="Clone Repository"
      description="Clones with the Git on this machine, then opens the folder as a project."
      size="md"
    >
      <form
        className="pwd"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label className="pwd__label" htmlFor="pwd-url">Repository URL</label>
        <Input
          id="pwd-url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://github.com/owner/repo.git"
          autoFocus
          spellCheck={false}
          invalid={touched && Boolean(urlProblem)}
          disabled={busy}
        />
        <span className="pwd__label">Location</span>
        <LocationField value={location} onChange={setLocation} disabled={busy} />
        <label className="pwd__label" htmlFor="pwd-dir">Folder name</label>
        <Input
          id="pwd-dir"
          value={name}
          onChange={(e) => {
            setNameEdited(true);
            setName(e.target.value);
          }}
          spellCheck={false}
          invalid={touched && Boolean(folderNameProblem(name))}
          disabled={busy}
        />
        <p className="pwd__hint" aria-live="polite">
          {busy ? (
            <span className="pwd__progress">{progress}</span>
          ) : touched && problem ? (
            <span className="pwd__err">{problem}</span>
          ) : target ? (
            <>Will clone into <code>{target}</code></>
          ) : (
            " "
          )}
        </p>
        {error && <pre className="pwd__err pwd__errBlock" role="alert">{error}</pre>}
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={cancel}>
            {busy ? "Cancel clone" : "Cancel"}
          </Button>
          <Button type="submit" variant="primary" loading={busy} disabled={busy || (touched && Boolean(problem))}>
            Clone
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
