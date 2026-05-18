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
vercel blob create-store kindle-price-watch-store --access private --yes --environment production
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

Blobの誤消費を避けるため、`BLOB_READ_WRITE_TOKEN` はProductionだけに設定します。Preview / Development に本番Blobのトークンを入れると、Preview確認や開発用デプロイが本番の `kindle-price-watch/store.json` を読み書きできます。PreviewでBlobを使う場合は、別Blobストアまたは別 `BLOB_STORE_PATH` を使ってください。

### 3. 既存データの初期投入

ローカルの `data/store.json` を本番Blobへ投入する場合は次を実行します。

```bash
vercel blob put data/store.json --pathname kindle-price-watch/store.json --access private --allow-overwrite --content-type application/json --cache-control-max-age 0
```

### 4. GitHub Actionsで定期実行

Vercel Cronは使わず、`.github/workflows/kindle-price-check.yml` で価格チェックとシリーズ新刊探索をGitHub Actions上で実行します。VercelはWeb GUIとAPI、Vercel Blobはデータ保存先として使います。Vercel上の常駐スケジューラは `AUTO_CHECK_ENABLED=false` のままにしてください。GitHub Actionsは毎日JST 03:54と15:54に起動し、GitHub側の欠落・遅延対策として04:07/04:37/05:17と16:07/16:37/17:17にもバックアップ起動します。各GitHub scheduleは対象の実行枠をアプリに渡し、同じ実行枠の完了記録があり、かつ `lastCronError` が空の場合だけ価格チェックを行わずに終了します。GitHub側で起動が遅れても、次の実行枠に入る前であれば対象枠のチェックとして実行します。

チェック対象は未取得・未検証シリーズ価格の破棄後・シリーズ内の未取得巻を優先します。Amazon側の一時エラーやブロック直後の本は短時間の再試行を避け、アクセス回数を増やさずに取得済み件数を戻す方針です。価格通知は、単巻価格ではなくシリーズ全巻の直近取得が揃った場合にシリーズ合計で判定します。シリーズの過去最安合計は各巻の過去最安の寄せ集めではなく、`seriesPriceHistory` に実際に観測したシリーズ合計を保存し、その最安で判定します。大型シリーズで数冊だけ未取得のまま残ることを避けるため、チェック計画では同一シリーズの未取得・古い巻を同じバッチに寄せ、直近 `SERIES_TOTAL_OBSERVATION_RUNS` 回の実行枠内に全巻が揃った場合も同一観測として扱います。

GitHubリポジトリの Settings > Secrets and variables > Actions に、少なくとも次を登録します。

```text
BLOB_READ_WRITE_TOKEN=Vercel BlobのRead Write Token
```

Discord Webhookはアプリ画面から保存済みであればBlobから読み込まれます。GitHub Actions側だけで通知先を指定したい場合は、追加で `DISCORD_WEBHOOK_URL` をSecretに登録します。

### 5. デプロイ運用

VercelのGitHub自動デプロイ連携は使わず、GitHubへpushした後にVercel CLIで本番へ明示的にデプロイします。Previewデプロイで本番Blobを触らないことと、非公開GitHubリポジトリのGitメタデータをVercelデプロイに渡さないことが目的です。Vercel Project SettingsではGit連携の自動デプロイ作成を無効にしておきます。

`vercel deploy --prod` をこのリポジトリ直下で直接実行しないでください。`.git` がある状態でデプロイすると、VercelがGitHub commit authorを使ったデプロイとして扱い、非公開リポジトリやVercelチーム権限との不一致で失敗することがあります。

本番デプロイは次を使います。`node scripts/deploy-production.mjs` は一時ディレクトリへ `.git`、`node_modules`、ローカル `.env*`、ローカル `data/*.json` を除外してコピーし、そのGit情報を持たないディレクトリからVercelへアップロードします。npmが使える環境では `npm run deploy:production` でも同じ処理を実行できます。

```bash
git push origin main
node scripts/deploy-production.mjs
```

## 価格取得について

`PRICE_PROVIDER=amazon_html` の場合、Amazon商品ページHTMLから価格を取得します。Amazon側がブロック・403・429・503・価格欠落で返せない場合は、KintyakuでASIN一致の商品メタデータを補完し、listasIn(Kiseppe) の公開価格データで価格を補助します。

`PRICE_PROVIDER=auto` の場合、次の順に使います。

1. Keepa API (`KEEPA_API_KEY` がある場合)
2. Amazon商品ページHTMLの簡易取得
3. Kintyaku のASIN一致メタデータ補助
4. listasIn(Kiseppe) の価格データ補助

Amazon HTML取得はブロックされることがあるため、常用するならKeepa、またはAmazon公式Creators API相当の取得元に差し替えるのがおすすめです。HTML取得時はブラウザ系User-Agentのローテーションと通常ブラウザに近いヘッダーを使い、ブロック検知後は同一実行内でAmazon URLを深追いしないようにしています。必要に応じて `AMAZON_USER_AGENTS` でUser-Agent候補を上書きし、`AMAZON_HTML_PROXY_URL_TEMPLATE` でAmazon HTML取得だけをプロキシへ逃がせます。
紙本・中古本ページのASINやISBN-10はKindle価格として登録しません。Kindle商品ページのASINを登録してください。

## シリーズURL

`https://www.amazon.co.jp/dp/XXXXXXXXXX?binding=kindle_edition...` のようなAmazonシリーズページURLを追加すると、ページ内のKindleシリーズASINを抽出して複数冊を登録します。Amazon側で欠落する場合は、premium.gamepedia、Sale-bon、Kintyaku、efox、Kinpome の外部ソースも補助的に使います。`SERIES_IMPORT_LIMIT` を設定しない限り、アプリ側では冊数上限を設けません。

Vercel Hobbyでは登録時に全巻の詳細取得まで行うとタイムアウトしやすいため、初期値ではまずASINだけを登録します。その後、手動の「価格チェック」またはCronでタイトル・価格・画像を順次取得します。登録時に詳細も取りたい場合は `SERIES_IMPORT_FETCH_DETAILS=true` を設定してください。

## 追加キュー

GUIの通常追加は即時取得せず、Blobの `importQueue.pending` に「未追加（自動実行で追加予定）」として保存します。次回のGitHub Actions実行時に未処理の行だけを取り込み、価格チェック・シリーズ新刊探索と同じ最後の一括保存に含めます。環境変数で渡す場合は `BOOK_IMPORT_INPUTS` に改行区切りまたはJSON配列を設定できます。キューファイルを使わない場合は `BOOK_IMPORT_QUEUE_PATH=false` にします。

画面上部の「追加キュー」からも次回追加予定のURL/ASINをまとめて保存できます。画面で保存したキューは `data/import-queue.txt` や `BOOK_IMPORT_INPUTS` と同じく次回のGitHub Actions実行時に処理されます。成功した入力はpendingから外れ、直近の処理済み・エラー履歴は画面で確認できます。

## 定期実行

GitHub Actionsでは毎日JST 03:54と15:54にWorkflowを起動します。アプリ画面ではこの固定時刻を表示し、時刻や実行回数は変更できません。GitHub Actionsの混雑を避けるため、毎時0分や5分刻みではない時刻にしています。GitHub scheduled workflowの欠落・遅延に備え、04:07/04:37/05:17と16:07/16:37/17:17にもバックアップWorkflowを起動します。バックアップを含む各scheduleは `CHECK_SCHEDULE_CRON` で対象の実行枠をアプリへ渡し、Blobには `lastCronExecutionBoundaryAt` として完了した実行枠を保存します。同じ実行枠の完了記録があり、かつ `lastCronError` が空の場合だけ、価格チェック・新刊探索・サマリー通知を行わずに終了します。本実行がエラーを記録した場合はバックアップが実行されます。1000冊規模でもAmazonや補助サイトに連続アクセスしすぎないよう、`CHECK_REQUEST_DELAY_MS` / `CHECK_REQUEST_JITTER_MS` / `HTTP_REQUEST_MIN_INTERVAL_MS` で待機時間を調整します。403/429/503/CAPTCHA系の応答を検知した場合は、`CHECK_BLOCK_COOLDOWN_MS` / `HTTP_BLOCK_COOLDOWN_MS` のクールダウンを挟みます。価格取得不可やタイムアウトが連続した場合は `CHECK_TRANSIENT_ERROR_COOLDOWN_MS` / `CHECK_TRANSIENT_ERROR_COOLDOWN_THRESHOLD` で短いクールダウンを挟み、ブロック前兆の連続アクセスを抑えます。GitHub Actions側では `CHECK_MAX_RUNTIME_MS=18000000` と `CHECK_SAVE_RESERVE_MS=300000` を設定し、Workflowの強制終了より前にアプリ自身が停止して一括保存できるようにします。ホスト待機や1冊ごとの処理にもAbortSignalを渡し、最後の保険として `CHECK_HARD_TIMEOUT_MS=18600000` でプロセスを強制終了します。

Blob Advanced Operationsを抑えるため、定期実行では本ごとに保存せず、価格チェック・画像未取得の補完・通知状態・シリーズ合計価格履歴・シリーズ新刊探索結果・カーソルをメモリ上で更新して最後にまとめて保存します。正常終了またはアプリ側のランタイム停止判定で終了した場合は、最後に確認できた本を `checkCursor` として保存し、次回はその続きから確認します。

定期実行サマリーでは取得エラー件数だけでなく、エラー内訳と代表サンプルをBlobの `automation.lastCronErrorBreakdown` / `automation.lastCronErrorSamples` に残します。シリーズ新刊探索で既存の巻数が連番で揃っているにもかかわらずAmazon側からシリーズ内ASIN一覧だけ取れない場合は、価格チェック全体の失敗ではなく一時的な「保留」として記録し、次回以降も再試行します。価格監査は1円・2円・ポイント誤読のような異常値を検知しつつ、100円台以上の通常セール価格は低すぎるという理由だけでは警告にしません。

Fast Origin Transferを抑えるため、Blob読み込みはプロセス内で短時間キャッシュします。`BLOB_STORE_MEMORY_CACHE_MS` でキャッシュ時間を調整できます。また、価格履歴は価格・ポイント・実質価格・定価が変わった時だけ追加し、単巻は `PRICE_HISTORY_MAX_ENTRIES_PER_BOOK` 件、シリーズ合計は `SERIES_PRICE_HISTORY_MAX_ENTRIES_PER_SERIES` 件まで保持します。シリーズ合計履歴では上限外でも観測済み最安のエントリを保持します。`SERIES_TOTAL_OBSERVATION_RUNS` はシリーズ合計として同一観測扱いする直近実行枠数で、未設定時は5回です。

### GitHub Actionsログ確認

GitHub connectorが使えない環境では、GitHub fine-grained PATをmacOS Keychainに保存してActions履歴を確認します。トークンはこのリポジトリだけに限定し、権限は `Actions: Read-only` と `Metadata: Read-only` にします。トークンをコピーした状態で `node scripts/save-github-actions-token.mjs` を実行すると、Keychainの `kindle-price-watch-github-actions` / `hiyokko` に保存し、クリップボードを空にします。以後は以下のコマンドで確認できます。

```bash
node scripts/github-actions.mjs doctor
node scripts/github-actions.mjs runs --limit 10
node scripts/github-actions.mjs jobs <run-id>
node scripts/github-actions.mjs logs <run-id> --grep 'timeout|SIGTERM|CHECK_HARD_TIMEOUT|error'
```

定期実行時は、登録済みシリーズのAmazonシリーズページも巡回し、新しい巻が見つかった場合は自動で追加します。明示的に完結が確認できたシリーズには完結フラグと新刊探索の「実行なし」状態を保存し、次回以降の新刊探索から除外します。未探索のシリーズは「未実行」、完結などで今後探索しないシリーズは「実行なし」、Amazon側の一時的なシリーズ一覧取得失敗は「保留」として画面上でも区別します。`SERIES_DISCOVERY_BATCH_SIZE` を設定すると、1回の実行で探索するシリーズ数を調整できます。`SERIES_DISCOVERY_INTERVAL_HOURS` の既定値は24時間です。

定期実行では、現在価格の取得に成功した本のうち `listPrice` が未保存の本だけを対象に、単巻ページから `listPrice` 補完を追加で試行します。既定値は1回50件で、GUIの「listPrice補完」から0〜50件に調整できます。補完では現在価格を上書きせず、候補の `listPrice` が既存の価格履歴から大きく乖離する場合は保存しません。

GitHub Actionsの手動実行では、`force_all` を有効にすると24時間以内に確認済みの本も保存した件数まで再確認します。

手動で一度だけ実行する場合は次を使います。

```bash
npm run check
```

大量登録でも1回で全件を処理せず、未チェック順に分割して進める設計です。
