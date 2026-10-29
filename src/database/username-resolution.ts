import { AppError } from '../shared/errors.js';

export function normalizeLookupUsername(value: string): string {
  return value.trim().replace(/^@/, '').toLowerCase();
}

/** Never choose an arbitrary recipient when the two namespaces collide. */
export function uniqueUsernameMatch<T>(matches: T[]): T | undefined {
  if (matches.length > 1) {
    throw new AppError(409, 'This username matches multiple accounts. Use a verified user ID instead.', 'ambiguous_username');
  }
  return matches[0];
}

export function resolveUsername<T extends { username?: string; telegramUsername?: string }>(users: T[], value: string): T | undefined {
  const clean = normalizeLookupUsername(value);
  if (!clean) return undefined;
  return uniqueUsernameMatch(users.filter((user) =>
    user.username?.toLowerCase() === clean || user.telegramUsername?.toLowerCase() === clean
  ));
}
