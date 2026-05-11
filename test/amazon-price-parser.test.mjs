import assert from 'node:assert/strict';
import test from 'node:test';

import {
  extractAmazonHtmlSnapshotFromHtml,
  extractKindleSeriesItemsFromHtml,
  extractMangaZenkanCompletionEvidenceFromHtml,
  extractSeriesCompletionStatusFromHtml
} from '../src/price-provider.mjs';

test('Amazon HTML parser keeps explicit Kindle price separate from discount and points', () => {
  const snapshot = extractAmazonHtmlSnapshotFromHtml(productHtml({
    title: '火の鳥 3',
    currentPrice: 297,
    listPrice: 330,
    promo: '70%OFF 3ポイント'
  }), 'B00JPXEATA', 'https://www.amazon.co.jp/dp/B00JPXEATA');

  assert.equal(snapshot.currentPrice, 297);
  assert.equal(snapshot.currentPoints, 3);
  assert.equal(snapshot.effectivePrice, 294);
  assert.equal(snapshot.listPrice, 330);
});

test('Amazon HTML parser does not invent a deep discount price from percent text', () => {
  const snapshot = extractAmazonHtmlSnapshotFromHtml(productHtml({
    title: '火の鳥 7',
    currentPrice: 330,
    listPrice: 330,
    promo: '70%OFF 3ポイント'
  }), 'B00JPXEB1M', 'https://www.amazon.co.jp/dp/B00JPXEB1M');

  assert.equal(snapshot.currentPrice, 330);
  assert.equal(snapshot.currentPoints, 3);
  assert.equal(snapshot.effectivePrice, 327);
  assert.equal(snapshot.listPrice, null);
});

test('Amazon HTML parser accepts genuinely small explicit yen prices', () => {
  const snapshot = extractAmazonHtmlSnapshotFromHtml(`
    <html>
      <head><meta property="og:title" content="Explicit sale"></head>
      <body>
        <span id="productTitle">Explicit sale</span>
        <div id="tmm-grid-swatch-KINDLE">Kindle版</div>
        <div id="kindleExtraMessage">または￥33(30pt)で購入</div>
        <div id="corePriceDisplay_desktop_feature_div">
          <span class="a-price"><span class="a-offscreen">￥33</span><span class="a-price-whole">33</span></span>
          <span>30ポイント</span>
        </div>
      </body>
    </html>
  `, 'B00TEST001', 'https://www.amazon.co.jp/dp/B00TEST001');

  assert.equal(snapshot.currentPrice, 33);
  assert.equal(snapshot.currentPoints, 30);
  assert.equal(snapshot.effectivePrice, 3);
});

test('Amazon HTML parser keeps series bundle discounts out of single-volume price', () => {
  const snapshot = extractAmazonHtmlSnapshotFromHtml(`
    <html>
      <head><meta property="og:title" content="王様ランキング(1) (BLIC)"></head>
      <body>
        <span id="productTitle">王様ランキング(1) (BLIC)</span>
        <div id="tmm-grid-swatch-KINDLE">
          Kindle版
          <span class="a-price" data-a-color="price">
            <span class="a-offscreen">￥644</span>
            <span class="a-price-whole">644</span>
          </span>
          <span>88ポイント</span>
        </div>
        <div id="series-bundle-offer">
          <span>シリーズまとめ買い</span>
          <span class="a-price a-text-price"><span class="a-offscreen">￥2,178</span></span>
          <span>90%OFF</span>
        </div>
      </body>
    </html>
  `, 'B08GC7TB1F', 'https://www.amazon.co.jp/dp/B08GC7TB1F');

  assert.equal(snapshot.currentPrice, 644);
  assert.equal(snapshot.currentPoints, 88);
  assert.equal(snapshot.effectivePrice, 556);
  assert.equal(snapshot.listPrice, null);
});

test('Amazon HTML parser reads the full yen amount instead of the leading digit', () => {
  const snapshot = extractAmazonHtmlSnapshotFromHtml(`
    <html>
      <head><meta property="og:title" content="Kindle full price"></head>
      <body>
        <span id="productTitle">Kindle full price</span>
        <script>{"price":0,"currencyCode":"JPY","amount":1}</script>
        <div id="tmm-grid-swatch-KINDLE">
          Kindle版
          <span class="a-price" data-a-color="price">
            <span class="a-offscreen">￥537</span>
            <span class="a-price-whole">537</span>
          </span>
          <span>5ポイント</span>
        </div>
        <div>その他中古品、新品、コレクター商品が￥35から</div>
      </body>
    </html>
  `, 'B00TEST002', 'https://www.amazon.co.jp/dp/B00TEST002');

  assert.equal(snapshot.currentPrice, 537);
  assert.equal(snapshot.currentPoints, 5);
  assert.equal(snapshot.effectivePrice, 532);
});

test('Amazon HTML parser ignores paper and used offers when Kindle swatch is present', () => {
  const snapshot = extractAmazonHtmlSnapshotFromHtml(`
    <html>
      <head><meta property="og:title" content="ディザインズ（１）"></head>
      <body>
        <span id="productTitle">ディザインズ（１）</span>
        <div id="tmm-grid-swatch-KINDLE">
          Kindle版（電子書籍）
          <span class="a-price" data-a-color="price">
            <span class="a-offscreen">￥792</span>
            <span class="a-price-whole">792</span>
          </span>
          <span>8pt</span>
          <span>すぐに購読可能</span>
        </div>
        <div id="tmm-grid-swatch-PAPERBACK">
          コミック（紙）
          <span class="a-price" data-a-color="base">
            <span class="a-offscreen">￥450</span>
            <span class="a-price-whole">450</span>
          </span>
        </div>
        <div>その他中古品、新品、コレクター商品が￥35から</div>
      </body>
    </html>
  `, 'B00TEST003', 'https://www.amazon.co.jp/dp/B00TEST003');

  assert.equal(snapshot.currentPrice, 792);
  assert.equal(snapshot.currentPoints, 8);
  assert.equal(snapshot.effectivePrice, 784);
});

test('Amazon series completion parser detects final-volume description text', () => {
  assert.equal(extractSeriesCompletionStatusFromHtml(`
    <html>
      <head><meta property="og:title" content="孤高の人 17"></head>
      <body>
        <h1>孤高の人 17</h1>
        <div id="bookDescription_feature_div">
          K2東壁に単独で挑んだ文太郎は、遂に人類未踏の領域に到達。
          現代に生きる「加藤文太郎」の生き様を描いた山岳ロマン、遂に完結!!
        </div>
      </body>
    </html>
  `), true);
});

test('Amazon series completion parser does not treat current volume count as completed', () => {
  assert.equal(extractSeriesCompletionStatusFromHtml(`
    <html>
      <head><meta property="og:title" content="連載中シリーズ (全17巻)"></head>
      <body>
        <h1>連載中シリーズ (全17巻)</h1>
        <div id="bookDescription_feature_div">次巻へ続く物語。</div>
      </body>
    </html>
  `), false);
});

test('MangaZenkan completion parser requires matching title and volume count', () => {
  const html = `
    <div class="search-result-item book">
      <a class="product-name">孤高の人 (1-17巻 全巻)</a>
      <table><tr><th>タグ</th><td>完結</td></tr></table>
    </div>
    <script>
      t[19]={product_id:2630,name:"孤高の人 (1-17巻 全巻)",tags:"完結",volume:null};
    </script>
  `;

  assert.deepEqual(extractMangaZenkanCompletionEvidenceFromHtml(html, '孤高の人', 17), {
    completed: true,
    source: 'mangazenkan_search'
  });
  assert.equal(extractMangaZenkanCompletionEvidenceFromHtml(html, '孤高の人', 18), null);
  assert.equal(
    extractMangaZenkanCompletionEvidenceFromHtml(
      '<div class="search-result-item"><a>孤高の人 (1-17巻 全巻)</a><span>未完結</span></div>',
      '孤高の人',
      17
    ),
    null
  );
});

test('Amazon series parser reads child-list Kindle price and points', () => {
  const items = extractKindleSeriesItemsFromHtml(`
    <html>
      <head><meta property="og:title" content="闇麻のマミヤ (7 book series)"></head>
      <body>
        <div id="series-childAsin-list">
          <div id="series-childAsin-item_1" class="series-childAsin-item">
            <a class="itemImageLink" title="闇麻のマミヤ 1" href="/gp/product/B08F4WVC97?storeType=ebooks">
              <img alt="闇麻のマミヤ 1" src="https://m.media-amazon.com/images/I/51l9gHeEqJL._SY300_.jpg">
            </a>
            <a id="itemBookTitle_1" class="itemBookTitle" href="/gp/product/B08F4WVC97?storeType=ebooks"><h3>闇麻のマミヤ 1</h3></a>
            <span class="a-size-large a-color-price">￥495</span>
            <span class="itemPointsLabel">獲得ポイント:</span><span class="itemPoints">5pt</span>
            <span>その他の形式:</span><a>コミック (紙) ￥880</a>
          </div>
          <div id="series-childAsin-item_2" class="series-childAsin-item">
            <a class="itemImageLink" title="闇麻のマミヤ 2" href="/gp/product/B08TM181FR?storeType=ebooks">
              <img alt="闇麻のマミヤ 2" src="https://m.media-amazon.com/images/I/51second._SY300_.jpg">
            </a>
            <a id="itemBookTitle_2" class="itemBookTitle" href="/gp/product/B08TM181FR?storeType=ebooks"><h3>闇麻のマミヤ 2</h3></a>
            <span class="a-size-large a-color-price">￥495</span>
            <span class="itemPointsLabel">獲得ポイント:</span><span class="itemPoints">5pt</span>
          </div>
        </div>
      </body>
    </html>
  `);

  assert.equal(items.length, 2);
  assert.equal(items[0].asin, 'B08F4WVC97');
  assert.equal(items[0].currentPrice, 495);
  assert.equal(items[0].currentPoints, 5);
  assert.equal(items[0].effectivePrice, 490);
  assert.equal(items[0].provider, 'amazon_series_child');
});

test('Amazon series parser uses visible child-list points before bulk prices', () => {
  const items = extractKindleSeriesItemsFromHtml(`
    <html>
      <body>
        <div id="series-childAsin-list">
          <div id="series-childAsin-item_1" class="series-childAsin-item">
            <a class="itemImageLink" title="長編シリーズ 1" href="/gp/product/B08F4WVC97?storeType=ebooks">
              <img alt="長編シリーズ 1" src="https://m.media-amazon.com/images/I/51one._SY300_.jpg">
            </a>
            <span class="a-size-large a-color-price">￥616</span>
            <span class="itemPoints">6pt</span>
          </div>
          <div id="series-childAsin-item_2" class="series-childAsin-item">
            <a class="itemImageLink" title="長編シリーズ 2" href="/gp/product/B08TM181FR?storeType=ebooks">
              <img alt="長編シリーズ 2" src="https://m.media-amazon.com/images/I/51two._SY300_.jpg">
            </a>
            <span class="a-size-large a-color-price">￥616</span>
            <span class="itemPoints">6pt</span>
          </div>
        </div>
        <form>
          <input name="items[0].action.asin" value="B08F4WVC97">
          <input name="items[0].action.displayedPrice.value" value="616.00">
          <input name="items[0].action.displayedPrice.currency" value="JPY">
          <input name="items[1].action.asin" value="B08TM181FR">
          <input name="items[1].action.displayedPrice.value" value="616.00">
          <input name="items[1].action.displayedPrice.currency" value="JPY">
          <input name="items[2].action.asin" value="B09FQ2RX86">
          <input name="items[2].action.displayedPrice.value" value="616.00">
          <input name="items[2].action.displayedPrice.currency" value="JPY">
        </form>
      </body>
    </html>
  `);

  assert.equal(items.length, 3);
  assert.equal(items[0].currentPrice, 616);
  assert.equal(items[0].currentPoints, 6);
  assert.equal(items[0].effectivePrice, 610);
  assert.equal(items[0].provider, 'amazon_series_child');
  assert.equal(items[2].currentPrice, 616);
  assert.equal(items[2].currentPoints, 0);
  assert.equal(items[2].provider, 'amazon_series_bulk');
});

test('Amazon series parser reads paginated child-list fragments', () => {
  const items = extractKindleSeriesItemsFromHtml(`
    <div id="series-childAsin-batch_2" class="series-childAsin-batch">
      <div id="series-childAsin-item_11" class="series-childAsin-item">
        <a class="itemImageLink" title="長編シリーズ 11" href="/gp/product/B00DMUL9UK?storeType=ebooks">
          <img alt="長編シリーズ 11" src="https://m.media-amazon.com/images/I/51eleven._SY300_.jpg">
        </a>
        <span class="a-size-large a-color-price">￥616</span>
        <span class="itemPoints">6pt</span>
      </div>
      ${' '.repeat(230000)}
      <div id="series-childAsin-item_12" class="series-childAsin-item">
        <a class="itemImageLink" title="長編シリーズ 12" href="/gp/product/B00DMUL9WI?storeType=ebooks">
          <img alt="長編シリーズ 12" src="https://m.media-amazon.com/images/I/51twelve._SY300_.jpg">
        </a>
        <span class="a-size-large a-color-price">￥616</span>
        <span class="itemPoints">6pt</span>
      </div>
    </div>
  `);

  assert.equal(items.length, 2);
  assert.equal(items[0].asin, 'B00DMUL9UK');
  assert.equal(items[0].currentPrice, 616);
  assert.equal(items[0].currentPoints, 6);
  assert.equal(items[1].asin, 'B00DMUL9WI');
  assert.equal(items[1].currentPrice, 616);
  assert.equal(items[1].currentPoints, 6);
});

function productHtml({ title, currentPrice, listPrice, promo }) {
  return `
    <html>
      <head><meta property="og:title" content="${title}"></head>
      <body>
        <span id="productTitle">${title}</span>
        <div id="tmm-grid-swatch-KINDLE">Kindle版</div>
        <div id="corePriceDisplay_desktop_feature_div">
          <span class="a-price" data-a-color="price">
            <span class="a-offscreen">￥${currentPrice.toLocaleString('ja-JP')}</span>
            <span class="a-price-whole">${currentPrice.toLocaleString('ja-JP')}</span>
          </span>
          <span class="a-price a-text-price">
            <span class="a-offscreen">￥${listPrice.toLocaleString('ja-JP')}</span>
          </span>
          <span>${promo}</span>
        </div>
      </body>
    </html>
  `;
}
