import assert from 'node:assert/strict';
import test from 'node:test';

import { amazonUrlForAsin, extractAsin, isKindleSeriesUrl } from '../src/amazon-url.mjs';

test('Amazon URL helpers normalize product and Kindle DBS inputs', () => {
  assert.equal(extractAsin('https://www.amazon.co.jp/dp/B0DPDXNFQN?tag=example'), 'B0DPDXNFQN');
  assert.equal(
    extractAsin('https://www.amazon.co.jp/kindle-dbs/product/B074CC3WXH'),
    'B074CC3WXH'
  );
  assert.equal(isKindleSeriesUrl('https://www.amazon.co.jp/kindle-dbs/product/B074CC3WXH'), true);
  assert.equal(amazonUrlForAsin('B0DPDXNFQN'), 'https://www.amazon.co.jp/dp/B0DPDXNFQN');
});
