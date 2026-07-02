import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { Select } from './Select';

const OPTS = [
  { id: 'a', name: 'Alice' },
  { id: 'b', name: 'Bob' },
];

describe('Select', () => {
  it('shows the placeholder and exposes a combobox', () => {
    const { getByRole, getByText } = render(
      <Select options={OPTS} value={[]} onChange={() => {}} placeholder="Pick one" />,
    );
    expect(getByText('Pick one')).toBeTruthy();
    const combo = getByRole('combobox');
    expect(combo.getAttribute('aria-expanded')).toBe('false');
  });

  it('opens on click and selects an option (single)', () => {
    const onChange = vi.fn();
    const { getByRole, getByText } = render(
      <Select options={OPTS} value={[]} onChange={onChange} />,
    );
    fireEvent.click(getByRole('combobox'));
    expect(getByRole('listbox')).toBeTruthy();
    fireEvent.mouseDown(getByText('Bob'));
    expect(onChange).toHaveBeenCalledWith(['b']);
  });

  it('is keyboard-operable: ArrowDown opens, Enter selects', () => {
    const onChange = vi.fn();
    const { getByRole } = render(<Select options={OPTS} value={[]} onChange={onChange} />);
    const combo = getByRole('combobox');
    fireEvent.keyDown(combo, { key: 'ArrowDown' }); // open, active = 0
    fireEvent.keyDown(combo, { key: 'ArrowDown' }); // active = 1
    fireEvent.keyDown(combo, { key: 'Enter' }); // select Bob
    expect(onChange).toHaveBeenCalledWith(['b']);
  });

  it('multi-select toggles without closing', () => {
    const onChange = vi.fn();
    const { getByRole, getByText } = render(
      <Select multiple options={OPTS} value={['a']} onChange={onChange} />,
    );
    fireEvent.click(getByRole('combobox'));
    fireEvent.mouseDown(getByText('Bob'));
    expect(onChange).toHaveBeenCalledWith(['a', 'b']);
    // listbox stays open in multi mode
    expect(getByRole('listbox')).toBeTruthy();
  });
});
