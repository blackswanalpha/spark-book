/* ============================================================
   sparkBook · src/shell/UnsavedChangesModal.tsx
   Tri-state confirmation shown when a destructive action would
   discard unsaved work. Controlled — the parent owns open state
   and performs the actual save / discard / abort.
   ============================================================ */
import { useCallback, type KeyboardEvent } from "react";
import { Dialog, DialogFooter } from "@ui/Dialog";
import { Button } from "@ui/Button";
import "./UnsavedChangesModal.css";

export type UnsavedChoice = "save" | "discard" | "cancel";

export interface UnsavedChangesModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  documentName: string;
  /** Replaces the one-document sentence, e.g. for several files at once. */
  description?: string;
  /** Label of the save button; "Save" by default. */
  saveLabel?: string;
  context?: string;
  busy?: boolean;
  errorMessage?: string | null;
  onChoose: (choice: UnsavedChoice) => void;
}

export default function UnsavedChangesModal({
  open,
  onOpenChange,
  documentName,
  description: descriptionOverride,
  saveLabel = "Save",
  context,
  busy = false,
  errorMessage = null,
  onChoose,
}: UnsavedChangesModalProps) {
  const handleSave = useCallback(() => {
    if (busy) return;
    onChoose("save");
  }, [busy, onChoose]);

  const handleDiscard = useCallback(() => {
    if (busy) return;
    onChoose("discard");
  }, [busy, onChoose]);

  const handleCancel = useCallback(() => {
    if (busy) return;
    onChoose("cancel");
  }, [busy, onChoose]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      if (busy) return;
      if (e.key === "Enter") {
        e.preventDefault();
        handleSave();
      }
    },
    [busy, handleSave],
  );

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next && busy) return;
      if (!next) onChoose("cancel");
      onOpenChange(next);
    },
    [busy, onChoose, onOpenChange],
  );

  const description = descriptionOverride ?? `You have unsaved changes in “${documentName}”.`;

  return (
    <Dialog
      open={open}
      onOpenChange={handleOpenChange}
      title="Unsaved changes"
      description={description}
      size="sm"
    >
      <div className="unsaved" onKeyDown={handleKeyDown}>
        {context && <p className="unsaved__context">{context}</p>}

        {errorMessage && (
          <p className="unsaved__error" role="alert">
            {errorMessage}
          </p>
        )}
      </div>

      <DialogFooter>
        <Button variant="ghost" onClick={handleCancel} disabled={busy}>
          Cancel
        </Button>
        <Button variant="danger" onClick={handleDiscard} disabled={busy}>
          Don’t Save
        </Button>
        <Button
          variant="primary"
          icon="save"
          onClick={handleSave}
          disabled={busy}
          loading={busy}
          autoFocus
        >
          {saveLabel}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
