/**
 * What to do with a recognised phrase before it goes to Claude. whisper.cpp invents stock phrases on
 * silence or noise, mostly subtitle credits from its training data; Russian and English ones are
 * dropped. The list holds Russian text on purpose: Russian is the default dictation language.
 */

const PHANTOMS: readonly RegExp[] = [
  /^продолжение следует/i,
  /^субтитры/i,
  /^редактор субтитров/i,
  /^спасибо за (просмотр|внимание)/i,
  /^подписывайтесь на (наш )?канал/i,
  /dimatorzok/i,
  /^thanks? (you )?for watching/i,
  /^subtitles by/i,
  /^you$/i,
];

/** Text to send, or null when the phrase is empty, punctuation only, or a known whisper phantom. */
export function phraseToSend(text: string): string | null {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!/[\p{L}\p{N}]/u.test(clean)) return null;
  const bare = clean.replace(/^[\s.,!?…"'«»()-]+|[\s.,!?…"'«»()-]+$/gu, '');
  if (PHANTOMS.some((pattern) => pattern.test(bare))) return null;
  return clean;
}
