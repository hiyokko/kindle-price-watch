export function isUnusableBookTitle(title) {
  const value = String(title || '').trim();
  const compact = value.replace(/\s+/g, '');
  return !value || /^(?:https?:\/\/|www\.)\S+$/i.test(value) ||
    /^!?\[[\s\S]*\]\(https?:\/\//i.test(value) || /^URL\s*Source:/i.test(value) ||
    /(?:503|ServiceUnavailable|サービスが利用できません|RobotCheck|CAPTCHA|ショッピングを続けてください)/i.test(compact) ||
    /^Amazon\.co\.jp$/i.test(compact);
}

export function preferBookTitle(primary, fallback = '') {
  const candidates = [primary, fallback].map(value => String(value || '').trim()).filter(value => !isUnusableBookTitle(value));
  return candidates.find(value => !/^ASIN\s+[A-Z0-9]{10}$/i.test(value)) || candidates[0] || '';
}

export function recoverBookTitle(book, history = []) {
  if (!isUnusableBookTitle(book?.title)) return book.title;
  const asin = String(book?.asin || '').toUpperCase();
  const candidates = history.filter(entry => {
    const sameIdentity = entry.asin ? String(entry.asin).toUpperCase() === asin : book.id && entry.bookId === book.id;
    return sameIdentity && !isUnusableBookTitle(entry.title) && !/^ASIN\s+[A-Z0-9]{10}$/i.test(entry.title);
  }).sort((a, b) => (Date.parse(a.checkedAt || '') || 0) - (Date.parse(b.checkedAt || '') || 0));
  const seriesTitle = book.seriesName && book.volume ? `${book.seriesName} ${book.volume}` : '';
  return preferBookTitle(candidates[0]?.title, seriesTitle) || (asin ? `ASIN ${asin}` : '');
}
