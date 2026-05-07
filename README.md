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

Vercelのファイルシステムは永続保存に向かないため、GUIとAPIはVercel、データ保存はVercel Blobを使います。保存先の優先順位は `Supabase > Vercel Blob > ローカルJSON` です。

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

Vercel Cronは使わず、`.github/workflows/kindle-price-check.yml` で価格チェックだけをGitHub Actions上で実行します。VercelはWeb GUIとAPI、Vercel Blobはデータ保存先として使います。

GitHubリポジトリの Settings > Secrets and variables > Actions に、少なくとも次を登録します。

```text
BLOB_READ_WRITE_TOKEN=Vercel BlobのRead Write Token
```

Discord Webhookはアプリ画面から保存済みであればBlobから読み込まれます。GitHub Actions側だけで通知先を指定したい場合は、追加で `DISCORD_WEBHOOK_URL` をSecretに登録します。

### Supabaseを使う場合

Supabaseを使う場合はSQL Editorで次を実行し、`SUPABASE_URL` と `SUPABASE_SERVICE_ROLE_KEY` をVercel環境変数に設定します。Supabase設定がある場合はBlobより優先されます。

```sql
create table if not exists app_state (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);
```

## 価格取得について

`PRICE_PROVIDER=amazon_html` の場合、Amazon商品ページHTMLから価格を取得します。

`PRICE_PROVIDER=auto` の場合、次の順に使います。

1. Keepa API (`KEEPA_API_KEY` がある場合)
2. Amazon商品ページHTMLの簡易取得

Amazon HTML取得はブロックされることがあるため、常用するならKeepa、またはAmazon公式Creators API相当の取得元に差し替えるのがおすすめです。

## シリーズURL

`https://www.amazon.co.jp/dp/XXXXXXXXXX?binding=kindle_edition...` のようなAmazonシリーズページURLを追加すると、ページ内のKindleシリーズASINを抽出して複数冊を登録します。`SERIES_IMPORT_LIMIT` を設定しない限り、アプリ側では冊数上限を設けません。

Vercel Hobbyでは登録時に全巻の詳細取得まで行うとタイムアウトしやすいため、初期値ではまずASINだけを登録します。その後、手動の「価格チェック」またはCronでタイトル・価格・画像を順次取得します。登録時に詳細も取りたい場合は `SERIES_IMPORT_FETCH_DETAILS=true` を設定してください。

## 定期実行

GitHub Actionsでは、アプリ画面に保存した再確認時間より古い本を、保存した件数ずつ自動チェックします。既定のWorkflowでは毎日16:00 JSTに、1冊ずつ間隔を空けて確認します。1000冊規模でもAmazonや補助サイトに連続アクセスしすぎないよう、`CHECK_REQUEST_DELAY_MS` / `CHECK_REQUEST_JITTER_MS` / `HTTP_REQUEST_MIN_INTERVAL_MS` で待機時間を調整します。429/503/CAPTCHA系の応答を検知した場合は、`CHECK_BLOCK_COOLDOWN_MS` / `HTTP_BLOCK_COOLDOWN_MS` のクールダウンを挟みます。

価格チェックは最後に確認できた本を `checkCursor` として保存します。途中で停止した場合でも、次回はその続きから確認します。期限切れの本を最後まで確認して枠が余った場合のみ、先頭に戻って前回分を重複チェックします。

定期実行時は、登録済みシリーズのAmazonシリーズページも巡回し、新しい巻が見つかった場合は自動で追加します。明示的に完結が確認できたシリーズには完結フラグを保存し、次回以降の新刊探索から除外します。`SERIES_DISCOVERY_BATCH_SIZE` を設定すると、1回の実行で探索するシリーズ数を調整できます。

GitHub Actionsの手動実行では、`force_all` を有効にすると24時間以内に確認済みの本も保存した件数まで再確認します。

手動で一度だけ実行する場合は次を使います。

```bash
npm run check
```

大量登録でも1回で全件を処理せず、未チェック順に分割して進める設計です。
