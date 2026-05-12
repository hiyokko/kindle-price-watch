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

test('average price sort orders by per-book average before total price', () => {
  const { compareGroupsByAveragePrice } = loadAppSortContext();
  const lowerAverageHigherTotal = {
    title: 'lower average higher total',
    totalMetrics: {
      pricedCount: 5,
      complete: true,
      totalPrice: 1000,
      effectiveTotal: 1000,
      averagePrice: 200,
      averageEffectivePrice: 200
    }
  };
  const higherAverageLowerTotal = {
    title: 'higher average lower total',
    totalMetrics: {
      pricedCount: 2,
      complete: true,
      totalPrice: 600,
      effectiveTotal: 600,
      averagePrice: 300,
      averageEffectivePrice: 300
    }
  };

  assert.equal(compareGroupsByAveragePrice(lowerAverageHigherTotal, higherAverageLowerTotal) < 0, true);
});

test('series total label includes per-book average price', () => {
  const { seriesTotalLabel } = loadAppSortContext();
  const label = seriesTotalLabel({
    books: [
      { currentPrice: 300, currentPoints: 0, effectivePrice: 300 },
      { currentPrice: 500, currentPoints: 0, effectivePrice: 500 }
    ],
    expectedCount: 2
  });

  assert.match(label, /合計 ¥800 \/ 平均 ¥400/);
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
