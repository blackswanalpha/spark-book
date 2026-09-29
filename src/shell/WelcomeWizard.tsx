/* ============================================================
   sparkBook · src/shell/WelcomeWizard.tsx
   First-run welcome wizard — 3 steps (intro → theme pick →
   ready), ported from designlabs/labs/onboarding.html.
   Esc skips; focus moves to the primary control of each step
   and returns to the document on close (A11Y-002). The theme
   picked in step 2 applies live via ThemeProvider.
   ============================================================ */
import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence, overlayBackdropVariants, modalVariants } from "@motion/index";
import { useTheme, type ThemeId } from "@theme/ThemeProvider";
import { Button } from "@ui/Button";
import { markOnboarded } from "./firstRun";
import { useAppVersion } from "@version";
import "./WelcomeWizard.css";

const STEP_TITLES = ["Welcome to sparkBook", "Pick a theme", "You're all set"] as const;

const THEME_OPTIONS: { id: ThemeId; label: string; hint: string }[] = [
  { id: "system", label: "System", hint: "Follow the OS appearance" },
  { id: "light", label: "Light", hint: "Bright surfaces" },
  { id: "dark", label: "Dark", hint: "Low-glare surfaces" },
  { id: "navy", label: "Navy", hint: "Deep blue focus" },
  { id: "amber", label: "Amber", hint: "Warm retro CRT" },
  { id: "red", label: "Red", hint: "Crimson night" },
];

export interface WelcomeWizardProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function WelcomeWizard({ open, onOpenChange }: WelcomeWizardProps) {
  const version = useAppVersion();
  const [step, setStep] = useState(0);
  const { theme, setTheme } = useTheme();
  const primaryRef = useRef<HTMLButtonElement>(null);
  const lastFocusedRef = useRef<HTMLElement | null>(null);

  /* Focus the primary control whenever the step (or visibility) changes */
  useEffect(() => {
    if (open) primaryRef.current?.focus();
  }, [open, step]);

  /* Remember focus to restore on close (A11Y-002) */
  useEffect(() => {
    if (open) {
      lastFocusedRef.current = document.activeElement as HTMLElement | null;
      return () => {
        lastFocusedRef.current?.focus?.();
      };
    }
  }, [open]);

  const finish = () => {
    markOnboarded();
    onOpenChange(false);
  };

  /* Esc skips the wizard */
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        finish();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="wizard-overlay"
          variants={overlayBackdropVariants}
          initial="initial"
          animate="animate"
          exit="exit"
          role="dialog"
          aria-modal="true"
          aria-label={STEP_TITLES[step]}
        >
          <motion.div className="wizard" variants={modalVariants} initial="initial" animate="animate" exit="exit">
            <header className="wizard__header">
              <span className="wizard__title">{STEP_TITLES[step]}</span>
              <span className="wizard__dots" aria-hidden>
                {STEP_TITLES.map((_, i) => (
                  <i key={i} className={i <= step ? "is-active" : undefined} />
                ))}
              </span>
              <Button variant="ghost" size="sm" onClick={finish}>
                Skip
              </Button>
            </header>

            {step === 0 && (
              <div className="wizard__step" data-step="intro">
                <img src="/spark-mark.svg" alt="" width={56} height={56} className="wizard__logo" />
                <p className="wizard__lede">
                  One window for notes, documents, code, pictures and PDFs. The file on disk is the source
                  of truth — no proprietary format, no lock-in.
                </p>
                <ul className="wizard__points">
                  <li><strong>Nine surfaces</strong> — markdown, rich text, code, HTML, SVG, image viewer and editor, animation and PDF.</li>
                  <li><strong>File as truth</strong> — everything round-trips through plain files.</li>
                  <li><strong>A real terminal</strong> — shells, TUIs and agents such as Claude Code run in tabs beside your files.</li>
                </ul>
                <div className="wizard__meta">v{version}</div>
              </div>
            )}

            {step === 1 && (
              <div className="wizard__step" data-step="theme">
                <p className="wizard__lede">
                  Choose how sparkBook looks. You can change this any time in the command palette (Theme).
                </p>
                <div className="wizard__themes" role="radiogroup" aria-label="Theme">
                  {THEME_OPTIONS.map((opt) => (
                    <button
                      key={opt.id}
                      type="button"
                      role="radio"
                      aria-checked={theme === opt.id}
                      className={`wizard-theme${theme === opt.id ? " is-selected" : ""}`}
                      data-theme-preview={opt.id}
                      onClick={() => setTheme(opt.id)}
                    >
                      <span className="wizard-theme__swatch" aria-hidden><i /><i /><i /></span>
                      <span className="wizard-theme__label">{opt.label}</span>
                      <span className="wizard-theme__hint">{opt.hint}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {step === 2 && (
              <div className="wizard__step" data-step="ready">
                <img src="/spark-mark.svg" alt="" width={48} height={48} className="wizard__logo" />
                <p className="wizard__lede">
                  You're set. Press <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd> (or <kbd>⌘</kbd>+<kbd>⇧</kbd>+<kbd>P</kbd>)
                  for the command palette, or just start writing.
                </p>
              </div>
            )}

            <footer className="wizard__footer">
              <span className="wizard__spacer" />
              {step > 0 && (
                <Button variant="ghost" onClick={() => setStep((s) => Math.max(0, s - 1))}>
                  Back
                </Button>
              )}
              <Button
                ref={primaryRef as never}
                variant="primary"
                onClick={() => (step < STEP_TITLES.length - 1 ? setStep(step + 1) : finish())}
              >
                {step === STEP_TITLES.length - 1 ? "Start writing" : "Next"}
              </Button>
            </footer>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

