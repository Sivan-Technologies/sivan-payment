import { z } from 'zod';
import { badRequest } from './errors.js';

export function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw badRequest('Invalid request body', parsed.error.flatten());
  }
  return parsed.data;
}

export const addressSchema = z.object({
  street_line_1: z.string().min(4),
  street_line_2: z.string().optional(),
  city: z.string().min(1),
  state: z.string().min(1).max(3).optional(),
  postal_code: z.string().min(1).optional(),
  country: z.string().min(3).max(3)
});
