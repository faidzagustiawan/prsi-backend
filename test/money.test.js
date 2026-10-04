import { describe, it, expect } from 'vitest';
import { toCents, centsToString, sumCents } from '../src/shared/utils/money.js';

describe('money', () => {
  it('mengubah number dan string NUMERIC ke sen tanpa galat float', () => {
    expect(toCents(0.1)).toBe(10n);
    expect(toCents('1500.5')).toBe(150050n);
    expect(toCents('2476557881.00')).toBe(247655788100n);
    expect(toCents(-12.34)).toBe(-1234n);
    expect(toCents(null)).toBe(0n);
  });

  it('0.1 + 0.2 tepat 0.30', () => {
    expect(centsToString(sumCents([0.1, 0.2]))).toBe('0.30');
  });

  it('mengembalikan string NUMERIC', () => {
    expect(centsToString(150050n)).toBe('1500.50');
    expect(centsToString(-5n)).toBe('-0.05');
  });

  it('menolak input yang bukan nominal', () => {
    expect(() => toCents('1,5')).toThrow();
    expect(() => toCents('1.555')).toThrow();
  });
});
