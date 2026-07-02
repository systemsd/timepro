# `@timepro/ui` — UI library catalog

Shared, accessible React primitives for the TimePro web app (and desktop later). **Source-only** — consumers
transpile it (`transpilePackages: ['@timepro/ui']` in `apps/web/next.config.mjs`). Styles ship as a single
`styles.css` the host imports once (`apps/web/src/app/layout.tsx`).

> This catalog grows **with** the library. When you extract a component into `@timepro/ui`, document it here in
> the same PR. Prefer importing from `@timepro/ui` in new code.

## Design-token contract

Components are unstyled beyond referencing CSS custom properties the **host app defines** in its `:root`
(see `apps/web/src/app/globals.css`). A consuming app must provide:

| Token | Purpose |
| --- | --- |
| `--panel`, `--text`, `--muted`, `--muted-2`, `--border` | surfaces + text |
| `--accent`, `--accent-hover`, `--on-accent` | primary action color |
| `--danger`, `--danger-hover` | destructive action color |
| `--radius`, `--radius-sm` | corner radii |
| `--space-1 … --space-5` | spacing scale (4/8/12/16/24px) |
| `--overlay`, `--shadow-modal` | modal backdrop + elevation |

## Components

### `Button`
The single button primitive — a real `<button>` (keyboard + `:focus-visible` for free), `type="button"` by
default so it never accidentally submits a form.
- Props: `variant` (`primary` | `secondary` | `danger` | `ghost`), `size` (`sm` | `md`), plus all native
  button attributes (`onClick`, `disabled`, `title`, …).
- Usage: `<Button variant="primary" onClick={run}>Show report</Button>`

### `Modal`
Accessible dialog: `role="dialog"` + `aria-modal`, labelled by its title, **focus trap**, Escape-to-close,
backdrop-click close, body-scroll lock, and focus restored to the trigger on close.
- Props: `open`, `onClose`, `title`, `children` (body), `footer?`, `width?` (px).
- Nesting: don't render two open Modals at once (their Escape/focus handlers conflict). To chain (e.g. a
  confirm on top of an editor), close the first by toggling its `open` — `<Modal open={!confirming} …>` +
  `<ConfirmModal open={confirming} …>`.

### `ConfirmModal`
Accessible replacement for `window.confirm`.
- Props: `open`, `title`, `message?`, `confirmLabel?`, `cancelLabel?`, `danger?`, `onConfirm`, `onCancel`.

### `PromptModal`
Accessible replacement for `window.prompt` — a single text input, optional checkbox (e.g. "share with org").
- Props: `open`, `title`, `label?`, `placeholder?`, `initialValue?`, `confirmLabel?`, `checkboxLabel?`,
  `onSubmit(value, checked)`, `onCancel`. Submit is disabled while the input is empty; resets each open.

### `Select`
Accessible single/multi dropdown (WAI-ARIA combobox + listbox) — replaces the `<div onClick>` fields that
weren't keyboard-operable. Field is a focusable `role="combobox"`; popup is a `role="listbox"`. Keyboard:
↓/↑/Home/End move the active option (`aria-activedescendant`), Enter/Space toggles, Escape closes; closes on
click-outside and Tab. Multi renders removable chips; single renders the selected label.
- Props: `options` (`{ id, name }[]`), `value` (`string[]`), `onChange(ids)`, `multiple?`, `placeholder?`,
  `ariaLabel?`.

### Icons
Feather-style line icons (`HomeIcon`, `TrashIcon`, `CloseIcon`, …); `stroke = currentColor`, `aria-hidden`.
Props: `size?`, `className?`.

## Testing
Component tests live beside the source (`src/*.test.tsx`, jsdom + `@testing-library/react`) and run under
`pnpm test`.
