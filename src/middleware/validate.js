// src/middleware/validate.js
export const validate = (schema) => {
  return async (request, reply) => {
    try {
      if (schema.body) request.body = schema.body.parse(request.body);
      if (schema.query) request.query = schema.query.parse(request.query);
      if (schema.params) request.params = schema.params.parse(request.params);
    } catch (error) {
      const issues = error.issues ?? error.errors;
      return reply.code(400).send({
        success: false,
        message: 'Validation failed',
        errors: issues?.map((err) => ({
          field: err.path.join('.'),
          message: err.message,
        })) ?? [{ field: 'unknown', message: error.message }],
      });
    }
  };
};

/**
 * Untuk PATCH: setelah divalidasi, hanya kolom yang benar-benar dikirim klien
 * yang dipertahankan. Tanpa ini, nilai default di skema (mis. status 'aktif',
 * flag false) ikut terisi dan menimpa data yang tidak dimaksud diubah.
 */
export const validatePatch = (schema) => {
  const inner = validate(schema);
  return async (request, reply) => {
    const sent = request.body && typeof request.body === 'object' ? new Set(Object.keys(request.body)) : new Set();
    await inner(request, reply);
    if (reply.sent || !request.body) return;
    request.body = Object.fromEntries(Object.entries(request.body).filter(([key]) => sent.has(key)));
    if (!Object.keys(request.body).length) {
      return reply.code(400).send({ success: false, message: 'Tidak ada data yang diubah.', errors: [] });
    }
  };
};
