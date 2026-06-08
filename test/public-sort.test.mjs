import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

function loadAppSortContext() {
  const source = fs
    .readFileSync(new URL('../public/app.js', import.meta.url), 'utf8')
    .replace(/load\(\)\.catch\(\(error\) => setMessage\(error\.message, 'error'\)\);\s*$/, '');
  const elementStub = () =>
    new Proxy(function () {}, {
      get(_target, property) {
        if (property === 'addEventListener') return () => {};
        if (property === 'classList') return { add() {}, remove() {}, toggle() {} };
        if (property === 'dataset') return {};
        if (property === 'content') return { cloneNode: () => elementStub() };
        if (property === 'querySelector') return () => elementStub();
        if (property === 'querySelectorAll') return () => [];
        if (['appendChild', 'replaceChildren', 'remove', 'focus', 'showModal', 'close'].includes(property)) return () => {};
        return '';
      },
      set() {
        return true;
      },
      apply() {
        return elementStub();
      }
    });

  const context = {
    document: {
      getElementById: elementStub,
      createElement: elementStub,
      createDocumentFragment: elementStub
    },
    localStorage: {
      getItem: () => null,
      setItem: () => {}
    },
    fetch: async () => {
      throw new Error('fetch disabled in sort tests');
    },
    console,
    Date,
    Map,
    Math,
    Number,
    Set,
    String,
    URL
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  return context;
}

test('discount sort primarily orders by series discount rate', () => {
  const { compareGroupsByDiscountRate } = loadAppSortContext();
  const completeLowerDiscount = {
    title: 'complete lower',
    totalMetrics: {
      discountRate: 50,
      discountComplete: true,
      discountPricedCount: 5,
      missing: 0,
      unregistered: 0,
      effectiveTotal: 2500
    }
  };
  const incompleteHigherDiscount = {
    title: 'incomplete higher',
    totalMetrics: {
      discountRate: 80,
      discountComplete: false,
      discountPricedCount: 4,
      missing: 1,
      unregistered: 0,
      effectiveTotal: 1200
    }
  };

  assert.equal(compareGroupsByDiscountRate(incompleteHigherDiscount, completeLowerDiscount) < 0, true);
});

test('average price sort orders by per-book effective average before total price', () => {
  const { compareGroupsByAveragePrice } = loadAppSortContext();
  const lowerEffectiveAverageHigherTotal = {
    title: 'lower effective average higher total',
    totalMetrics: {
      pricedCount: 5,
      complete: true,
      totalPrice: 1500,
      effectiveTotal: 750,
      averagePrice: 300,
      averageEffectivePrice: 150
    }
  };
  const higherEffectiveAverageLowerTotal = {
    title: 'higher effective average lower total',
    totalMetrics: {
      pricedCount: 2,
      complete: true,
      totalPrice: 600,
      effectiveTotal: 400,
      averagePrice: 300,
      averageEffectivePrice: 200
    }
  };

  assert.equal(compareGroupsByAveragePrice(lowerEffectiveAverageHigherTotal, higherEffectiveAverageLowerTotal) < 0, true);
});

test('series total label includes per-book average effective price', () => {
  const { seriesTotalLabel } = loadAppSortContext();
  const label = seriesTotalLabel({
    books: [
      { currentPrice: 300, currentPoints: 50, effectivePrice: 250 },
      { currentPrice: 500, currentPoints: 50, effectivePrice: 450 }
    ],
    expectedCount: 2
  });

  assert.match(label, /合計 ¥800 \/ 平均 ¥350 \/ 100pt（実質 ¥700）/);
});

test('series meta uses representative author, publisher, and series ASIN', () => {
  const { seriesMetaLabel } = loadAppSortContext();

  assert.equal(
    seriesMetaLabel({
      sourceUrl: 'https://www.amazon.co.jp/dp/B074C597F1?ref_=dbs_s_ks_series_rwt',
      seriesKey: '',
      books: [
        {
          author: '三浦建太郎',
          publisher: '白泉社',
          asin: 'B00E3RA01K'
        }
      ]
    }),
    '三浦建太郎 / 白泉社 / B074C597F1'
  );
});

test('series books sort by parenthesized volume before imprint text', () => {
  const { compareBooksWithinGroup } = loadAppSortContext();
  const books = [
    { title: '王様ランキング(16) (BLIC)', volume: 1 },
    { title: '王様ランキング(2) (BLIC)', volume: 2 },
    { title: '王様ランキング (BLIC) １８', volume: 18 }
  ].sort(compareBooksWithinGroup);

  assert.deepEqual(books.map((book) => book.title), [
    '王様ランキング(2) (BLIC)',
    '王様ランキング(16) (BLIC)',
    '王様ランキング (BLIC) １８'
  ]);
});

test('sale badge ignores ordinary point-only discounts', () => {
  const { isBelowList, badgeFor } = loadAppSortContext();

  assert.equal(
    isBelowList({
      currentPrice: 440,
      currentPoints: 4,
      effectivePrice: 436,
      listPrice: 440,
      discountRate: 1
    }),
    false
  );
  assert.equal(
    badgeFor({
      currentPrice: 440,
      currentPoints: 4,
      effectivePrice: 436,
      listPrice: 440,
      discountRate: 1
    }).label,
    '通常'
  );
  assert.equal(
    isBelowList({
      currentPrice: 396,
      currentPoints: 4,
      effectivePrice: 392,
      listPrice: 440,
      discountRate: 11
    }),
    true
  );
  assert.equal(
    isBelowList({
      currentPrice: 440,
      currentPoints: 50,
      effectivePrice: 390,
      listPrice: 440,
      discountRate: 11
    }),
    true
  );
});

test('sale badge and series discount use observed reference prices when list price is absent', () => {
  const { bookDiscountRate, isBelowList, seriesTotalMetrics } = loadAppSortContext();
  const book = {
    currentPrice: 396,
    currentPoints: 4,
    effectivePrice: 392,
    listPrice: null,
    discountReferencePrice: 440,
    discountRate: 11
  };

  assert.equal(isBelowList(book), true);
  assert.equal(bookDiscountRate(book), 11);

  const metrics = seriesTotalMetrics({
    books: [
      book,
      {
        currentPrice: 440,
        currentPoints: 4,
        effectivePrice: 436,
        listPrice: null,
        discountReferencePrice: 440,
        discountRate: 1
      }
    ],
    expectedCount: 2
  });

  assert.equal(metrics.listTotal, 880);
  assert.equal(metrics.discountRate, 6);
});

test('registration sort uses the latest checked time for a fully checked series', () => {
  const { groupCheckedSortTime, compareGroupsByQueueOrder } = loadAppSortContext();
  const laterSeriesCheck = groupCheckedSortTime([
    { lastCheckedAt: '2026-05-15T12:00:00.000Z' },
    { lastCheckedAt: '2026-05-16T12:00:00.000Z' }
  ]);
  const earlierSeriesCheck = groupCheckedSortTime([
    { lastCheckedAt: '2026-05-15T18:00:00.000Z' },
    { lastCheckedAt: '2026-05-15T19:00:00.000Z' }
  ]);

  assert.equal(laterSeriesCheck, Date.parse('2026-05-16T12:00:00.000Z'));
  assert.equal(
    compareGroupsByQueueOrder(
      { title: 'later', sortCheckedAt: laterSeriesCheck, sortRegisteredAt: 0, order: 0 },
      { title: 'earlier', sortCheckedAt: earlierSeriesCheck, sortRegisteredAt: 0, order: 1 }
    ) > 0,
    true
  );
});

test('last cron new releases are inferred from series discovery additions', () => {
  const { newReleaseBooksFromLastCron } = loadAppSortContext();
  const automation = {
    lastCronStartedAt: '2026-05-12T09:28:35.000Z',
    lastCronFinishedAt: '2026-05-12T14:25:52.000Z',
    lastSeriesDiscoveryAdded: 2
  };
  const books = [
    {
      id: 'existing',
      title: '既存巻',
      importMode: 'kindle_series',
      createdAt: '2026-05-01T00:00:00.000Z',
      seriesLastDiscoveredAt: '2026-05-12T09:42:44.000Z'
    },
    {
      id: 'queued-import',
      title: '追加キュー',
      importMode: 'kindle_series',
      createdAt: '2026-05-12T09:28:35.000Z',
      seriesLastDiscoveredAt: '2026-05-12T09:28:35.000Z'
    },
    {
      id: 'new-1',
      title: '新刊1',
      importMode: 'kindle_series',
      createdAt: '2026-05-12T10:00:00.000Z',
      seriesLastDiscoveredAt: '2026-05-12T10:00:00.000Z'
    },
    {
      id: 'new-2',
      title: '新刊2',
      importMode: 'kindle_series',
      createdAt: '2026-05-12T11:00:00.000Z',
      seriesLastDiscoveredAt: '2026-05-12T11:00:00.000Z'
    },
    {
      id: 'manual',
      title: '手動追加',
      importMode: 'single',
      createdAt: '2026-05-12T12:00:00.000Z',
      seriesLastDiscoveredAt: '2026-05-12T12:00:00.000Z'
    }
  ];

  assert.deepEqual(
    newReleaseBooksFromLastCron(books, automation).map((book) => book.id),
    ['new-2', 'new-1']
  );
});

test('last cron new releases use stored addition identities when available', () => {
  const { newReleaseBooksFromLastCron, lastCronNewReleaseCount } = loadAppSortContext();
  const automation = {
    lastCronStartedAt: '2026-05-12T09:28:35.000Z',
    lastCronFinishedAt: '2026-05-12T14:25:52.000Z',
    lastSeriesDiscoveryAdded: 3,
    lastSeriesDiscoveryAdditions: [
      { id: 'new-1', asin: 'B000000001' },
      { id: 'removed', asin: 'B000000099' },
      { asin: 'B000000002' }
    ]
  };
  const books = [
    {
      id: 'new-1',
      asin: 'B000000001',
      title: '新刊1',
      importMode: 'kindle_series',
      createdAt: '2026-05-01T00:00:00.000Z',
      seriesLastDiscoveredAt: '2026-05-12T10:00:00.000Z'
    },
    {
      id: 'new-2',
      asin: 'B000000002',
      title: '新刊2',
      importMode: 'kindle_series',
      createdAt: '2026-05-02T00:00:00.000Z',
      seriesLastDiscoveredAt: '2026-05-12T11:00:00.000Z'
    }
  ];

  assert.equal(lastCronNewReleaseCount(automation), 3);
  assert.deepEqual(
    Array.from(newReleaseBooksFromLastCron(books, automation).map((book) => book.id)),
    ['new-2', 'new-1']
  );
});

test('last cron new releases do not fall back to stale raw counts when stored additions are empty', () => {
  const { newReleaseBooksFromLastCron, lastCronNewReleaseCount } = loadAppSortContext();
  const automation = {
    lastCronStartedAt: '2026-05-12T09:28:35.000Z',
    lastCronFinishedAt: '2026-05-12T14:25:52.000Z',
    lastSeriesDiscoveryAdded: 1,
    lastSeriesDiscoveryAdditions: []
  };
  const books = [
    {
      id: 'legacy-match',
      title: '旧ロジックなら拾われる本',
      importMode: 'kindle_series',
      createdAt: '2026-05-12T10:00:00.000Z',
      seriesLastDiscoveredAt: '2026-05-12T10:00:00.000Z'
    }
  ];

  assert.equal(lastCronNewReleaseCount(automation), 0);
  assert.deepEqual(Array.from(newReleaseBooksFromLastCron(books, automation)), []);
});

test('discount sort uses completeness and coverage only as tie breakers', () => {
  const { compareGroupsByDiscountRate } = loadAppSortContext();
  const complete = {
    title: 'complete',
    totalMetrics: {
      discountRate: 70,
      discountComplete: true,
      discountPricedCount: 5,
      missing: 0,
      unregistered: 0,
      effectiveTotal: 1500
    }
  };
  const incomplete = {
    title: 'incomplete',
    totalMetrics: {
      discountRate: 70,
      discountComplete: false,
      discountPricedCount: 4,
      missing: 1,
      unregistered: 0,
      effectiveTotal: 1200
    }
  };
  const noDiscount = {
    title: 'none',
    totalMetrics: {
      discountRate: null,
      discountComplete: false,
      discountPricedCount: 0,
      missing: 0,
      unregistered: 0,
      effectiveTotal: 0
    }
  };

  assert.equal(compareGroupsByDiscountRate(complete, incomplete) < 0, true);
  assert.equal(compareGroupsByDiscountRate(incomplete, noDiscount) < 0, true);
});
