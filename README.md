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

```bash
cd bridge
npm install
npm start
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

## 開発ステータス

- [x] リポジトリ初期化
- [ ] bridge MVP (POST /translate)
- [ ] Chrome拡張 skeleton
- [ ] DOM置換ロジック
- [ ] バッチング & キャッシュ
- [ ] MutationObserver で動的追加対応
