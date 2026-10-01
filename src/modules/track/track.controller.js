// src/modules/track/track.controller.js
import * as service from './track.service.js';

export const companiesHandler = async (request, reply) => {
  const data = await service.getCompanies(request.user);
  return reply.code(200).send({ success: true, message: 'Success', data });
};

export const unitsHandler = async (request, reply) => {
  const data = await service.getUnits(request.user, request.query.companyId);
  return reply.code(200).send({ success: true, message: 'Success', data });
};

export const assignmentsHandler = async (request, reply) => {
  const data = await service.getAssignments(request.user, request.query.companyId);
  return reply.code(200).send({ success: true, message: 'Success', data });
};
