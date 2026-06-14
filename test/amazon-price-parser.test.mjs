import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyKnownSeriesCompletionOverride,
  cleanAmazonSeriesName,
  extractAsin,
  extractAmazonHtmlSnapshotFromHtml,
  extractKindleSeriesItemsFromHtml,
  extractMangaZenkanCompletionEvidenceFromHtml,
  extractSeriesCompletionStatusFromHtml,
  fetchAmazonHtmlSnapshot,
  fetchKindleSeriesItems,
  isKindleSeriesUrl,
  shouldDeferAmazonReaderPrice
} from '../src/price-provider.mjs';

test('Amazon Kindle DBS product URLs are treated as series URLs', () => {
  const url = 'https://www.amazon.co.jp/kindle-dbs/product/B0DPDXNFQN';
  assert.equal(extractAsin(url), 'B0DPDXNFQN');
  assert.equal(isKindleSeriesUrl(url), true);
});

test('Amazon series names drop store chrome, author text, and volume markers', () => {
  assert.equal(
    cleanAmazonSeriesName('Amazon.co.jp: サーチアンドデストロイ 3 (TCコミックス) eBook : カネコアツシ: Kindleストア'),
    'サーチアンドデストロイ'
  );
  assert.equal(
    cleanAmazonSeriesName('Amazon.co.jp: SPUNK - スパンク！ - 1 (ビームコミックス) eBook : 新井 英樹, 鏡 ゆみこ: Kindleストア'),
    'SPUNK - スパンク！'
  );
  assert.equal(
    cleanAmazonSeriesName('Amazon.co.jp: ヒストリエ（３） (アフタヌーンコミックス) eBook : 岩明均: Kindleストア'),
    'ヒストリエ'
  );
  assert.equal(
    cleanAmazonSeriesName('Amazon.co.jp: 火の鳥 1 eBook : 手塚治虫: Kindleストア'),
    '火の鳥'
  );
  assert.equal(
    cleanAmazonSeriesName('Amazon.co.jp: 左ききのエレン 1 (ジャンプコミックスDIGITAL) eBook : かっぴー, nifuni: Kindleストア'),
    '左ききのエレン'
  );
  assert.equal(
    cleanAmazonSeriesName('銀河の死なない子供たちへ（上） (電撃コミックスNEXT)'),
    '銀河の死なない子供たちへ'
  );
  assert.equal(
    cleanAmazonSeriesName('銀河の死なない子供たちへ 下 Kindle版'),
    '銀河の死なない子供たちへ'
  );
});

test('Amazon series parser keeps bulk volume when child list repeats the first volume title', () => {
  const items = extractKindleSeriesItemsFromHtml(`
    <meta property="og:title" content="進撃の巨人 (全34巻)" />
    <div data-offer-asins="B009KYC6S6,B009KYC6SQ,B009KYC6U4,B009KYC6UY"></div>
    <div id="series-childAsin-list">
      <div id="series-childAsin-item_0" data-asin="B009KYC6UY">
        <a href="/dp/B009KYC6UY" title="進撃の巨人 １">進撃の巨人 １</a>
      </div>
    </div>
  `);

  const fourth = items.find((item) => item.asin === 'B009KYC6UY');
  assert.equal(fourth.volume, 4);
  assert.equal(fourth.title, '進撃の巨人 ４');
});

test('Amazon series parser keeps child titles for mixed-edition lineups', () => {
  const items = extractKindleSeriesItemsFromHtml(`
    <meta property="og:title" content="軍鶏 (全22巻) Kindle版" />
    <div id="series-childAsin-list"></div>
    <div data-offer-asins="B00QAEZKNC,B00QAEZKXG,B00QAEZL4E,B00QAEZLAY,B00QAEZLIO,B00QAEZLSO,B00QAEZM2E,B00SICO3LE,B00SICO3MY,B00SICO3PA,B00SICO3QO,B00SICO3S2,B00SICO3TI,B00SICO3UW,B00WFOSQCE,B00WFOSQDQ,B00WFOSQF4,B00WFOSQGI,B00WFOSQHW,B00WFOSQJK,B00WFOSQXQ,B00WFOSQYG"></div>
    <div id="series-childAsin-item_0" data-asin="B00QAEZKNC">
      <a href="/dp/B00QAEZKNC" title="極厚版『軍鶏』 巻之壱 （１～３巻相当） (イブニングコミックス)">極厚版『軍鶏』 巻之壱 （１～３巻相当） (イブニングコミックス)</a>
    </div>
    <div id="series-childAsin-item_1" data-asin="B00QAEZKXG">
      <a href="/dp/B00QAEZKXG" title="極厚版『軍鶏』 巻之弐 （４～６巻相当） (イブニングコミックス)">極厚版『軍鶏』 巻之弐 （４～６巻相当） (イブニングコミックス)</a>
    </div>
    <div id="series-childAsin-item_2" data-asin="B00QAEZL4E">
      <a href="/dp/B00QAEZL4E" title="極厚版『軍鶏』 巻之参 （７～９巻相当） (イブニングコミックス)">極厚版『軍鶏』 巻之参 （７～９巻相当） (イブニングコミックス)</a>
    </div>
    <div id="series-childAsin-item_7" data-asin="B00SICO3LE">
      <a href="/dp/B00SICO3LE" title="軍鶏（２０） (イブニングコミックス)">軍鶏（２０） (イブニングコミックス)</a>
    </div>
    <div id="series-childAsin-item_8" data-asin="B00SICO3MY">
      <a href="/dp/B00SICO3MY" title="軍鶏（２１） (イブニングコミックス)">軍鶏（２１） (イブニングコミックス)</a>
    </div>
    <div id="series-childAsin-item_9" data-asin="B00SICO3PA">
      <a href="/dp/B00SICO3PA" title="軍鶏（２２） (イブニングコミックス)">軍鶏（２２） (イブニングコミックス)</a>
    </div>
  `);

  const twentieth = items.find((item) => item.asin === 'B00SICO3LE');
  const twentySecond = items.find((item) => item.asin === 'B00SICO3PA');
  assert.equal(items.length, 22);
  assert.equal(twentieth.volume, 8);
  assert.equal(twentieth.title, '軍鶏（２０） (イブニングコミックス)');
  assert.equal(twentySecond.volume, 10);
  assert.equal(twentySecond.title, '軍鶏（２２） (イブニングコミックス)');
});

test('Amazon series parser ignores unrelated bulk offer ASINs on standalone product pages', () => {
  const items = extractKindleSeriesItemsFromHtml(`
    <html>
      <head>
        <meta property="og:title" content="おともだち 〈新装版〉 eBook : 高野文子: Kindleストア" />
      </head>
      <body>
        <span id="productTitle">おともだち 〈新装版〉</span>
        <div id="tmm-grid-swatch-KINDLE">Kindle版</div>
        <div data-offer-asins="B0G82JFYSP,B0GSMRYHFJ,B0GQJC3J46,B0GX38YS48"></div>
      </body>
    </html>
  `);

  assert.equal(items.length, 0);
});

test('Amazon series fetch falls back from kindle-dbs product URL to dp URL when DBS is blocked', async () => {
  const originalFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url) => {
    const href = String(url);
    seen.push(href);
    const parsed = new URL(href);
    if (/\/kindle-dbs\/product\//.test(parsed.pathname)) {
      return new Response('blocked', { status: 503 });
    }
    if (parsed.pathname === '/dp/B012345678') {
      return new Response(`
        <html>
          <head><meta property="og:title" content="フォールバック作品 (全2巻)"></head>
          <body>
            <div id="series-childAsin-list">
              <div id="series-childAsin-item_1" class="series-childAsin-item">
                <a class="itemImageLink" title="フォールバック作品 1" href="/gp/product/B012345671?storeType=ebooks">
                  <img alt="フォールバック作品 1" src="https://m.media-amazon.com/images/I/51one._SY300_.jpg">
                </a>
                <span class="a-size-large a-color-price">￥537</span>
              </div>
              <div id="series-childAsin-item_2" class="series-childAsin-item">
                <a class="itemImageLink" title="フォールバック作品 2" href="/gp/product/B012345672?storeType=ebooks">
                  <img alt="フォールバック作品 2" src="https://m.media-amazon.com/images/I/51two._SY300_.jpg">
                </a>
                <span class="a-size-large a-color-price">￥537</span>
              </div>
            </div>
          </body>
        </html>
      `, { status: 200, headers: { 'content-type': 'text/html' } });
    }
    return new Response('not found', { status: 404 });
  };

  try {
    const series = await fetchKindleSeriesItems('https://www.amazon.co.jp/kindle-dbs/product/B012345678', {
      retries: 0,
      timeoutMs: 1000,
      skipThrottle: true,
      probeSeriesCompletion: false,
      allowReaderFallback: false
    });

    assert.equal(series.seriesName, 'フォールバック作品');
    assert.equal(series.items.length, 2);
    assert.equal(series.items[0].currentPrice, 537);
    assert.ok(seen.some((url) => url.includes('/kindle-dbs/product/B012345678')));
    assert.ok(seen.some((url) => new URL(url).pathname === '/dp/B012345678'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Amazon reader fallback follows real collection link and ignores recommendations', async () => {
  const originalFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url) => {
    const href = String(url);
    seen.push(href);
    const parsed = new URL(href);

    if (parsed.hostname === 'r.jina.ai') {
      return new Response(`
        # 国宝（１） (ビッグコミックス) Kindle版

        [全5巻中第1巻: 国宝](https://www.amazon.co.jp/dp/B0DHHL7Y1S?binding=kindle_edition&ref=dbs_dp_rwt_sb_pc_tkin)

        ## この商品をチェックした人はこんな商品もチェックしています

        [![Image 34: 国宝 上 青春篇 (朝日文庫)](https://m.media-amazon.com/images/I/71novel.jpg)](https://www.amazon.co.jp/dp/B09FDC3MVH)[国宝 上 青春篇 (朝日文庫)](https://www.amazon.co.jp/dp/B09FDC3MVH)
        [![Image 43: 映画「国宝」感動は終わらない](https://m.media-amazon.com/images/I/51movie.jpg)](https://www.amazon.co.jp/dp/B0FR193L1Y)[映画「国宝」感動は終わらない](https://www.amazon.co.jp/dp/B0FR193L1Y)
      `, { status: 200, headers: { 'content-type': 'text/plain' } });
    }

    if (parsed.pathname === '/dp/B0DHHL7Y1S') {
      return new Response(`
        <html>
          <head><meta property="og:title" content="国宝 (全5巻)"></head>
          <body>
            <div id="series-childAsin-list">
              ${[1, 2, 3, 4, 5].map((volume) => `
                <div id="series-childAsin-item_${volume}" class="series-childAsin-item">
                  <a class="itemImageLink" title="国宝（${volume}） (ビッグコミックス)" href="/gp/product/B0KOKUHA0${volume}?storeType=ebooks">
                    <img alt="国宝（${volume}） (ビッグコミックス)" src="https://m.media-amazon.com/images/I/51kokuho${volume}._SY300_.jpg">
                  </a>
                  <span class="a-size-large a-color-price">￥759</span>
                  <span class="itemPoints">28pt</span>
                </div>
              `).join('')}
            </div>
          </body>
        </html>
      `, { status: 200, headers: { 'content-type': 'text/html' } });
    }

    return new Response('<html><head><meta property="og:title" content="国宝（１） (ビッグコミックス)"></head><body>single page</body></html>', {
      status: 200,
      headers: { 'content-type': 'text/html' }
    });
  };

  try {
    const series = await fetchKindleSeriesItems('https://www.amazon.co.jp/dp/B0DGL9JJMJ', {
      retries: 0,
      timeoutMs: 1000,
      skipThrottle: true,
      probeSeriesCompletion: false
    });

    assert.equal(series.sourceAsin, 'B0DHHL7Y1S');
    assert.equal(series.items.length, 5);
    assert.deepEqual(series.items.map((item) => item.asin), [
      'B0KOKUHA01',
      'B0KOKUHA02',
      'B0KOKUHA03',
      'B0KOKUHA04',
      'B0KOKUHA05'
    ]);
    assert.equal(series.items.some((item) => item.asin === 'B09FDC3MVH' || item.asin === 'B0FR193L1Y'), false);
    assert.ok(seen.some((url) => url.includes('r.jina.ai')));
    assert.ok(seen.some((url) => new URL(url).pathname === '/dp/B0DHHL7Y1S'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Amazon series fetch probes reader fallback for small completed DBS subsets', async () => {
  const originalFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url) => {
    const href = String(url);
    seen.push(href);
    const parsed = new URL(href);

    if (parsed.hostname === 'r.jina.ai') {
      return new Response(`
        # 違国日記 1 Kindle版

        [全11巻中第1巻: 違国日記](https://www.amazon.co.jp/dp/B222222222?binding=kindle_edition&ref=dbs_dp_rwt_sb_pc_tkin)
      `, { status: 200, headers: { 'content-type': 'text/plain' } });
    }

    if (/\/kindle-dbs\/product\/B111111111/.test(parsed.pathname)) {
      return new Response(`
        <html>
          <head><meta property="og:title" content="違国日記 (全4巻) Kindle版"></head>
          <body>
            <div id="bookDescription_feature_div">全4巻完結。</div>
            <div id="series-childAsin-list">
              ${[1, 2, 3, 4].map((volume) => `
                <div id="series-childAsin-item_${volume}" class="series-childAsin-item">
                  <a class="itemImageLink" title="違国日記 ${volume}" href="/gp/product/B11111110${volume}?storeType=ebooks"></a>
                  <span class="a-size-large a-color-price">￥594</span>
                </div>
              `).join('')}
            </div>
          </body>
        </html>
      `, { status: 200, headers: { 'content-type': 'text/html' } });
    }

    if (parsed.pathname === '/dp/B222222222') {
      return new Response(`
        <html>
          <head><meta property="og:title" content="違国日記 (全11巻) Kindle版"></head>
          <body>
            <div id="series-childAsin-list">
              ${Array.from({ length: 11 }, (_, index) => {
                const volume = index + 1;
                return `
                  <div id="series-childAsin-item_${volume}" class="series-childAsin-item">
                    <a class="itemImageLink" title="違国日記 ${volume}" href="/gp/product/B2222222${String(volume).padStart(2, '0')}?storeType=ebooks"></a>
                    <span class="a-size-large a-color-price">￥594</span>
                  </div>
                `;
              }).join('')}
            </div>
          </body>
        </html>
      `, { status: 200, headers: { 'content-type': 'text/html' } });
    }

    return new Response('not found', { status: 404 });
  };

  try {
    const series = await fetchKindleSeriesItems('https://www.amazon.co.jp/kindle-dbs/product/B111111111', {
      retries: 0,
      timeoutMs: 1000,
      skipThrottle: true,
      probeSeriesCompletion: false
    });

    assert.equal(series.sourceAsin, 'B222222222');
    assert.equal(series.items.length, 11);
    assert.equal(series.expectedVolumeCount, 11);
    assert.ok(seen.some((url) => new URL(url).hostname === 'r.jina.ai'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Amazon product fetch resolves kindle-dbs product input through canonical dp URL', async () => {
  const originalFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url) => {
    const href = String(url);
    seen.push(href);
    const parsed = new URL(href);
    if (/\/kindle-dbs\/product\//.test(parsed.pathname)) {
      return new Response('blocked', { status: 503 });
    }
    if (parsed.pathname === '/dp/B012345679') {
      return new Response(productHtml({
        title: 'フォールバック単巻 1',
        currentPrice: 537,
        listPrice: 792,
        promo: '32%OFF 5ポイント'
      }), { status: 200, headers: { 'content-type': 'text/html' } });
    }
    return new Response('not found', { status: 404 });
  };

  try {
    const snapshot = await fetchAmazonHtmlSnapshot(
      'B012345679',
      'https://www.amazon.co.jp/kindle-dbs/product/B012345679',
      { retries: 0, timeoutMs: 1000, skipThrottle: true, allowExternalPriceFallback: false }
    );

    assert.equal(snapshot.title, 'フォールバック単巻 1');
    assert.equal(snapshot.currentPrice, 537);
    assert.ok(seen.some((url) => new URL(url).pathname === '/dp/B012345679'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Amazon product fetch tries canonical product URL before stale search-result URLs', async () => {
  const originalFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url) => {
    const href = String(url);
    seen.push(href);
    const parsed = new URL(href);
    if (parsed.pathname === '/dp/B012345680') {
      return new Response(productHtml({
        title: '検索URLに依存しない単巻',
        currentPrice: 1320,
        listPrice: 1320,
        promo: '13ポイント'
      }), { status: 200, headers: { 'content-type': 'text/html' } });
    }
    return new Response('<html><head><meta property="og:title" content="検索URLに依存しない単巻"></head><body>no price</body></html>', {
      status: 200,
      headers: { 'content-type': 'text/html' }
    });
  };

  try {
    const snapshot = await fetchAmazonHtmlSnapshot(
      'B012345680',
      'https://www.amazon.co.jp/title-ebook/dp/B012345680/ref=sr_1_1?keywords=B012345680&s=digital-text',
      { retries: 0, timeoutMs: 1000, skipThrottle: true, allowExternalPriceFallback: false }
    );

    assert.equal(new URL(seen[0]).pathname, '/dp/B012345680');
    assert.equal(snapshot.currentPrice, 1320);
    assert.equal(snapshot.currentPoints, 13);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Amazon series parser does not keep shared placeholder images as covers', () => {
  const items = extractKindleSeriesItemsFromHtml(`
    <meta property="og:title" content="原作版 左ききのエレン (全2巻)" />
    <div id="series-childAsin-list">
      <div id="series-childAsin-item_1" class="series-childAsin-item">
        <a class="itemImageLink" title="原作版 左ききのエレン（１）" href="/gp/product/B07GWQT4JP?storeType=ebooks">
          <img
            alt="原作版 左ききのエレン（１）"
            src="https://m.media-amazon.com/images/I/A19VjRNYppL._SY300_.png"
            data-old-hires="https://m.media-amazon.com/images/I/513bgfa1haL._SY300_.jpg">
        </a>
      </div>
      <div id="series-childAsin-item_2" class="series-childAsin-item">
        <a class="itemImageLink" title="原作版 左ききのエレン（２）" href="/gp/product/B07GW9MFNR?storeType=ebooks">
          <img alt="原作版 左ききのエレン（２）" src="https://m.media-amazon.com/images/I/A19VjRNYppL._SY300_.png">
        </a>
      </div>
    </div>
  `);

  assert.equal(items[0].imageUrl, 'https://m.media-amazon.com/images/I/513bgfa1haL._SY300_.jpg');
  assert.equal(items[1].imageUrl, '');
});

test('Amazon series parser ignores capped bulk ASIN lists for larger known collections', () => {
  const cappedAsins = Array.from({ length: 50 }, (_, index) => `B09FLC${String(index + 1).padStart(4, '0')}`).join(',');
  const items = extractKindleSeriesItemsFromHtml(`
    <html>
      <head>
        <meta property="og:title" content="モジャ公 藤子・Ｆ・不二雄大全集 (全118巻)" />
      </head>
      <body>
        <div class="hulk-buy-card">Kindle版(電子書籍)のシリーズを購入</div>
        <div data-offer-asins="${cappedAsins}"></div>
      </body>
    </html>
  `);

  assert.equal(items.length, 0);
});

test('Amazon series parser ignores episode bulk forms when child list identifies collected volumes', () => {
  const items = extractKindleSeriesItemsFromHtml(`
    <meta property="og:title" content="トリリオンゲーム (11 book series)" />
    <div id="series-childAsin-list">
      <div id="series-childAsin-item_1" class="series-childAsin-item">
        <a class="itemImageLink" title="トリリオンゲーム（１）" href="/gp/product/B08YJWRJ4V?storeType=ebooks">
          <img alt="トリリオンゲーム（１）" src="https://m.media-amazon.com/images/I/51one._SY300_.jpg">
        </a>
        <span class="a-size-large a-color-price">￥759</span>
        <span class="itemPoints">28pt</span>
      </div>
      <div id="series-childAsin-item_2" class="series-childAsin-item">
        <a class="itemImageLink" title="トリリオンゲーム（２）" href="/gp/product/B0995RQYYJ?storeType=ebooks">
          <img alt="トリリオンゲーム（２）" src="https://m.media-amazon.com/images/I/51two._SY300_.jpg">
        </a>
        <span class="a-size-large a-color-price">￥759</span>
        <span class="itemPoints">28pt</span>
      </div>
    </div>
    <form>
      <input name="items[0].action.asin" value="B08WBQHWPK">
      <input name="items[0].action.displayedPrice.value" value="224.00">
      <input name="items[0].action.displayedPrice.currency" value="JPY">
      <input name="items[1].action.asin" value="B08WBSWSS6">
      <input name="items[1].action.displayedPrice.value" value="123.00">
      <input name="items[1].action.displayedPrice.currency" value="JPY">
      <input name="items[2].action.asin" value="B08WC7XM5R">
      <input name="items[2].action.displayedPrice.value" value="105.00">
      <input name="items[2].action.displayedPrice.currency" value="JPY">
    </form>
  `);

  assert.equal(items.length, 2);
  assert.equal(items[0].asin, 'B08YJWRJ4V');
  assert.equal(items[0].currentPrice, 759);
  assert.equal(items[0].currentPoints, 28);
  assert.equal(items[0].provider, 'amazon_series_child');
  assert.equal(items[1].asin, 'B0995RQYYJ');
});

test('Amazon series parser prefers collected-volume bulk form over episode bulk form', () => {
  const items = extractKindleSeriesItemsFromHtml(`
    <meta property="og:title" content="ＷＨＩＴＥ ＮＯＴＥ ＰＡＤ (全2巻) Kindle版" />
    <span id="collection-masthead__size">全2巻 | 全6話</span>
    <h5><span class="a-heading-text">まとめ買い (話)</span></h5>
    <form>
      <input name="items[0].action.asin" value="B086G55CDG">
      <input name="items[0].action.displayedPrice.value" value="154">
      <input name="items[0].action.displayedPrice.currency" value="JPY">
      <input name="items[1].action.asin" value="B086GLN8HZ">
      <input name="items[1].action.displayedPrice.value" value="154">
      <input name="items[1].action.displayedPrice.currency" value="JPY">
      <input name="items[2].action.asin" value="B086GJYWNL">
      <input name="items[2].action.displayedPrice.value" value="154">
      <input name="items[2].action.displayedPrice.currency" value="JPY">
      <input name="items[3].action.asin" value="B086GJ2BLT">
      <input name="items[3].action.displayedPrice.value" value="154">
      <input name="items[3].action.displayedPrice.currency" value="JPY">
      <input name="items[4].action.asin" value="B086GQ8KGN">
      <input name="items[4].action.displayedPrice.value" value="154">
      <input name="items[4].action.displayedPrice.currency" value="JPY">
      <input name="items[5].action.asin" value="B086GMYN4Z">
      <input name="items[5].action.displayedPrice.value" value="154">
      <input name="items[5].action.displayedPrice.currency" value="JPY">
    </form>
    <h5><span class="a-heading-text">まとめ買い (巻)</span></h5>
    <form>
      <input name="items[0].action.asin" value="B0191356AU">
      <input name="items[0].action.displayedPrice.value" value="462">
      <input name="items[0].action.displayedPrice.currency" value="JPY">
      <input name="items[1].action.asin" value="B01NCLNN5C">
      <input name="items[1].action.displayedPrice.value" value="462">
      <input name="items[1].action.displayedPrice.currency" value="JPY">
    </form>
  `);

  assert.equal(items.length, 2);
  assert.equal(items[0].asin, 'B0191356AU');
  assert.equal(items[0].currentPrice, 462);
  assert.equal(items[0].provider, 'amazon_series_bulk');
  assert.equal(items[1].asin, 'B01NCLNN5C');
});

test('Amazon series parser distributes bulk offer points across hidden offer items', () => {
  const items = extractKindleSeriesItemsFromHtml(`
    <meta property="og:title" content="喧嘩稼業 (全3巻) Kindle版" />
    <div id="series-childAsin-list">
      <div id="series-childAsin-item_1" class="series-childAsin-item">
        <a class="itemImageLink" title="喧嘩稼業 1" href="/gp/product/B00JDYKL3A?storeType=ebooks"></a>
        <span class="a-size-large a-color-price">￥792</span>
      </div>
      <div id="series-childAsin-item_2" class="series-childAsin-item">
        <a class="itemImageLink" title="喧嘩稼業 2" href="/gp/product/B00N8JJ312?storeType=ebooks"></a>
        <span class="a-size-large a-color-price">￥792</span>
      </div>
    </div>
    <div class="_hulk-buy-card_style_offer-details__1t8Fv" data-offer-id="offer_0">
      <span>Kindle 価格: ￥2,376</span>
      <div>
        <span>獲得ポイント:</span>
        <span>1,188 pt (50%)</span>
      </div>
      <form>
        <input name="items[0].action.asin" value="B00JDYKL3A">
        <input name="items[0].action.displayedPrice.value" value="792">
        <input name="items[0].action.displayedPrice.currency" value="JPY">
        <input name="items[1].action.asin" value="B00N8JJ312">
        <input name="items[1].action.displayedPrice.value" value="792">
        <input name="items[1].action.displayedPrice.currency" value="JPY">
        <input name="items[2].action.asin" value="B00RDYOBD8">
        <input name="items[2].action.displayedPrice.value" value="792">
        <input name="items[2].action.displayedPrice.currency" value="JPY">
      </form>
    </div>
  `);

  assert.equal(items.length, 3);
  assert.deepEqual(items.map((item) => item.currentPoints), [396, 396, 396]);
  assert.deepEqual(items.map((item) => item.effectivePrice), [396, 396, 396]);
  assert.equal(items[0].provider, 'amazon_series_bulk');
  assert.equal(items[2].provider, 'amazon_series_bulk');
});

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

test('Amazon HTML parser does not use the known current price as a list price floor candidate', () => {
  const snapshot = extractAmazonHtmlSnapshotFromHtml(`
    <html>
      <head><meta property="og:title" content="List floor candidate"></head>
      <body>
        <span id="productTitle">List floor candidate</span>
        <div id="tmm-grid-swatch-KINDLE">Kindle版</div>
        <div id="corePriceDisplay_desktop_feature_div">
          <span class="a-price" data-a-color="price">
            <span class="a-offscreen">￥33</span>
            <span class="a-price-whole">33</span>
          </span>
          <span class="a-price a-text-price">
            <span class="a-offscreen">￥792</span>
          </span>
          <span>33%オフ 30ポイント</span>
        </div>
      </body>
    </html>
  `, 'B00TEST001', 'https://www.amazon.co.jp/dp/B00TEST001', 'amazon_html', {
    minimumListPriceExclusive: 792
  });

  assert.equal(snapshot.listPrice, null);
});

test('Amazon HTML parser keeps a struck list price above the known current price floor', () => {
  const snapshot = extractAmazonHtmlSnapshotFromHtml(`
    <html>
      <head><meta property="og:title" content="List floor candidate"></head>
      <body>
        <span id="productTitle">List floor candidate</span>
        <div id="tmm-grid-swatch-KINDLE">Kindle版</div>
        <div id="corePriceDisplay_desktop_feature_div">
          <span class="a-price" data-a-color="price">
            <span class="a-offscreen">￥33</span>
            <span class="a-price-whole">33</span>
          </span>
          <span class="a-price a-text-price">
            <span class="a-offscreen">￥792</span>
          </span>
          <span class="a-price a-text-price">
            <span class="a-offscreen">￥880</span>
          </span>
          <span>33%オフ 30ポイント</span>
        </div>
      </body>
    </html>
  `, 'B00TEST002', 'https://www.amazon.co.jp/dp/B00TEST002', 'amazon_html', {
    minimumListPriceExclusive: 792
  });

  assert.equal(snapshot.listPrice, 880);
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

test('Amazon HTML parser records Kindle release dates for preorder filtering', () => {
  const snapshot = extractAmazonHtmlSnapshotFromHtml(`
    <html>
      <head><meta property="og:title" content="天幕のジャードゥーガル 6"></head>
      <body>
        <span id="productTitle">天幕のジャードゥーガル 6</span>
        <div id="tmm-grid-swatch-KINDLE">Kindle版</div>
        <div id="corePriceDisplay_desktop_feature_div">
          <span class="a-price"><span class="a-offscreen">￥880</span></span>
          <span>9ポイント</span>
        </div>
        <li>
          <span><span>発売日</span></span>
          <span>2026/7/15</span>
        </li>
      </body>
    </html>
  `, 'B0H1BN5ZC6', 'https://www.amazon.co.jp/dp/B0H1BN5ZC6');

  assert.equal(snapshot.currentPrice, 880);
  assert.equal(snapshot.releaseDate, '2026-07-15');
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
  assert.equal(snapshot.explicitPriceDisplay, true);
});

test('Amazon HTML parser ignores implicit tiny a-price whole values', () => {
  const snapshot = extractAmazonHtmlSnapshotFromHtml(`
    <html>
      <head><meta property="og:title" content="Implicit tiny price"></head>
      <body>
        <span id="productTitle">Implicit tiny price</span>
        <div id="tmm-grid-swatch-KINDLE">
          Kindle版
          <span class="a-price" data-a-color="price">
            <span class="a-price-whole">2</span>
          </span>
        </div>
      </body>
    </html>
  `, 'B00TEST004', 'https://www.amazon.co.jp/dp/B00TEST004');

  assert.equal(snapshot.currentPrice, null);
  assert.equal(snapshot.currentPoints, 0);
  assert.equal(snapshot.effectivePrice, null);
});

test('Amazon HTML parser ignores implicit zero a-price whole values', () => {
  const snapshot = extractAmazonHtmlSnapshotFromHtml(`
    <html>
      <head><meta property="og:title" content="Implicit zero price"></head>
      <body>
        <span id="productTitle">Implicit zero price</span>
        <div id="tmm-grid-swatch-KINDLE">
          Kindle版
          <span class="a-price" data-a-color="price">
            <span class="a-price-whole">0</span>
          </span>
        </div>
      </body>
    </html>
  `, 'B00TEST007', 'https://www.amazon.co.jp/dp/B00TEST007');

  assert.equal(snapshot.currentPrice, null);
  assert.equal(snapshot.currentPoints, 0);
  assert.equal(snapshot.effectivePrice, null);
});

test('Amazon HTML parser ignores point-only tiny values and keeps explicit Kindle yen price', () => {
  const snapshot = extractAmazonHtmlSnapshotFromHtml(`
    <html>
      <head><meta property="og:title" content="宇宙兄弟（１）"></head>
      <body>
        <span id="productTitle">宇宙兄弟（１）</span>
        <div id="tmm-grid-swatch-KINDLE">
          Kindle版
          <span class="kindleReward">
            獲得ポイント:
            <span class="a-price" data-a-color="price">
              <span class="a-price-whole">6</span>
            </span>
            6pt
          </span>
          <span class="a-price" data-a-color="price">
            <span class="a-offscreen">￥891</span>
            <span class="a-price-whole">891</span>
          </span>
          <span>44ポイント</span>
        </div>
      </body>
    </html>
  `, 'B009KWUFNG', 'https://www.amazon.co.jp/dp/B009KWUFNG');

  assert.equal(snapshot.currentPrice, 891);
  assert.equal(snapshot.currentPoints, 44);
  assert.equal(snapshot.effectivePrice, 847);
  assert.equal(snapshot.explicitPriceDisplay, true);
});

test('Amazon HTML parser accepts explicit tiny Kindle yen prices', () => {
  const snapshot = extractAmazonHtmlSnapshotFromHtml(`
    <html>
      <head><meta property="og:title" content="Explicit tiny price"></head>
      <body>
        <span id="productTitle">Explicit tiny price</span>
        <div id="tmm-grid-swatch-KINDLE">
          Kindle版
          <span class="a-price" data-a-color="price">
            <span class="a-offscreen">￥2</span>
            <span class="a-price-whole">2</span>
          </span>
        </div>
      </body>
    </html>
  `, 'B00TEST005', 'https://www.amazon.co.jp/dp/B00TEST005');

  assert.equal(snapshot.currentPrice, 2);
  assert.equal(snapshot.currentPoints, 0);
  assert.equal(snapshot.effectivePrice, 2);
  assert.equal(snapshot.explicitPriceDisplay, true);
});

test('Amazon HTML parser marks explicit free Kindle prices', () => {
  const snapshot = extractAmazonHtmlSnapshotFromHtml(`
    <html>
      <head><meta property="og:title" content="Explicit free price"></head>
      <body>
        <span id="productTitle">Explicit free price</span>
        <div id="tmm-grid-swatch-KINDLE">
          Kindle版
          <span class="a-price" data-a-color="price">
            <span class="a-offscreen">￥0</span>
            <span class="a-price-whole">0</span>
          </span>
        </div>
      </body>
    </html>
  `, 'B00TEST006', 'https://www.amazon.co.jp/dp/B00TEST006');

  assert.equal(snapshot.currentPrice, 0);
  assert.equal(snapshot.currentPoints, 0);
  assert.equal(snapshot.effectivePrice, 0);
  assert.equal(snapshot.explicitFreeKindlePrice, true);
});

test('Amazon reader fallback defers steep uncorroborated prices', () => {
  assert.equal(
    shouldDeferAmazonReaderPrice(
      {
        currentPrice: 200,
        currentPoints: 2,
        listPrice: null,
        provider: 'amazon_reader'
      },
      {
        listPrice: 440
      }
    ),
    true
  );

  assert.equal(
    shouldDeferAmazonReaderPrice(
      {
        currentPrice: 396,
        currentPoints: 4,
        listPrice: null,
        provider: 'amazon_reader'
      },
      {
        listPrice: 440
      }
    ),
    false
  );
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

test('Amazon series completion parser ignores next-volume completion preview text', () => {
  assert.equal(extractSeriesCompletionStatusFromHtml(`
    <html>
      <head><meta property="og:title" content="宇宙兄弟（４５）"></head>
      <body>
        <div id="bookDescription_feature_div">
          NASA、JAXA、ロスコスモスの共同作業によって、漂流中の六太の軌道を割り出すことに成功。
          絶望の中、兄弟のランデヴーは成功するのかーーー。
          次巻、ついに完結！
        </div>
      </body>
    </html>
  `), false);

  assert.equal(extractSeriesCompletionStatusFromHtml(`
    <html>
      <body>
        <div id="bookDescription_feature_div">
          物語はいよいよ佳境へ。次巻が最終巻となる。
        </div>
      </body>
    </html>
  `), false);
});

test('Amazon series completion parser ignores customer review completion text', () => {
  assert.equal(extractSeriesCompletionStatusFromHtml(`
    <html>
      <head><meta property="og:title" content="連載中シリーズ 9"></head>
      <body>
        <h1>連載中シリーズ 9</h1>
        <div id="bookDescription_feature_div">
          主人公たちの戦いは佳境へ。物語はまだ続いていく。
        </div>
        <div id="customerReviews">
          日本からのトップレビュー:
          いよいよ次巻で完結か。
          完結性についても好評です。
          正直、最終回かと思った。それぐらい熱いイベントだった。
        </div>
      </body>
    </html>
  `), false);
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

test('Amazon series completion parser does not treat revival copy as completed', () => {
  assert.equal(extractSeriesCompletionStatusFromHtml(`
    <html>
      <head><meta property="og:title" content="左ききのエレン"></head>
      <body>
        <div id="bookDescription_feature_div">
          ジャンプ＋版の最終回から4年後の2026年を舞台にした復活連載。
          新章の第25巻が配信中です。
        </div>
      </body>
    </html>
  `), false);
});

test('Amazon series completion parser does not treat part completion as full series completion', () => {
  assert.equal(extractSeriesCompletionStatusFromHtml(`
    <html>
      <head><meta property="og:title" content="原作版 左ききのエレン (全40巻)"></head>
      <body>
        <div id="bookDescription_feature_div">
          初の長編ストーリーマンガの第一部が、ここに堂々完結！
          描き下ろし「左ききのエレン 2018」を収録。
        </div>
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

test('MangaZenkan completion parser ignores latest-volume search results', () => {
  const html = `
    <main>
      <aside>絞り込み検索 タグ 完結 紙書籍のみ</aside>
      <div class="search-result-item book">
        <a class="product-name">ベルセルク [新表紙版] (1-43巻 最新刊)</a>
        <span>作者 三浦建太郎</span>
      </div>
    </main>
  `;

  assert.equal(extractMangaZenkanCompletionEvidenceFromHtml(html, 'ベルセルク', 43), null);
});

test('MangaZenkan completion parser accepts matching all-volume search results', () => {
  const html = `
    <main>
      <div class="search-result-item book">
        <a class="product-name">あしたのジョー (1-20巻 全巻)</a>
        <span>作者 高森朝雄 ちばてつや</span>
      </div>
    </main>
  `;

  assert.deepEqual(extractMangaZenkanCompletionEvidenceFromHtml(html, 'あしたのジョー', 20), {
    completed: true,
    source: 'mangazenkan_all_volume'
  });
  assert.equal(extractMangaZenkanCompletionEvidenceFromHtml(html, 'あしたのジョー', 21), null);
});

test('known series completion override marks curated completed series', () => {
  const series = applyKnownSeriesCompletionOverride({
    seriesName: 'ピンポン',
    sourceAsin: 'B075FTFV56',
    expectedVolumeCount: 5,
    completed: false,
    items: [
      { asin: 'B000000001', title: 'ピンポン 1', volume: '1' },
      { asin: 'B000000002', title: 'ピンポン 2', volume: '2' },
      { asin: 'B000000003', title: 'ピンポン 3', volume: '3' },
      { asin: 'B000000004', title: 'ピンポン 4', volume: '4' },
      { asin: 'B000000005', title: 'ピンポン 5', volume: '5' }
    ]
  });

  assert.equal(series.completed, true);
  assert.equal(series.completionSource, 'curated_series_completion');
});

test('known series completion override keeps curated ongoing series incomplete', () => {
  const series = applyKnownSeriesCompletionOverride({
    seriesName: '預言者ピッピ',
    sourceAsin: 'B075P5J6VW',
    expectedVolumeCount: 2,
    completed: true,
    completionSource: 'mangazenkan_search',
    items: [
      { asin: 'B000000001', title: '預言者ピッピ 1', volume: '1' },
      { asin: 'B000000002', title: '預言者ピッピ 2', volume: '2' }
    ]
  });

  assert.equal(series.completed, false);
  assert.equal(series.completionSource, 'curated_series_incomplete');
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
