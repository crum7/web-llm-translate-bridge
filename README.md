# llm-translate-bridge

Chrome拡張 + ローカルbridgeサーバで、Claude Code CLI (Max サブスクリプション枠) を翻訳エンジンとして使うページ翻訳ツール。

Google翻訳と同じく **ページ内テキストを丸ごと訳文で置換** する in-place 型。分割ビューなし。

## 構成

```
[Chrome拡張]
   ↓ POST http://127.0.0.1:17891/translate
[bridge (Node.js/Express)]
   ↓ child_process.spawn('claude', ['-p', '--model', 'opus', ...])
[Claude Code CLI]
   ↓ Max サブスク認証 (~/.claude/credentials.json)
[Anthropic API]
```

- APIキー不要、Max枠のみで動く
- モデル: `opus` (デフォルト、汎用ではなくスポット用途想定)
- ポート: `17891` (競合しにくいレンジ、localhost bind)
- 個人利用限定、公開拡張として配布しない

## セットアップ

### bridge

**開発時の一回起動**:
```bash
cd bridge
npm install
npm start
```

**常駐起動 (pm2)** — 起動しっぱなしにしたいとき:
```bash
cd bridge
npm install
npm install -g pm2                  # 初回のみ
pm2 start ecosystem.config.cjs
pm2 logs llm-translate-bridge       # ログ表示
pm2 restart llm-translate-bridge    # 再起動
pm2 stop llm-translate-bridge       # 停止
pm2 save && pm2 startup             # OS再起動後も自動起動
```

環境変数でモデル既定値・token固定などが可能:
```powershell
$env:MODEL="sonnet"; $env:BRIDGE_TOKEN="固定tokenをここに"; pm2 restart llm-translate-bridge --update-env
```

### Chrome拡張

1. Chrome で `chrome://extensions/` を開く
2. 「デベロッパーモード」ON
3. 「パッケージ化されていない拡張機能を読み込む」→ `extension/` フォルダを選択
4. ツールバーのアイコンから「翻訳」を押す

## セキュリティ

- bridgeは `127.0.0.1` のみbind
- CORSは Chrome拡張オリジンのみ許可
- リクエストごとにローカル認証トークン (起動時に生成、拡張の設定で共有) で認可

## 実装済み機能

- [x] bridge MVP (POST /translate)
- [x] Chrome拡張 skeleton (Manifest V3)
- [x] DOM置換ロジック (ブロック単位 + プレースホルダー保持)
- [x] バッチング & 並列翻訳 (BATCH=30, CONCURRENCY=10)
- [x] MutationObserver でSPAナビゲーション自動追従
- [x] HTTPSモード (Tailscale MagicDNS証明書)
- [x] Token永続化 (再起動しても拡張の設定不変)
- [x] bisection fallback (JSONパース失敗時の自動リカバリ)
- [x] popup バッジ + 進捗表示 (popup閉じても進捗が消えない)
- [x] popup 診断ボタン (DevTools不要でデバッグ)
- [x] **localStorageキャッシュ永続化** (30日 / 最大2万エントリ / ページリロード後も残る)
- [x] **popupからモデル切替** (Haiku / Sonnet 4.5 / Opus)
- [x] **pm2で常駐起動**
