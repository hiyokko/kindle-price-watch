# Kindle Price Watch

登録したKindle本を定期チェックし、値下げや過去最安をDiscordへ通知する自前用ダッシュボードです。ほしい物リスト連携はありません。

## ローカルセットアップ

1. `.env.example` を参考に `.env` を作成します。
2. `DISCORD_WEBHOOK_URL` にDiscord Webhook URLを入れます。複数ある場合はカンマ区切りで入れます。
3. 価格取得元を変える場合は `PRICE_PROVIDER` を設定します。既定はAmazon HTMLです。
4. 起動します。

```bash
npm start
```

ブラウザで `http://localhost:4173` を開きます。

## Vercel無料枠で使う

Vercelのファイルシステムは永続保存に向かないため、GUIとAPIはVercel、データ保存はVercel Blobを使います。ローカル開発では `data/store.json` を使います。

### 1. Vercel Blobを作成

Vercel CLIでPrivate Blobストアを作成し、プロジェクトへ接続します。

```bash
vercel blob create-store kindle-price-watch-store --access private --yes --environment production --environment preview --environment development
```

作成後、`BLOB_READ_WRITE_TOKEN` がVercel環境変数に追加されます。

### 2. Vercel環境変数

Vercel Project Settings > Environment Variables に設定します。

```text
DISCORD_WEBHOOK_URL=DiscordのWebhook URL（複数はカンマ区切り）
APP_PASSWORD=ログイン用パスワード
BLOB_READ_WRITE_TOKEN=Vercel BlobのRead Write Token
BLOB_STORE_PATH=kindle-price-watch/store.json
BLOB_STORE_MEMORY_CACHE_MS=15000
PRICE_HISTORY_MAX_ENTRIES_PER_BOOK=120
PRICE_PROVIDER=amazon_html
CHECK_MAX_RUNTIME_MS=8000
```

`APP_PASSWORD` を設定すると、画面表示と通常APIにはログインが必要になります。ログイン状態は署名付きHttpOnly Cookieで保持します。

### 3. 既存データの初期投入

ローカルの `data/store.json` を本番Blobへ投入する場合は次を実行します。

```bash
vercel blob put data/store.json --pathname kindle-price-watch/store.json --access private --allow-overwrite --content-type application/json --cache-control-max-age 0
```

### 4. GitHub Actionsで定期実行

Vercel Cronは使わず、`.github/workflows/kindle-price-check.yml` で価格チェックとシリーズ新刊探索をGitHub Actions上で実行します。VercelはWeb GUIとAPI、Vercel Blobはデータ保存先として使います。Vercel上の常駐スケジューラは `AUTO_CHECK_ENABLED=false` のままにしてください。

GitHubリポジトリの Settings > Secrets and variables > Actions に、少なくとも次を登録します。

```text
BLOB_READ_WRITE_TOKEN=Vercel BlobのRead Write Token
```

Discord Webhookはアプリ画面から保存済みであればBlobから読み込まれます。GitHub Actions側だけで通知先を指定したい場合は、追加で `DISCORD_WEBHOOK_URL` をSecretに登録します。

## 価格取得について

`PRICE_PROVIDER=amazon_html` の場合、Amazon商品ページHTMLから価格を取得します。Amazon側がブロック・503・価格欠落で返せない場合は、KintyakuでASIN一致の商品メタデータを補完し、listasIn(Kiseppe) の公開価格データで価格を補助します。

`PRICE_PROVIDER=auto` の場合、次の順に使います。

1. Keepa API (`KEEPA_API_KEY` がある場合)
2. Amazon商品ページHTMLの簡易取得
3. Kintyaku のASIN一致メタデータ補助
4. listasIn(Kiseppe) の価格データ補助

Amazon HTML取得はブロックされることがあるため、常用するならKeepa、またはAmazon公式Creators API相当の取得元に差し替えるのがおすすめです。
紙本・中古本ページのASINやISBN-10はKindle価格として登録しません。Kindle商品ページのASINを登録してください。

## シリーズURL

`https://www.amazon.co.jp/dp/XXXXXXXXXX?binding=kindle_edition...` のようなAmazonシリーズページURLを追加すると、ページ内のKindleシリーズASINを抽出して複数冊を登録します。Amazon側で欠落する場合は、premium.gamepedia、Sale-bon、Kintyaku、efox、Kinpome の外部ソースも補助的に使います。`SERIES_IMPORT_LIMIT` を設定しない限り、アプリ側では冊数上限を設けません。

Vercel Hobbyでは登録時に全巻の詳細取得まで行うとタイムアウトしやすいため、初期値ではまずASINだけを登録します。その後、手動の「価格チェック」またはCronでタイトル・価格・画像を順次取得します。登録時に詳細も取りたい場合は `SERIES_IMPORT_FETCH_DETAILS=true` を設定してください。

## 追加キュー

Blob Advanced Operationsを増やさずに本を追加したい場合は、GUIで都度保存せず、`data/import-queue.txt` にAmazon Kindle URLまたはASINを1行ずつ追加します。GitHub ActionsのJST 16:00実行時に未処理の行だけを取り込み、価格チェック・シリーズ新刊探索と同じ最後の一括保存に含めます。環境変数で渡す場合は `BOOK_IMPORT_INPUTS` に改行区切りまたはJSON配列を設定できます。キューファイルを使わない場合は `BOOK_IMPORT_QUEUE_PATH=false` にします。

画面上部の「追加キュー」からも次回追加予定のURL/ASINを保存できます。画面で保存したキューはBlobの `importQueue.pending` に入り、`data/import-queue.txt` や `BOOK_IMPORT_INPUTS` と同じく次回のGitHub Actions実行時に処理されます。成功した入力はpendingから外れ、直近の処理済み・エラー履歴は画面で確認できます。

## 定期実行

GitHub Actionsでは毎日JST 16:00にWorkflowを起動します。アプリ画面の実行時刻もJST 16:00にしておくと、その起動で自動チェックが始まります。再確認間隔は24時間差分ではなく、24時間なら毎日定時、48時間なら2日ごとの定時、72時間なら3日ごとの定時として判定します。1000冊規模でもAmazonや補助サイトに連続アクセスしすぎないよう、`CHECK_REQUEST_DELAY_MS` / `CHECK_REQUEST_JITTER_MS` / `HTTP_REQUEST_MIN_INTERVAL_MS` で待機時間を調整します。429/503/CAPTCHA系の応答を検知した場合は、`CHECK_BLOCK_COOLDOWN_MS` / `HTTP_BLOCK_COOLDOWN_MS` のクールダウンを挟みます。GitHub Actions側では `CHECK_MAX_RUNTIME_MS=18000000` を設定し、Workflowの強制終了より前にアプリ自身が停止して一括保存できるようにします。

Blob Advanced Operationsを抑えるため、定期実行では本ごとに保存せず、価格チェック・通知状態・シリーズ新刊探索結果・カーソルをメモリ上で更新して最後にまとめて保存します。正常終了またはアプリ側のランタイム停止判定で終了した場合は、最後に確認できた本を `checkCursor` として保存し、次回はその続きから確認します。

Fast Origin Transferを抑えるため、Blob読み込みはプロセス内で短時間キャッシュします。`BLOB_STORE_MEMORY_CACHE_MS` でキャッシュ時間を調整できます。また、価格履歴は価格・ポイント・実質価格・定価が変わった時だけ追加し、`PRICE_HISTORY_MAX_ENTRIES_PER_BOOK` 件まで保持します。

定期実行時は、登録済みシリーズのAmazonシリーズページも巡回し、新しい巻が見つかった場合は自動で追加します。明示的に完結が確認できたシリーズには完結フラグを保存し、次回以降の新刊探索から除外します。`SERIES_DISCOVERY_BATCH_SIZE` を設定すると、1回の実行で探索するシリーズ数を調整できます。`SERIES_DISCOVERY_INTERVAL_HOURS` の既定値は24時間です。

GitHub Actionsの手動実行では、`force_all` を有効にすると24時間以内に確認済みの本も保存した件数まで再確認します。

手動で一度だけ実行する場合は次を使います。

```bash
npm run check
```

大量登録でも1回で全件を処理せず、未チェック順に分割して進める設計です。
