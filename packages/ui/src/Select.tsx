import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';

export interface SelectOption {
  id: string;
  name: string;
}

export interface SelectProps {
  options: SelectOption[];
  value: string[]; // selected ids (single-select uses length 0 or 1)
  onChange: (ids: string[]) => void;
  multiple?: boolean;
  placeholder?: string;
  ariaLabel?: string;
}

/**
 * Accessible single/multi dropdown (WAI-ARIA combobox+listbox) — replaces the
 * `<div onClick>` fields that weren't keyboard-operable. The field is a focusable
 * `role="combobox"` (a div, so chips can host their own remove buttons); the popup
 * is a `role="listbox"`. Keyboard: ↓/↑/Enter/Space/Escape/Home/End, active option
 * tracked via `aria-activedescendant`. Closes on click-outside and blur.
 */
export function Select({
  options,
  value,
  onChange,
  multiple = false,
  placeholder = 'Select…',
  ariaLabel,
}: SelectProps) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const rootRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  useEffect(() => {
    if (!open) return;
    const onDocDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocDown);
    return () => document.removeEventListener('mousedown', onDocDown);
  }, [open]);

  const nameOf = (id: string) => options.find((o) => o.id === id)?.name ?? id;

  const openList = () => {
    setOpen(true);
    // land on the first selected option, else the top
    const firstSel = options.findIndex((o) => value.includes(o.id));
    setActive(firstSel >= 0 ? firstSel : 0);
  };

  const toggleId = (id: string) => {
    if (multiple) {
      onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id]);
    } else {
      onChange([id]);
      setOpen(false);
    }
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!open) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) {
        e.preventDefault();
        openList();
      }
      return;
    }
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setActive((i) => Math.min(i + 1, options.length - 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setActive((i) => Math.max(i - 1, 0));
        break;
      case 'Home':
        e.preventDefault();
        setActive(0);
        break;
      case 'End':
        e.preventDefault();
        setActive(options.length - 1);
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        if (active >= 0 && options[active]) toggleId(options[active]!.id);
        break;
      case 'Escape':
        e.preventDefault();
        setOpen(false);
        break;
      case 'Tab':
        setOpen(false);
        break;
    }
  };

  const activeId = open && active >= 0 && options[active] ? `${listId}-opt-${active}` : undefined;

  return (
    <div className="ui-select" ref={rootRef}>
      <div
        className={`ui-select-field ${value.length ? 'has' : ''}`}
        role="combobox"
        tabIndex={0}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={activeId}
        aria-label={ariaLabel}
        onClick={() => (open ? setOpen(false) : openList())}
        onKeyDown={onKeyDown}
      >
        {value.length === 0 && <span className="ui-select-ph">{placeholder}</span>}
        {multiple
          ? value.map((id) => (
              <span className="ui-select-chip" key={id}>
                <button
                  type="button"
                  aria-label={`Remove ${nameOf(id)}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleId(id);
                  }}
                >
                  ×
                </button>
                {nameOf(id)}
              </span>
            ))
          : value.length > 0 && <span className="ui-select-single">{nameOf(value[0]!)}</span>}
        <span className="ui-select-caret" aria-hidden="true">
          ▾
        </span>
      </div>

      {open && (
        <ul className="ui-select-list" id={listId} role="listbox" aria-multiselectable={multiple}>
          {value.length > 0 && multiple && (
            <li className="ui-select-clear" role="presentation">
              <button type="button" onClick={() => onChange([])}>
                Clear selection
              </button>
            </li>
          )}
          {options.length === 0 && (
            <li className="ui-select-empty" role="presentation">
              None
            </li>
          )}
          {options.map((o, i) => {
            const selected = value.includes(o.id);
            return (
              <li
                key={o.id}
                id={`${listId}-opt-${i}`}
                role="option"
                aria-selected={selected}
                className={`ui-select-opt ${i === active ? 'active' : ''} ${selected ? 'selected' : ''}`}
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => {
                  e.preventDefault(); // keep focus on the combobox
                  toggleId(o.id);
                }}
              >
                {multiple && (
                  <span className="ui-select-check" aria-hidden="true">
                    {selected ? '✓' : ''}
                  </span>
                )}
                {o.name}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
