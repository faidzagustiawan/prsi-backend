// src/modules/track/track.service.js
import * as repo from './track.repository.js';
import { isCrossCompanyRole, resolveCompanyId } from '../../shared/utils/scopes.js';

export const getCompanies = async (user) => {
  const companies = await repo.listCompanies();
  if (isCrossCompanyRole(user)) return companies;
  return companies.filter((c) => c.id === user.companyId);
};

export const getUnits = async (user, requestedCompanyId) =>
  repo.listUnits(resolveCompanyId(user, requestedCompanyId));

export const getAssignments = async (user, requestedCompanyId) =>
  repo.listAssignments(resolveCompanyId(user, requestedCompanyId));
