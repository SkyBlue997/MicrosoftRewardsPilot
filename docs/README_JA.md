<div align="center">

<!-- 言語切替 / Language Switch / 语言切换 -->
**[中文](../README.md)** | **[English](README_EN.md)** | **[日本語](README_JA.md)**

---

# MicrosoftRewardsPilot 自動化スクリプト

**インテリジェント Microsoft Rewards ポイント自動収集ツール**

[![GitHub](https://img.shields.io/badge/GitHub-SkyBlue997-blue?style=flat-square&logo=github)](https://github.com/SkyBlue997/MicrosoftRewardsPilot)
[![License](https://img.shields.io/badge/License-MIT-green?style=flat-square)](LICENSE)
[![Docker](https://img.shields.io/badge/Docker-対応-blue?style=flat-square&logo=docker)](https://hub.docker.com)

---

</div>

## 目次

1. [クイックスタート](#クイックスタート)
2. [メイン設定](#メイン設定)
3. [トラブルシューティング・テスト](#トラブルシューティングテスト)
4. [コア機能](#コア機能)
5. [完全設定例](#完全設定例)
6. [重要な警告](#重要な警告)

---

## クイックスタート

<details>
<summary><strong>ローカル実行</strong> （クリックして展開）</summary>

```bash
# 1. リポジトリのクローン
git clone https://github.com/SkyBlue997/MicrosoftRewardsPilot
cd MicrosoftRewardsPilot

# 2. 依存関係のインストール
npm i

# 3. 設定ファイル
# サンプル設定ファイルをコピーして編集
cp config/config.json.example config/config.json
cp config/accounts.json.example config/accounts.json

# 4. ビルドと実行
npm run build
npm start
```

</details>

<details>
<summary><strong>Docker デプロイ（推奨）</strong> （クリックして展開）</summary>

```bash
# 1. 設定ファイルの準備
# サンプル設定ファイルをコピーして編集
cp config/config.json.example config/config.json
cp config/accounts.json.example config/accounts.json

# 2. ビルド
npm run build

# 3. コンテナの開始
docker compose up -d

# 4. ログの確認（オプション）
docker logs -f microsoftrewardspilot
```

**Docker Compose 設定例：**

```yaml
services:
  microsoftrewardspilot:
    build: .
    container_name: microsoftrewardspilot
    restart: unless-stopped
    volumes:
      - ./config/accounts.json:/usr/src/microsoftrewardspilot/dist/config/accounts.json
      - ./config/config.json:/usr/src/microsoftrewardspilot/dist/config/config.json
      - ./sessions:/usr/src/microsoftrewardspilot/sessions  # ログインセッションを保存
    environment:
      - NODE_ENV=production
      - TZ=Asia/Tokyo  # 地理的位置に応じて設定
      - CRON_SCHEDULE=0 9,16 * * *  # 「ちょうどの時刻」を避け、奇数・非整数・分散した時間に変更することを推奨（毎日同じ時刻に集中させない）。run_daily.sh がさらに 3〜85 分のランダムなジッターを上乗せします
      - RUN_ON_START=true  # コンテナ起動時に即座に1回実行
      # 反検出：rebrowser の Runtime.enable 修正を有効化（src/rebrowser-env.ts にデフォルト値が組み込み済み。ここで明示すると上書きできて便利）
      - REBROWSER_PATCHES_RUNTIME_FIX_MODE=addBinding
      - REBROWSER_PATCHES_UTILITY_WORLD_NAME=util
```
> 地理的位置／タイムゾーンは `config.json` の `searchSettings.multiLanguage.autoDetectLocation` と `searchSettings.autoTimezone` で制御します（環境変数ではありません）。

</details>

---

## メイン設定

### 基本設定
```json
{
  "headless": true,           // ヘッドレスモードで実行
  "parallel": true,           // タスクを並列実行
  "clusters": 1,              // クラスター数
  "globalTimeout": "45min",   // グローバルタイムアウト時間
  "runOnZeroPoints": false,   // ゼロポイント時は実行しない
  "accountDelay": {           // アカウント間の遅延時間
    "min": "5min",            // 最小間隔5分
    "max": "15min"            // 最大間隔15分
  }
}
```

### スマート検索設定
> 検索間隔（対数正規分布の遅延）と人間らしいタイピングは内蔵されています。クエリ言語はアカウントの市場に応じて自動的にローカライズされます（ja/en/zh-CN/vi には完全なクエリ集が用意されています）。調整可能なキー：
```json
{
  "searchSettings": {
    "useGeoLocaleQueries": true,    // リクエストヘッダー X-Rewards-Country/Language にのみ影響
    "multiLanguage": {
      "enabled": true,              // 多言語サポート
      "autoDetectLocation": true    // 位置自動検出（クエリとタイムゾーンのローカライズを決定）
    },
    "autoTimezone": {
      "enabled": true,              // 自動タイムゾーン
      "setOnStartup": true          // 起動時に設定
    }
  }
}
```
### タスク設定
> その他の獲得可能なアクティビティ（デイリータスクセット、チェックイン、読んで稼ぐ、パズルなど）は自動的に獲得され、トグルは不要です。
```json
{
  "workers": {
    "doDesktopSearch": true,   // デスクトップ検索
    "doMobileSearch": true,    // モバイル検索（L2 以降）
    "doMorePromotions": true   // Explore on Bing / プロモーションタスク
  }
}
```

### ポップアップ処理設定
```json
{
  "popupHandling": {
    "enabled": false,                    // ポップアップ処理を有効化（デフォルトは無効）
    "handleReferralPopups": true,        // 紹介ポップアップを処理
    "handleStreakProtectionPopups": true,// 連続保護ポップアップを処理
    "handleStreakRestorePopups": true,   // 連続復元ポップアップを処理
    "handleGenericModals": true,         // 汎用モーダルを処理
    "logPopupHandling": true             // ポップアップ処理ログを記録
  }
}
```

### Passkey処理設定
```json
{
  "passkeyHandling": {
    "enabled": true,              // Passkey処理を有効化
    "maxAttempts": 5              // 最大試行回数
  }
}
```

---

## トラブルシューティング・テスト

### **モバイル2FA認証問題**

**問題：** モバイルタスクで二要素認証が要求される

**解決方法：** 専用の2FA認証アシスタントツールを使用

```bash
# 2FA認証アシスタントを実行
npx ts-node src/helpers/manual-2fa-helper.ts
```

**使用手順：**
1. コマンド実行後、言語を選択
2. 認証するメールアドレスとパスワードを入力
3. 開いたブラウザで2FA認証手順を完了
4. OAuth認証の完了を待つ
5. ツールが自動的にモバイルセッションデータを保存
6. 自動化プログラムを再実行すると、モバイルタスクが2FA認証をスキップ

### **ポップアップ処理問題**

**問題：** プログラムがポップアップ処理で無限ループに陥る

**現象：** ログに繰り返しポップアップ検出情報が表示される
```
[REWARDS-POPUP] 🎯 Detected Streak Protection Popup
[REWARDS-POPUP] 🎯 Detected Streak Protection Popup
```

**解決方法：**
1. **即時対応**：`config/config.json` でポップアップ処理を無効化
```json
{
  "popupHandling": {
    "enabled": false
  }
}
```

2. **選択的有効化**：必要なポップアップタイプのみ有効化
```json
{
  "popupHandling": {
    "enabled": true,
    "handleReferralPopups": true,
    "handleStreakProtectionPopups": false,
    "handleStreakRestorePopups": false
  }
}
```

### **Passkey設定ループ問題**

**問題：** ログイン後、Passkey設定ページにリダイレクトされ、「今はスキップ」をクリックしても無限ループになる

**現象：** "Starting login process!" の後でプログラムが停止

**解決方法：** システムが自動的にPasskeyループ問題を処理
- **自動検出**：Passkey設定ページを検出
- **複数の回避策**：スキップボタン、ESCキー、直接ナビゲーション
- **スマートリトライ**：最大5回まで試行し無限ループを防止
- **設定で制御可能**：configで処理戦略を調整可能

**設定例：**
```json
{
  "passkeyHandling": {
    "enabled": true,
    "maxAttempts": 5
  }
}
```

### **よくある問題**

<details>
<summary><strong>ポイント取得制限・自動化検出</strong></summary>

**現象：** 連続検索でポイントなし、またはポイント取得不完全
**説明：** 多くの場合、検出されているわけではなく、以下が原因です：
- **報酬日のリセット境界（おおよそ現地時間の深夜前後）**：dapi が一貫しないスナップショットを返します（検索／読書が「リセット済み」と「旧値」の間で揺れる）。この時間帯には実行せず、安定した時間帯（スクリプト cron の朝／夜など）に実行してください
- **当日のアクティビティは完了済み**：当日2回目の実行は多くが +0 です（正しい冪等な挙動）
- 本当に制限されている場合：実行頻度を下げ、短時間に何度もログインするのを避けてください。本プロジェクトの反検出（rebrowser パッチ、指紋の一貫性、対数正規分布の遅延）は通常の利用とともに回復します

</details>

<details>
<summary><strong>地理位置検出の失敗</strong></summary>

**解決方法：** ネットワーク接続を確認し、地理位置APIサービスへのアクセスを確保

</details>

<details>
<summary><strong>タイムゾーンの不一致</strong></summary>

**解決方法：** `TZ` 環境変数が正しく設定されているかを確認

</details>

<details>
<summary><strong>メモリ不足</strong></summary>

**解決方法：** コンテナを再起動するか、システムリソースの使用状況を確認

</details>

### **Docker トラブルシューティング**

```bash
# ログを表示
docker logs microsoftrewardspilot

# ネットワーク接続をテスト
docker exec microsoftrewardspilot ping google.com

# 地理位置を確認（コード GeoLanguage.ts が使用するサービスと同じ）
docker exec microsoftrewardspilot curl -s https://ipapi.co/json
```

---

## コア機能

<table>
<tr>
<td width="50%" valign="top">

### **サポートされているタスク**
> 新しい rewards.bing.com は Next.js SPA に移行し、旧来の DOM スクレイピングは使えなくなりました。本プロジェクトは **dapi バックエンド API** に接続（アクティビティを直接獲得）＋ 実際の検索／視覚検索に切り替えています。
- **デイリータスクセット / 毎日のアクティビティ / プロモーションタスク** - dapi API 経由で「クリックで完了」型アクティビティを自動獲得（urlreward / 読んで稼ぐ / チェックイン、毎日の一言などの urlreward カード含む）。回答が必要なインタラクティブ Quiz は自動完了されません
- **デスクトップ検索** - 実際の、人間らしいペースの Bing 検索。進捗は dapi から読み取り
- **モバイル検索** - モバイルデバイスシミュレーション（Level 2 以降、PC と当日の検索上限を共有）
- **Explore on Bing** - 報酬 flyout からのカテゴリ検索で完了
- **視覚検索** - Bing 視覚検索アクティビティを自動完了
- **毎日チェックイン** - ウェブチェックイン ＋ Bing アプリチェックイン（2種類の独立したチェックイン）
- **読んで稼ぐ** - 記事を読んでポイント獲得

</td>
<td width="50%" valign="top">

### **スマート機能**
- **マルチアカウントサポート** - 並列クラスター処理
- **セッション保存** - 重複ログインなし、2FA対応
- **dapi バックエンド接続** - 新しい SPA にはスクレイピング可能な DOM がないため、Rewards バックエンド API（`prod.rewardsplatform.microsoft.com/dapi`）を利用。`rewards.bing.com` はログインのランディングページのみ
- **地理位置検出** - IP で地域 / 座標 / タイムゾーンを検出
- **タイムゾーン同期** - マッチングタイムゾーンの自動設定
- **ローカライズ** - アカウントの市場に応じてクエリをローカライズし、対応する `X-Rewards-Language` を送信
- **rebrowser 反検出** - パッチを有効化し、Playwright の `Runtime.enable` CDP リークを除去
- **指紋の一貫性** - fingerprint-injector による注入 ＋ UA/Client-Hints(GREASE) の整合
- **人間らしい行動** - 一文字ずつのタイピング、可変方向のスクロール、結果クリックと滞留
- **人間らしい遅延** - 対数正規分布の検索間隔（区間の硬い境界なし）
- **ペースのランダム化** - アカウント順序のシャッフル、実行開始時刻のジッター
- **ポップアップスマート処理** - Microsoft Rewardsの各種ポップアップを自動検出・閉じる
- **Passkeyループ回避** - Passkey設定ループ問題を自動処理
- **Dockerサポート** - コンテナ化デプロイ
- **自動リトライ** - 失敗タスクのスマートリトライ
- **詳細ログ** - 完全な実行記録
- **柔軟な設定** - 豊富なカスタマイズオプション
- **中国語ローカライズ** - 中国アカウントは組み込みの zh-CN クエリ集から検索（完全ローカライズ言語 ja/en/zh-CN/vi の1つ）

</td>
</tr>
</table>

---

## 完全設定例

> 完全なテンプレートはリポジトリの `config/config.json.example` を参照してください（[クイックスタート](#クイックスタート)で `cp` 済みです）。以下は実際に有効なキーのみを列挙しています：

<details>
<summary><strong>有効な設定項目</strong> （クリックして展開）</summary>

```json
{
  "baseURL": "https://rewards.bing.com",
  "sessionPath": "sessions",
  "headless": true,
  "parallel": false,
  "runOnZeroPoints": false,
  "clusters": 1,
  "saveFingerprint": {
    "mobile": true,
    "desktop": true
  },
  "workers": {
    "doDesktopSearch": true,
    "doMobileSearch": true,
    "doMorePromotions": true
  },
  "searchOnBingLocalQueries": true,
  "globalTimeout": "180min",
  "accountDelay": {
    "min": "8min",
    "max": "20min"
  },
  "searchSettings": {
    "useGeoLocaleQueries": true,
    "multiLanguage": {
      "enabled": true,
      "autoDetectLocation": true
    },
    "autoTimezone": {
      "enabled": true,
      "setOnStartup": true,
      "validateMatch": true,
      "logChanges": true
    }
  },
  "logExcludeFunc": [
    "SEARCH-CLOSE-TABS"
  ],
  "webhookLogExcludeFunc": [
    "SEARCH-CLOSE-TABS"
  ],
  "proxy": {
    "proxyGoogleTrends": true,
    "proxyBingTerms": true
  },
  "webhook": {
    "enabled": false,
    "url": ""
  },
  "popupHandling": {
    "enabled": false,
    "handleReferralPopups": true,
    "handleStreakProtectionPopups": true,
    "handleStreakRestorePopups": true,
    "handleGenericModals": true,
    "logPopupHandling": true
  },
  "passkeyHandling": {
    "enabled": true,
    "maxAttempts": 5
  }
}
```

</details>

---

## 重要な警告

<div align="center">

> **リスク警告**  
> 自動化スクリプトの使用によりアカウントが停止される可能性があります

> **安全性の推奨事項**  
> 適度に使用し、システムがすべての検出回避機能を自動的に有効化

> **定期更新**  
> スクリプトを最新版に保ってください

</div>

---

<div align="center">

**スクリプトをお楽しみください！** 

[![Star History Chart](https://img.shields.io/github/stars/SkyBlue997/MicrosoftRewardsPilot?style=social)](https://github.com/SkyBlue997/MicrosoftRewardsPilot)

*このプロジェクトがお役に立ちましたら、スターをお願いします！*

</div> 