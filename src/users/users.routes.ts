import type { FastifyInstance } from 'fastify';
import { parseBody } from '../shared/validation.js';
import { createUser, createUserSchema, getUser, setUserCountry, setUserCountrySchema,
  setUserDateOfBirth,
  setUserDateOfBirthSchema, setUserName, setUserNameSchema } from './users.service.js';
import { db } from '../database/json-database.js';
import { isApprovedKycStatus } from '../kyc/types/verification.types.js';
import { getUserPreferences, updateUserPreferences, updateUserPreferencesSchema } from './user-preferences.service.js';
import { resolveNetworkMode } from '../wallets/network-mode.js';

import { confirmAvatarUpload, confirmAvatarUploadSchema, createAvatarUploadUrl, createAvatarUploadUrlSchema, removeAvatar } from './user-avatar.service.js';
import { checkUsernameAvailability, updateUsername, usernameSchema } from './username.service.js';
import { legalAcceptancePayloadSchema, listUserLegalAcceptances, recordSignupLegalAcceptance } from '../legal/legal-acceptance.service.js';
import { confirmUserEmailChange, userEmailChangeConfirmSchema } from '../admin/account-recovery.service.js';

const createUserWithLegalSchema = createUserSchema.extend({
  legalAcceptance: legalAcceptancePayloadSchema
});

export async function usersRoutes(app: FastifyInstance) {
  app.post('/api/users', async (request, reply) => {
    const body = parseBody(createUserWithLegalSchema, request.body);
    const user = await createUser(body);
    if (user.email) {
      await recordSignupLegalAcceptance({
        userId: user.id,
        email: user.email,
        termsVersion: body.legalAcceptance.termsVersion,
        privacyVersion: body.legalAcceptance.privacyVersion,
        riskDisclosureVersion: body.legalAcceptance.riskDisclosureVersion,
        acceptedAt: new Date().toISOString(),
        ipAddress: request.ip,
        userAgent: request.headers['user-agent']
      });
    }
    return reply.code(201).send({ data: user });
  });


  app.get('/api/users/:userId/legal-acceptances', async (request) => {
    const { userId } = request.params as { userId: string };
    return { data: await listUserLegalAcceptances(userId) };
  });

  app.get('/api/users/:userId/preferences', async (request) => {
    const { userId } = request.params as { userId: string };
    const preferences = await getUserPreferences(userId);
    return {
      data: {
        ...preferences,
        // READ-ONLY server fact, not a stored preference: which chain THIS
        // deployment signs against. Not part of UserPreferencesRecord and never
        // written back - the PUT schema has no `network` key at all.
        //
        // The UI needs it to mark the testnet build. Sourced from the server
        // rather than the frontend's own VITE_APP_ENV so the badge cannot
        // disagree with what the backend will actually do: a testnet API behind
        // a frontend built as 'live' would otherwise show nothing at all.
        //
        // It rides inside `data` rather than a sibling `meta` because the
        // frontend's shared api() helper returns `json.data ?? json` and drops
        // everything else, so a `meta` key would be silently discarded.
        networkMode: resolveNetworkMode(),
      },
    };

  });


  app.put('/api/users/:userId/preferences', async (request) => {
    const { userId } = request.params as { userId: string };
    const body = parseBody(updateUserPreferencesSchema, request.body);
    const updated = await updateUserPreferences(userId, body);
    return {
      data: {
        ...updated,
        // Repeated on the write path, and NOT decoration. The frontend does
        // setUserPreferences(response) wholesale, so a PUT that omitted this
        // would drop networkMode out of client state and the testnet banner
        // would vanish the moment a user saved any unrelated preference.
        networkMode: resolveNetworkMode(),
      },
    };
  });




  app.get('/api/users/:userId/username/availability', async (request) => {
    const { userId } = request.params as { userId: string };
    const query = request.query as { username?: string };
    return { data: await checkUsernameAvailability(query.username || '', userId) };
  });

  app.put('/api/users/:userId/username', async (request) => {
    const { userId } = request.params as { userId: string };
    const body = parseBody(usernameSchema, request.body);
    return { data: await updateUsername(userId, body, { ipAddress: request.ip, userAgent: request.headers['user-agent'] }) };
  });

  app.post('/api/users/:userId/avatar/upload-url', async (request) => {
    const { userId } = request.params as { userId: string };
    const body = parseBody(createAvatarUploadUrlSchema, request.body);
    return { data: await createAvatarUploadUrl(userId, body) };
  });

  app.post('/api/users/:userId/avatar/confirm', async (request) => {
    const { userId } = request.params as { userId: string };
    const body = parseBody(confirmAvatarUploadSchema, request.body);
    return { data: await confirmAvatarUpload(userId, body) };
  });

  app.delete('/api/users/:userId/avatar', async (request) => {
    const { userId } = request.params as { userId: string };
    return { data: await removeAvatar(userId) };
  });


  app.post('/api/users/:userId/email-change/confirm', async (request) => {
    const { userId } = request.params as { userId: string };
    const body = parseBody(userEmailChangeConfirmSchema, request.body);
    return { data: await confirmUserEmailChange(userId, body) };
  });

  /**
   * Set the user's country, from step 1 of the verification modal.
   *
   * PUT rather than PATCH because the whole value is replaced and the call is
   * idempotent - reopening the modal and picking the same country again must
   * not be an error.
   */
  /**
   * Set the declared date of birth.
   *
   * Separate from /country even though both are collected in the verification
   * modal: country is a routing hint that changes which form a user sees, and
   * this is data forwarded to a provider to satisfy a compliance requirement.
   * Folding them together would make one request that half-succeeds.
   */
  app.put('/api/users/:userId/date-of-birth', async (request) => {
    const { userId } = request.params as { userId: string };
    const body = parseBody(setUserDateOfBirthSchema, request.body);
    return { data: await setUserDateOfBirth(userId, body) };
  });

  app.put('/api/users/:userId/country', async (request) => {
    const { userId } = request.params as { userId: string };
    const body = parseBody(setUserCountrySchema, request.body);
    return { data: await setUserCountry(userId, body) };
  });

  /**
   * Change the name on file, while it is still changeable.
   *
   * The guard is evaluated HERE and passed to the service, so the service
   * stays free of NGN/KYC imports. Locking rules:
   *
   *   verified NGN payout account -> locked (the name IS the evidence)
   *   approved Bridge KYC         -> locked (a document was matched to it)
   *   review pending              -> locked (a human is mid-decision on it)
   *
   * Anything else is an unverified user tidying their profile, which is
   * harmless and should not need support.
   */
  app.put('/api/users/:userId/name', async (request) => {
    const { userId } = request.params as { userId: string };
    const body = parseBody(setUserNameSchema, request.body);

    const payoutAccounts = await db.listNgnPayoutAccounts(userId);
    const data = await db.read();
    const customer = (data.customers ?? []).find((item: any) => item.userId === userId);

    return {
      data: await setUserName(userId, body, {
        hasVerifiedPayoutAccount: payoutAccounts.some((item) => item.status === 'verified'),
        hasPendingNameReview: payoutAccounts.some((item) => item.status === 'pending_review'),
        kycApproved: isApprovedKycStatus(customer?.kycStatus)
      })
    };
  });

  app.get('/api/users/:userId', async (request) => {
    const { userId } = request.params as { userId: string };
    return { data: await getUser(userId) };
  });
}
