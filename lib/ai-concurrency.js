const LIMITS = {
  translation: 3,
  vision: 2,
};

const state = {
  translation: { active: 0, queue: [] },
  vision: { active: 0, queue: [] },
};

async function withSlot(kind, fn) {
  const bucket = state[kind];
  const limit = LIMITS[kind];
  if (!bucket || !limit) return fn();

  if (bucket.active >= limit) {
    await new Promise((resolve) => bucket.queue.push(resolve));
  }

  bucket.active += 1;
  try {
    return await fn();
  } finally {
    bucket.active = Math.max(0, bucket.active - 1);
    const next = bucket.queue.shift();
    if (next) next();
  }
}

export function withTranslationSlot(fn) {
  return withSlot('translation', fn);
}

export function withVisionSlot(fn) {
  return withSlot('vision', fn);
}

export function getAiConcurrencyLimits() {
  return { ...LIMITS };
}
