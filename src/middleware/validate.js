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
