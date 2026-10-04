// src/plugins/validator.js
import fp from 'fastify-plugin';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { removeExamples } from './swagger.js';

/**
 * Compiler validasi request. Selalu diregistrasi supaya aturan validasi identik
 * di development dan produksi. Metadata dokumentasi tidak mengubah validasi.
 */
async function validatorPlugin(fastify) {
  const ajv = new Ajv({
    coerceTypes: true,
    useDefaults: true,
    removeAdditional: false,
    allErrors: true,
    strict: false,
  });

  addFormats(ajv);

  fastify.setValidatorCompiler(({ schema }) => ajv.compile(removeExamples(schema)));
}

export default fp(validatorPlugin, { name: 'validator-plugin' });
