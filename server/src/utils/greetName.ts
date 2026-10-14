// The name a WhatsApp message greets a donor by: "Hare Krishna Chaitanya".
//
// Names arrive as people type them, and in Andhra many begin with the family
// initial: "D chaitanya", "K. Ravi Kumar", "D.V. Rao". Taking the first word
// greeted those donors as "Hare Krishna D". This drops the initials and
// honorifics, keeps the rest of the name, and tidies the case of a name typed
// all in capitals or all in small letters.
//
// The client has a copy (client/src/lib/greet-name.ts) for the message
// preview; keep the two the same.

const HONORIFICS = new Set(['mr', 'mrs', 'ms', 'miss', 'smt', 'sri', 'shri', 'sriman', 'srimati', 'dr']);

/** "D", "D.", "D.V.", "K.S.R", or two letters without a vowel ("DV", "KS"). */
function isInitial(word: string): boolean {
  const letters = word.replace(/[^A-Za-z]/g, '');
  if (letters.length <= 1) return true;
  if (word.includes('.') && word.split('.').every((p) => p.replace(/[^A-Za-z]/g, '').length <= 1)) return true;
  return letters.length === 2 && !/[aeiouy]/i.test(letters);
}

function tidyCase(word: string): string {
  if (word !== word.toUpperCase() && word !== word.toLowerCase()) return word; // typed with care
  return word.toLowerCase().replace(/(^|[-'])([a-z])/g, (_m, sep: string, c: string) => sep + c.toUpperCase());
}

/**
 * The name to greet by, or '' when nothing usable is left (no name, a UPI
 * handle, only initials). Callers choose their own stand-in for ''.
 */
export function greetName(raw: string | null | undefined): string {
  const name = String(raw ?? '').trim();
  if (!name || name.includes('@') || /^donor\s*\d{6,}$/i.test(name)) return '';
  const words = name
    .replace(/[,_]+/g, ' ')
    .split(/\s+/)
    .filter((w) => /[A-Za-z]/.test(w))
    .filter((w) => !HONORIFICS.has(w.replace(/\./g, '').toLowerCase()))
    .filter((w) => !isInitial(w))
    .map((w) => tidyCase(w.replace(/\.+$/, '')));
  return words.join(' ');
}
