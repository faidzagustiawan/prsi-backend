import { describe, it, expect } from 'vitest';
import { resolveCompanyId } from '../src/shared/utils/scopes.js';

const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';

describe('resolveCompanyId', () => {
  it('super_admin memakai companyId yang diminta', () => {
    expect(resolveCompanyId({ role: 'super_admin' }, B)).toBe(B);
  });

  it('super_admin wajib menyebut companyId', () => {
    expect(() => resolveCompanyId({ role: 'super_admin' })).toThrow(/wajib/);
  });

  it('role lain dikunci ke perusahaannya sendiri', () => {
    expect(resolveCompanyId({ role: 'finance_staff', companyId: A })).toBe(A);
    expect(resolveCompanyId({ role: 'finance_staff', companyId: A }, A)).toBe(A);
  });

  it('role lain tidak bisa meminta perusahaan lain', () => {
    expect(() => resolveCompanyId({ role: 'finance_staff', companyId: A }, B)).toThrow(/tidak ditemukan/);
  });

  it('role lain tanpa perusahaan ditolak', () => {
    expect(() => resolveCompanyId({ role: 'viewer' })).toThrow(/tidak terhubung/);
  });
});
