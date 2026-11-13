/**
 * Claude's Markdown answer turned into text worth reading aloud: code blocks, tables, file paths,
 * URLs and code-looking inline spans are left out, the prose stays.
 */

/** Inline code that is a plain word or two ("Send", "dark mode") is read; anything code-like is not. */
function inlineCode(content: string): string {
  return /^[\p{L}][\p{L} -]{0,24}$/u.test(content) && !/[A-Z].*[A-Z]|_/.test(content.slice(1)) ? content : '';
}

const PATH = /(?:~|\.{1,2})?(?:\/[\w.@+-]+)+\/?(?::\d+(?:-\d+)?)?|\b[\w.-]+\/[\w./-]+(?::\d+)?|\b[\w-]+\.(?:tsx?|jsx?|mjs|cjs|json|md|css|scss|html|py|rb|go|rs|php|java|kt|swift|sh|ya?ml|toml|sql|txt|lock)(?::\d+(?:-\d+)?)?\b/g;

export function speakableText(markdown: string): string {
  let text = markdown.replace(/\r\n?/g, '\n');
  text = text.replace(/```[\s\S]*?(?:```|$)/g, '\n');
  text = text.replace(/~~~[\s\S]*?(?:~~~|$)/g, '\n');
  text = text
    .split('\n')
    .filter((line) => !/^\s*\|/.test(line) && !/^\s{4,}\S/.test(line) && !/^\s*[-*_]{3,}\s*$/.test(line))
    .join('\n');
  text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, '');
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  text = text.replace(/`([^`\n]+)`/g, (_m, content: string) => inlineCode(content));
  text = text.replace(/\bhttps?:\/\/\S+/g, '');
  text = text.replace(PATH, '');
  text = text.replace(/^\s{0,3}#{1,6}\s+/gm, '');
  text = text.replace(/^\s*(?:[-*+•]|\d+[.)])\s+/gm, '');
  text = text.replace(/^\s*>\s?/gm, '');
  text = text.replace(/(\*\*|__|\*|_)(?=\S)([^\n]*?\S)\1/g, '$2');
  // Lines become sentences; a list item without closing punctuation still gets a pause.
  const lines = text
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').replace(/\s+([.,:;!?])/g, '$1').replace(/\(\s*\)/g, '').trim())
    .filter((line) => /[\p{L}\p{N}]/u.test(line));
  return lines.map((line) => (/[.!?…:;]$/.test(line) ? line : `${line}.`)).join(' ').replace(/\s+/g, ' ').trim();
}

/** Splits speech into pieces of at most `max` characters at sentence ends, so the first one plays soon. */
export function speechChunks(text: string, max = 400): string[] {
  const sentences = text.match(/[^.!?…]+(?:[.!?…]+|$)\s*/g) ?? [];
  const chunks: string[] = [];
  let current = '';
  for (const raw of sentences) {
    const sentence = raw.trim();
    if (!sentence) continue;
    if (current && current.length + sentence.length + 1 > max) {
      chunks.push(current);
      current = '';
    }
    if (sentence.length > max) {
      for (let i = 0; i < sentence.length; i += max) chunks.push(sentence.slice(i, i + max));
      continue;
    }
    current = current ? `${current} ${sentence}` : sentence;
  }
  if (current) chunks.push(current);
  return chunks;
}
