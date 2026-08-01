import { z } from 'zod';
import { db } from '../database/json-database.js';
import { badRequest, conflict, notFound } from '../shared/errors.js';
import { id, nowIso } from '../shared/id.js';

export const createUserSchema = z
  .object({
    email: z.string().email().transform((v) => v.toLowerCase()).optional(),
    whatsappNumber: z.string().min(6).optional(),
    fullName: z.string().min(2),
    // Uppercased here so 'ng', 'NG' and 'Ng' cannot coexist and route
    // differently. Optional: existing users have none and must not be blocked.
    country: z.string().length(2).transform((v) => v.toUpperCase()).optional(),
    primaryChannel: z.enum(['email', 'whatsapp', 'both']).optional()
  })
  .refine((value) => value.email || value.whatsappNumber, {
    message: 'Either email or whatsappNumber is required',
    path: ['email']
  });

export async function createUser(input: z.infer<typeof createUserSchema>) {
  const now = nowIso();
  if (input.email) {
    const emailExists = await db.findUserByEmail(input.email);
    if (emailExists) throw conflict('A user with this email already exists');
  }

  if (input.whatsappNumber) {
    const whatsappExists = await db.findUserByWhatsappNumber(input.whatsappNumber);
    if (whatsappExists) throw conflict('A user with this WhatsApp number already exists');
  }

  const primaryChannel = input.primaryChannel ?? inferPrimaryChannel(input.email, input.whatsappNumber);
  const user = {
    id: id('usr'),
    email: input.email ?? '',
    whatsappNumber: input.whatsappNumber,
    fullName: input.fullName,
    country: input.country,
    primaryChannel,
    createdAt: now,
    updatedAt: now
  };
  return db.insertUserRecord(user);
}

export async function getUser(userId: string) {
  const user = await db.findUserById(userId);
  if (!user) throw notFound('User');
  return user;
}

export async function getUserByEmail(email: string) {
  return db.findUserByEmail(email);
}

export async function getUserByWhatsappNumber(whatsappNumber: string) {
  return db.findUserByWhatsappNumber(whatsappNumber);
}

export async function requireUser(userId?: string) {
  if (!userId) throw badRequest('userId is required');
  return getUser(userId);
}

function inferPrimaryChannel(email?: string, whatsappNumber?: string): 'email' | 'whatsapp' | 'both' {
  if (email && whatsappNumber) return 'both';
  if (email) return 'email';
  return 'whatsapp';
}
