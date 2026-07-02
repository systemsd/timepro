import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { ConfirmModal, Modal } from './Modal';

describe('Modal', () => {
  it('renders nothing when closed', () => {
    const { queryByRole } = render(
      <Modal open={false} onClose={() => {}} title="Hi">body</Modal>,
    );
    expect(queryByRole('dialog')).toBeNull();
  });

  it('renders an accessible dialog labelled by its title', () => {
    const { getByRole } = render(
      <Modal open onClose={() => {}} title="Edit Time">body</Modal>,
    );
    const dialog = getByRole('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    const labelledBy = dialog.getAttribute('aria-labelledby');
    expect(labelledBy).toBeTruthy();
    expect(document.getElementById(labelledBy!)?.textContent).toBe('Edit Time');
  });

  it('closes on Escape and on backdrop click', () => {
    const onClose = vi.fn();
    const { getByRole } = render(<Modal open onClose={onClose} title="T">body</Modal>);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    // backdrop (the overlay, parent of the dialog) — mousedown on it closes
    const overlay = getByRole('dialog').parentElement!;
    fireEvent.mouseDown(overlay);
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

describe('ConfirmModal', () => {
  it('wires confirm and cancel', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const { getByRole } = render(
      <ConfirmModal open title="Delete?" confirmLabel="Delete" onConfirm={onConfirm} onCancel={onCancel} />,
    );
    fireEvent.click(getByRole('button', { name: 'Delete' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    fireEvent.click(getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
