// src/modules/auth/auth.schema.js
import { z } from 'zod';

export const loginSchema = {
  body: z.object({
    email: z.string().trim().toLowerCase().email('Format email tidak valid'),
    password: z.string().min(1, 'Password wajib diisi'),
  }),
};
