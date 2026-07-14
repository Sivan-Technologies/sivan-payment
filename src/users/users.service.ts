import { z } from 'zod';
import { db } from '../database/json-database.js';
import { badRequest, conflict, notFound } from '../shared/errors.js';
import { id, nowIso } from '../shared/id.js';

export const createUserSchema = z
  .object({
    email: z.string().email().transform((v) => v.toLowerCase()).optional(),
    whatsappNumber: z.string().min(6).optional(),
    fullName: z.string().min(2),
    primaryChannel: z.enum(['email', 'whatsapp', 'both']).optional()
  })
  .refine((value) => value.email || value.whatsappNumber, {
    message: 'Either email or whatsappNumber is required',
    path: ['email']
  });

export async function createUser(input: z.infer<typeof createUserSchema>) {
  const now = nowIso();
  const data = await db.read();
  if (input.email) {
    const emailExists = data.users.find((u) => u.email?.toLowerCase() === input.email?.toLowerCase());
    if (emailExists) throw conflict('A user with this email already exists');
  }

  if (input.whatsappNumber) {
    const whatsappExists = data.users.find((u) => u.whatsappNumber === input.whatsappNumber);
    if (whatsappExists) throw conflict('A user with this WhatsApp number already exists');
  }

  const primaryChannel = input.primaryChannel ?? inferPrimaryChannel(input.email, input.whatsappNumber);
  const user = {
    id: id('usr'),
    email: input.email ?? '',
    whatsappNumber: input.whatsappNumber,
    fullName: input.fullName,
    primaryChannel,
    createdAt: now,
    updatedAt: now
  };
  return db.insertUserRecord(user);
}

export async function getUser(userId: string) {
  const data = await db.read();
  const user = data.users.find((u) => u.id === userId);
  if (!user) throw notFound('User');
  return user;
}

export async function getUserByEmail(email: string) {
  const data = await db.read();
  return data.users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
}

export async function getUserByWhatsappNumber(whatsappNumber: string) {
  const data = await db.read();
  return data.users.find((u) => u.whatsappNumber === whatsappNumber);
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
