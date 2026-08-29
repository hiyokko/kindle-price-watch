function candidateAsins(candidate = {}) {
  return new Set(
    (Array.isArray(candidate.items) ? candidate.items : [])
      .map((item) => String(item?.asin || '').trim().toUpperCase())
      .filter(Boolean)
  );
}

export function normalizeSeriesIdentityName(value = '') {
  return String(value || '')
    .normalize('NFKC')
    .replace(/\s*[（(][^（）()]{0,100}(?:コミックス?|COMICS?|文庫|新書|Kindle|電子)[^（）()]{0,100}[）)]\s*$/giu, '')
    .replace(/\s*[（(]\s*全\s*[0-9]{1,4}\s*巻\s*[）)]\s*$/giu, '')
    .replace(/\s*(?:Kindle Edition|Kindle版)\s*$/giu, '')
    .replace(/[\s　]+/gu, '')
    .replace(/[()（）\[\]［］【】「」『』〈〉《》!！?？,，.。:：・'"“”‘’`´~〜～—―_\-‐‑‒–]/gu, '')
    .toLowerCase();
}

export function seriesCandidatesHaveItemOverlap(left = {}, right = {}) {
  const leftAsins = candidateAsins(left);
  if (leftAsins.size === 0) return false;

  for (const asin of candidateAsins(right)) {
    if (leftAsins.has(asin)) return true;
  }
  return false;
}

export function seriesCandidatesAreCompatible(left = {}, right = {}) {
  if (seriesCandidatesHaveItemOverlap(left, right)) return true;

  const leftName = normalizeSeriesIdentityName(left.seriesName);
  const rightName = normalizeSeriesIdentityName(right.seriesName);
  if (!leftName || !rightName || leftName === 'kindleシリーズ' || rightName === 'kindleシリーズ') return false;
  if (leftName === rightName) return true;

  const shorter = leftName.length <= rightName.length ? leftName : rightName;
  const longer = shorter === leftName ? rightName : leftName;
  return shorter.length >= 4 && longer.includes(shorter) && shorter.length / longer.length >= 0.75;
}
