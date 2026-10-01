// src/shared/utils/scopes.js
import { AppError } from './AppError.js';

// Role yang berwenang lintas perusahaan.
const CROSS_COMPANY_ROLES = ['super_admin'];

export const isCrossCompanyRole = (user) => CROSS_COMPANY_ROLES.includes(user?.role);

/**
 * Menentukan company_id yang boleh diakses user.
 * - Role lintas perusahaan wajib menyebut companyId yang diminta.
 * - Role lain selalu dikunci ke perusahaannya sendiri; permintaan perusahaan lain ditolak.
 */
export function resolveCompanyId(user, requestedCompanyId) {
  if (isCrossCompanyRole(user)) {
    if (!requestedCompanyId) throw new AppError('Parameter companyId wajib diisi.', 400);
    return requestedCompanyId;
  }

  if (!user?.companyId) throw new AppError('Akun tidak terhubung ke perusahaan mana pun.', 403);
  if (requestedCompanyId && requestedCompanyId !== user.companyId) {
    throw new AppError('Data perusahaan tidak ditemukan.', 404);
  }
  return user.companyId;
}
