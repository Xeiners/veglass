const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** Short, collision-resistant enough for in-document ids. */
export function uid(prefix = ''): string {
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  let out = '';
  for (const byte of bytes) out += ALPHABET[byte % ALPHABET.length];
  return prefix ? `${prefix}_${out}` : out;
}

export function projectId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return uid('prj');
}
