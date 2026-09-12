export function parseCommand(text) {
  const value = String(text || '').trim();
  const match = value.match(/^\/([a-z0-9_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/i);
  if (!match) return null;
  return {
    name: String(match[1] || '').toLowerCase(),
    args: String(match[2] || '').trim(),
    raw: value,
  };
}

export function isCommand(text, name) {
  const parsed = parseCommand(text);
  return Boolean(parsed && parsed.name === String(name || '').toLowerCase());
}
