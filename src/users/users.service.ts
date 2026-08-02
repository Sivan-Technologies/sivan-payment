import { z } from 'zod';
import { db } from '../database/json-database.js';
import { badRequest, conflict, notFound } from '../shared/errors.js';
import { id, nowIso } from '../shared/id.js';

/**
 * An ISO 3166-1 alpha-2 country code.
 *
 * .length(2) is NOT sufficient, which is easy to miss: '12', 'n1' and '!!' all
 * have length two and all violate the users_country_iso2 check constraint, so
 * they escape Zod and come back as a 500 from Postgres instead of a 400 the
 * caller can act on. Trimmed and uppercased so 'ng', 'NG' and ' ng ' cannot
 * coexist as three different stored values that compare unequal.
 */
const countryCodeSchema = z
  .string()
  .trim()
  .transform((v) => v.toUpperCase())
  .refine((v) => /^[A-Z]{2}$/.test(v), {
    message: 'country must be an ISO 3166-1 alpha-2 code, e.g. NG'
  });

export const createUserSchema = z
  .object({
    email: z.string().email().transform((v) => v.toLowerCase()).optional(),
    whatsappNumber: z.string().min(6).optional(),
    fullName: z.string().min(2),
    // Optional: country is collected in the verification modal, not at signup,
    // so almost every user is created without one.
    country: countryCodeSchema.optional(),
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

/**
 * Country, set from the verification modal rather than at signup.
 *
 * Deliberately NOT part of the signup form. Country is only ever consumed to
 * decide a verification path, and that decision is made at the moment a user
 * starts verifying - which is usually days after signup. Asking at signup adds
 * a field to the highest-drop-off screen on the site to answer a question
 * nothing reads until much later.
 *
 * .length(2) is not enough on its own: 'g1' and '  ' both have length 2 and
 * both violate the users_country_iso2 check constraint, which would surface as
 * a 500 from Postgres instead of a 400 here.
 */
export const setUserCountrySchema = z.object({ country: countryCodeSchema });

export async function setUserCountry(userId: string, input: z.infer<typeof setUserCountrySchema>) {
  const user = await getUser(userId);
  // Idempotent on purpose. A user who reopens the modal and picks the same
  // country should not get an error, and re-picking a DIFFERENT one is allowed:
  // country is a routing hint, not evidence, so changing it changes which form
  // they see and nothing about what they are permitted to do.
  const updated = { ...user, country: input.country, updatedAt: nowIso() };
  return db.updateUserRecord(updated);
}

/**
 * Change the name on file.
 *
 * ONLY BEFORE THE NAME HAS BEEN USED AS EVIDENCE.
 *
 * The Level 1 check works by comparing the bank's account holder against this
 * field. So once a bank account has been matched against it, this field is not
 * a profile preference any more - it is the basis of an identity decision.
 *
 * The attack this closes: submit a stranger's account number, get rejected for
 * a name mismatch, edit the name to match the stranger, resubmit. Without a
 * lock the matcher is decorative - anybody can pass it by copying the name it
 * just showed them.
 *
 * A UI-only lock is not a lock. There is a readOnly attribute on the settings
 * input, and it takes one curl to bypass. This is the enforcement.
 */
export const setUserNameSchema = z.object({
  // A single character is not a legal name, and a bare surname cannot be
  // matched against a Nigerian bank record with any confidence.
  fullName: z.string().trim().min(2).max(120)
});

export async function setUserName(
  userId: string,
  input: z.infer<typeof setUserNameSchema>,
  /**
   * Supplied by the route, which owns the lookups. Passed in rather than
   * imported so this module does not depend on the NGN or KYC layers.
   */
  guard: { hasVerifiedPayoutAccount: boolean; hasPendingNameReview: boolean; kycApproved: boolean }
) {
  const user = await getUser(userId);

  if (guard.hasVerifiedPayoutAccount || guard.kycApproved) {
    throw badRequest(
      'Your name is locked because it has been verified against your bank account or ID. ' +
      'Contact Sivan Support if it needs to be corrected.'
    );
  }

  // A case sitting with a reviewer is mid-decision. Editing the name now would
  // change the comparison under the reviewer's feet - they would approve a
  // pairing that no longer exists.
  if (guard.hasPendingNameReview) {
    throw badRequest(
      'Your bank account is being reviewed against this name. You cannot change it until that finishes.'
    );
  }

  const updated = { ...user, fullName: input.fullName, updatedAt: nowIso() };
  return db.updateUserRecord(updated);
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
