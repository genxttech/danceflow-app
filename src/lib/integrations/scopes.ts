/** OAuth scope helpers shared by integrations. Granted scope strings are space separated; providers may order or omit them. */
export function missingScopes(granted: string | string[] | null | undefined, required: readonly string[]) {
  // A token response without a scope field means "same as requested" (RFC 6749 section 5.1), so nothing is provably missing.
  if (granted === null || granted === undefined) return [] as string[];
  const have = new Set(Array.isArray(granted) ? granted : granted.split(/\s+/).filter(Boolean));
  return required.filter((scope) => !have.has(scope));
}
