/**
 * Break an address into groups so a human can actually compare it.
 *
 * An unbroken 44-character string is read as a blur - people check the first
 * three and last three characters and skip the middle, which is exactly the
 * substitution a clipboard hijacker relies on. Chunking forces the eye to land
 * on every group.
 *
 * Lives in its own .ts file rather than beside the component: the backend test
 * suite imports it directly, and the backend tsconfig has no `jsx` setting, so
 * importing a .tsx there fails to compile. A pure function has no reason to be
 * trapped in a component file anyway.
 */
export function chunkAddress(value: string, size = 4): string[] {
  const clean = String(value || '').trim();
  if (!clean) return [];
  const groups: string[] = [];
  for (let i = 0; i < clean.length; i += size) groups.push(clean.slice(i, i + size));
  return groups;
}
