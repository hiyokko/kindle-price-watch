import assert from 'node:assert/strict';
import test from 'node:test';

import {
  extractAmazonHtmlSnapshotFromHtml,
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
