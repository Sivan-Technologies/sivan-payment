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
/**
 * DATE OF BIRTH, and the 18+ rule.
 *
 * WHY THIS EXISTS. Bridge will not approve a customer whose `base`/`sepa`
 * endorsements are missing `date_of_birth` and `min_age_18`. Measured against
 * the real sandbox: a stuck customer showed
 *
 *   base incomplete  missing: ["date_of_birth", "min_age_18", ...]
 *
 * and one PUT /v0/customers/{id} {"birth_date": ...} moved both to `complete`.
 *
 * ENFORCED HERE, ON THE SERVER. The form also checks 18+, but a UI check is a
 * courtesy, not a rule - it takes one curl to bypass. Bridge would refuse the
 * customer anyway, so letting an under-age date through would spend $2 to be
 * told no, and strand the user with a rejection they cannot fix.
 */
export const MINIMUM_AGE_YEARS = 18;

/**
 * Whole years between a date and now, calendar-correct.
 *
 * Deliberately NOT `(now - dob) / 365.25 days`. That drifts around leap years
 * and can call someone 18 the day before their birthday - which is exactly the
 * kind of off-by-one that turns into a compliance finding rather than a bug
 * report. Comparing month and day directly cannot drift.
 */
export function ageInYears(isoDate: string, now = new Date()): number {
  const dob = new Date(`${isoDate}T00:00:00Z`);
  let age = now.getUTCFullYear() - dob.getUTCFullYear();
  const monthDelta = now.getUTCMonth() - dob.getUTCMonth();
  if (monthDelta < 0 || (monthDelta === 0 && now.getUTCDate() < dob.getUTCDate())) age -= 1;
  return age;
}

export const setUserDateOfBirthSchema = z.object({
  /**
   * ISO yyyy-MM-dd, which is what Bridge's `birth_date` takes. The NGN BVN
   * form uses dd-MM-yyyy; converting is the caller's job so there is exactly
   * one format at this boundary and no ambiguity about whether 01-02-1990 is
   * January or February.
   */
  dateOfBirth: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'dateOfBirth must be yyyy-MM-dd')
});

export async function setUserDateOfBirth(
  userId: string,
  input: z.infer<typeof setUserDateOfBirthSchema>
) {
  const user = await getUser(userId);

  const parsed = new Date(`${input.dateOfBirth}T00:00:00Z`);
  // Catches 1990-13-45: the regex accepts the shape, only Date rejects the value.
  if (Number.isNaN(parsed.getTime())) throw badRequest('That is not a real date.');

  const now = new Date();
  if (parsed.getTime() > now.getTime()) {
    throw badRequest('Date of birth cannot be in the future.');
  }

  const age = ageInYears(input.dateOfBirth, now);
  if (age < MINIMUM_AGE_YEARS) {
    throw badRequest(`You must be at least ${MINIMUM_AGE_YEARS} to verify your identity.`);
  }
  // A date implying an implausible age is a typo, not a customer. Refusing is
  // kinder than sending it to Bridge and having them reject the person.
  if (age > 120) throw badRequest('Check your date of birth and try again.');

  const updated = { ...user, dateOfBirth: input.dateOfBirth, updatedAt: nowIso() };
  return db.updateUserRecord(updated);
}

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
