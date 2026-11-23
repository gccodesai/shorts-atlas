// Input guardrails, shared by the Worker and the browser (copied to web/js by
// `npm run sync`; a test checks the two copies are identical).
// Pure functions, no dependencies, deterministic: easy to test and explain.

export const MAX_CHARS = 64;
export const MAX_WORDS = 8;

// Letters and marks in any script, digits, spaces and a little punctuation
// that song titles use (AC/DC, Mission: Impossible). Everything else
// (double quotes, ; < > = \ @ etc.) is out,
// which removes SQL and HTML injection characters before any other check.
const ALLOWED = /^[\p{L}\p{M}\p{N} '\u2019&.,!?#:\/()-]+$/u;

const CONTROL_OR_INVISIBLE = /[\p{Cc}\p{Cf}\u2028\u2029]/gu;

const PII_RULES = [
  { code: 'pii_email', re: /[^\s@]+@[^\s@]+\.[^\s@]+/, msg: 'Please remove email addresses.' },
  { code: 'pii_handle', re: /(^|\s)@\w/, msg: 'Please remove @handles or usernames.' },
  { code: 'pii_url', re: /(https?:\/\/|www\.|\b[a-z0-9-]+\.(com|net|org|io|ai|co|me|tv|ly|gg|app|dev|in|uk|de)\b)/i, msg: 'Please remove links.' },
  // 7+ digits once separators are ignored: phone numbers, IDs, card numbers.
  { code: 'pii_number', re: /(\d[\s.()-]*){7,}/, msg: 'Please remove long numbers such as phone or ID numbers.' },
];

const INJECTION_RULES = [
  /--|\/\*|\*\/|;/,
  /\b(union\s+select|select\s+.+\s+from|drop\s+table|insert\s+into|delete\s+from|update\s+\w+\s+set)\b/i,
  /\b(or|and)\s+['"]?\d+['"]?\s*=\s*['"]?\d+/i,
  /<\s*\/?\s*(script|iframe|img|svg|system)\b/i,
  /\b(ignore|disregard|forget)\s+(all\s+|any\s+|the\s+)?(previous|prior|above)\s+(instructions|prompts|rules)\b/i,
  /\b(system\s+prompt|jailbreak|developer\s+mode)\b/i,
];

// Deliberately short: YouTube's safeSearch=strict is the main content filter.
// This list stops the most obvious requests before any API call is spent.
const UNSAFE_TERMS = /\b(porn\w*|nsfw|xxx|nude\w*|naked|hentai|onlyfans|gore|beheading|execution\s+video|suicide\s+method\w*|self[\s-]?harm)\b/i;

/**
 * Validate and normalize a search query.
 * @returns {{ok: true, query: string, key: string} | {ok: false, code: string, message: string}}
 */
export function validateQuery(raw) {
  if (typeof raw !== 'string') return fail('invalid', 'Type a word, song title or theme.');
  const query = raw.normalize('NFKC').replace(CONTROL_OR_INVISIBLE, '').replace(/\s+/g, ' ').trim();

  if (!query) return fail('empty', 'Type a word, song title or theme.');
  if ([...query].length > MAX_CHARS) return fail('too_long', `Keep it to ${MAX_CHARS} characters.`);
  if (query.split(' ').length > MAX_WORDS) return fail('too_many_words', `Keep it to ${MAX_WORDS} words.`);

  for (const rule of PII_RULES) {
    if (rule.re.test(query)) return fail(rule.code, rule.msg + ' Searches must not include personal details.');
  }
  for (const re of INJECTION_RULES) {
    if (re.test(query)) return fail('injection', "That doesn't look like a search. Try a word, song title or theme.");
  }
  if (!ALLOWED.test(query)) return fail('characters', "Use letters, numbers, spaces and ' & . , ! ? # : / ( ) - only.");
  if (UNSAFE_TERMS.test(query)) return fail('unsafe', "This search isn't available. Try another theme.");

  return { ok: true, query, key: query.toLowerCase() };
}

function fail(code, message) {
  return { ok: false, code, message };
}
