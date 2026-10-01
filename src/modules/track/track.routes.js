// src/modules/track/track.routes.js
// Endpoint read-only data PodorukunTrack (perusahaan, unit, penjualan).
import { authorize } from '../../middleware/authorize.js';
import { SI_ROLES } from '../../shared/schemas/finance.schema.js';
import * as controller from './track.controller.js';

const companyQuery = {
  type: 'object',
  properties: {
    companyId: { type: 'string', format: 'uuid', description: 'Wajib untuk super_admin' },
  },
};

export default async function trackRoutes(fastify) {
  fastify.addHook('preValidation', fastify.authenticate);

  fastify.get(
    '/companies',
    {
      preHandler: [authorize(...SI_ROLES)],
      schema: { description: 'Daftar perusahaan (dari Track)', tags: ['Track'] },
    },
    controller.companiesHandler
  );

  fastify.get(
    '/units',
    {
      preHandler: [authorize(...SI_ROLES)],
      schema: { description: 'Daftar unit per perusahaan (dari Track)', tags: ['Track'], querystring: companyQuery },
    },
    controller.unitsHandler
  );

  fastify.get(
    '/assignments',
    {
      preHandler: [authorize(...SI_ROLES)],
      schema: { description: 'Penjualan unit per perusahaan (dari Track)', tags: ['Track'], querystring: companyQuery },
    },
    controller.assignmentsHandler
  );
}
