import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { Button } from './Button';

describe('Button', () => {
  it('renders its label and default type=button', () => {
    const { getByRole } = render(<Button>Save</Button>);
    const btn = getByRole('button', { name: 'Save' });
    expect(btn.getAttribute('type')).toBe('button');
    expect(btn.className).toContain('ui-btn--secondary');
  });

  it('applies the variant class', () => {
    const { getByRole } = render(<Button variant="danger">Delete</Button>);
    expect(getByRole('button').className).toContain('ui-btn--danger');
  });

  it('fires onClick, and not when disabled', () => {
    const onClick = vi.fn();
    const { getByRole, rerender } = render(<Button onClick={onClick}>Go</Button>);
    fireEvent.click(getByRole('button'));
    expect(onClick).toHaveBeenCalledTimes(1);

    rerender(<Button onClick={onClick} disabled>Go</Button>);
    fireEvent.click(getByRole('button'));
    expect(onClick).toHaveBeenCalledTimes(1); // still 1 — disabled
  });
});
