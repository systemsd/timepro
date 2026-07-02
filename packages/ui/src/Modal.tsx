import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Button } from './Button';
import { CloseIcon } from './icons';

const FOCUSABLE =
  'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children?: ReactNode;
  footer?: ReactNode;
  width?: number;
}

/**
 * Accessible dialog: role=dialog + aria-modal, labelled by its title, with a
 * focus trap, Escape-to-close, backdrop-click close, body-scroll lock, and focus
 * restored to the trigger on close.
 */
export function Modal({ open, onClose, title, children, footer, width = 440 }: ModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const prevFocus = useRef<HTMLElement | null>(null);
  const titleId = useId();

  useEffect(() => {
    if (!open) return;
    prevFocus.current = document.activeElement as HTMLElement | null;
    const el = dialogRef.current;
    const focusables = (): HTMLElement[] =>
      el
        ? Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
            (f) => !f.hasAttribute('disabled'),
          )
        : [];
    (focusables()[0] ?? el)?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key === 'Tab') {
        const f = focusables();
        if (f.length === 0) {
          e.preventDefault();
          return;
        }
        const first = f[0]!;
        const last = f[f.length - 1]!;
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey, true);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.body.style.overflow = prevOverflow;
      prevFocus.current?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div
      className="ui-modal-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="ui-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        style={{ width }}
        tabIndex={-1}
      >
        <div className="ui-modal-head">
          <h2 id={titleId} className="ui-modal-title">
            {title}
          </h2>
          <button type="button" className="ui-modal-close" aria-label="Close" onClick={onClose}>
            <CloseIcon />
          </button>
        </div>
        <div className="ui-modal-body">{children}</div>
        {footer && <div className="ui-modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

// ---- ConfirmModal: accessible replacement for window.confirm ----

export interface ConfirmModalProps {
  open: boolean;
  title: string;
  message?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmModal({
  open,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger = false,
  onConfirm,
  onCancel,
}: ConfirmModalProps) {
  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={title}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel}>
            {cancelLabel}
          </Button>
          <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {message && <p className="ui-modal-text">{message}</p>}
    </Modal>
  );
}

// ---- PromptModal: accessible replacement for window.prompt (+ optional checkbox) ----

export interface PromptModalProps {
  open: boolean;
  title: string;
  label?: string;
  placeholder?: string;
  initialValue?: string;
  confirmLabel?: string;
  /** When set, renders a checkbox and passes its state to onSubmit. */
  checkboxLabel?: string;
  onSubmit: (value: string, checked: boolean) => void;
  onCancel: () => void;
}

export function PromptModal({
  open,
  title,
  label,
  placeholder,
  initialValue = '',
  confirmLabel = 'Save',
  checkboxLabel,
  onSubmit,
  onCancel,
}: PromptModalProps) {
  const [value, setValue] = useState(initialValue);
  const [checked, setChecked] = useState(false);
  const fieldId = useId();

  // Reset each time the modal opens.
  useEffect(() => {
    if (open) {
      setValue(initialValue);
      setChecked(false);
    }
  }, [open, initialValue]);

  const submit = () => {
    const v = value.trim();
    if (!v) return;
    onSubmit(v, checked);
  };

  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={title}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} disabled={!value.trim()}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {label && (
          <label htmlFor={fieldId} className="ui-field-label">
            {label}
          </label>
        )}
        <input
          id={fieldId}
          className="ui-input"
          placeholder={placeholder}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          autoFocus
        />
        {checkboxLabel && (
          <label className="ui-check">
            <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
            {checkboxLabel}
          </label>
        )}
      </form>
    </Modal>
  );
}
