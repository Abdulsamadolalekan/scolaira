import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Money, formatKoboCompact, formatKoboFull } from './money';

const wrap = (ui: React.ReactNode) => <TooltipProvider>{ui}</TooltipProvider>;

describe('Money formatting (lib/money extended into presentation layer)', () => {
  it('formats zero kobo as ₦0.00', () => {
    expect(formatKoboFull(0)).toBe('₦0.00');
  });
  it('formats typical invoice correctly', () => {
    expect(formatKoboFull(150_000 * 100)).toBe('₦150,000.00');
  });
  it('formats term-scale totals with grouping', () => {
    expect(formatKoboFull(43_400_000 * 100)).toBe('₦43,400,000.00');
  });
  it('handles negative values', () => {
    expect(formatKoboFull(-5_000 * 100)).toBe('-₦5,000.00');
  });
  it('omits symbol when showSymbol=false', () => {
    expect(formatKoboFull(500 * 100, false)).toBe('500.00');
  });

  it('compact: thousands → K, millions → M, trillions → T', () => {
    expect(formatKoboCompact(43_400 * 100)).toBe('₦43K');
    expect(formatKoboCompact(1_500_000 * 100)).toBe('₦1.5M');
    expect(formatKoboCompact(43_400_000 * 100)).toBe('₦43.4M');
    expect(formatKoboCompact(1_200_000_000 * 100)).toBe('₦1.2B');
    expect(formatKoboCompact(1_200_000_000_000 * 100)).toBe('₦1.2T');
  });
});

describe('<Money /> component', () => {
  it('renders with tabular-nums', () => {
    render(wrap(<Money kobo={43_400_000 * 100} />));
    const el = screen.getByText('₦43,400,000.00');
    expect(el.className).toMatch(/tabular-nums/);
  });
  it('renders compact with ₦ prefix', () => {
    render(wrap(<Money kobo={43_400_000 * 100} compact />));
    expect(screen.getByText('₦43.4M')).toBeInTheDocument();
  });
  it('applies danger variant for overdue', () => {
    render(wrap(<Money kobo={12_200_000 * 100} variant="overdue" />));
    const el = screen.getByText('₦12,200,000.00');
    expect(el.className).toMatch(/text-danger-fg/);
  });
  it('applies positive variant for collected', () => {
    render(wrap(<Money kobo={31_200_000 * 100} variant="positive" />));
    const el = screen.getByText('₦31,200,000.00');
    expect(el.className).toMatch(/text-success-fg/);
  });
});
