/**
 * Has this Bridge customer accepted Bridge's terms of service?
 *
 * ONE COPY OF THE RULE. This logic used to live privately inside
 * customers.service.ts, reachable only by the admin import path. The provider
 * now needs the same answer on the ordinary refresh path, and a terms GATE is
 * being built on top of it - two copies of a rule that decides whether a user
 * can transact is exactly the kind of thing that drifts and then locks people
 * out.
 *
 * TRI-STATE, ON PURPOSE.
 *
 *   true       Bridge affirmatively says the terms are accepted.
 *   false      Bridge affirmatively says they are not.
 *   undefined  Bridge told us nothing usable - a malformed body, a field that
 *              moved, an object that is not a customer at all.
 *
 * The third case is the important one. Collapsing "we do not know" into
 * `false` would let one bad response from Bridge revoke a real acceptance and
 * block a verified user from withdrawing their own money. Callers must leave
 * the stored value untouched on undefined.
 *
 * VERIFIED against the real sandbox (customer
 * 1245c57f-9bc2-4942-8776-3bfa6998dcae): `has_accepted_terms_of_service` is
 * `true`, and both the `base` and `sepa` endorsements carry
 * `terms_of_service_v1` / `terms_of_service_v2` in `requirements.complete`.
 */
export function bridgeCustomerTermsAccepted(bridgeCustomer: any): boolean | undefined {
  if (!bridgeCustomer || typeof bridgeCustomer !== 'object') return undefined;

  // The explicit field wins when Bridge sends it. It is a direct statement
  // rather than something inferred from requirement lists.
  if (bridgeCustomer.has_accepted_terms_of_service === true) return true;
  if (bridgeCustomer.has_accepted_terms_of_service === false) return false;

  /**
   * FALL BACK TO THE ENDORSEMENTS, but only when they exist.
   *
   * Bridge versions its terms (`terms_of_service_v1`, `_v2`), so this matches
   * the prefix rather than an exact string - a `_v3` must not silently read as
   * "not accepted" and start blocking every user on the platform.
   *
   * The requirement is checked PER ENDORSEMENT and specifically inside that
   * endorsement's `complete` list. The previous implementation stringified the
   * entire endorsements array and tested `/terms_of_service/i` and
   * /complete/i against the whole blob - which returns true when terms are
   * sitting in `missing` and something else entirely is `complete`.
   */
  const endorsements = bridgeCustomer.endorsements;
  if (!Array.isArray(endorsements) || endorsements.length === 0) return undefined;

  let sawTermsRequirement = false;
  for (const endorsement of endorsements) {
    const requirements = endorsement?.requirements;
    if (!requirements || typeof requirements !== 'object') continue;

    for (const [bucket, value] of Object.entries(requirements as Record<string, unknown>)) {
      const names = flatten(value).filter((name) => name.toLowerCase().startsWith('terms_of_service'));
      if (!names.length) continue;
      sawTermsRequirement = true;
      // Outstanding in any bucket that is not `complete` means not accepted.
      if (bucket !== 'complete') return false;
    }
  }

  // Terms appeared, and every appearance was under `complete`.
  if (sawTermsRequirement) return true;

  // Endorsements exist but never mention terms. That is not a denial.
  return undefined;
}

function flatten(value: unknown): string[] {
  if (!value) return [];
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(flatten);
  if (typeof value === 'object') return Object.values(value as Record<string, unknown>).flatMap(flatten);
  return [String(value)];
}
