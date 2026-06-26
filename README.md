# MakeLRC

音源を再生しながらタイミングに合わせて打刻し、LRC などの同期歌詞ファイルを作成する Web アプリです。

## Development

```bash
npm install
npm run dev
```

For a production build:

```bash
npm run build
```

## Current Prototype

- ローカル音源を読み込み
- 歌詞を入力または貼り付け。空行は自動削除
- Space または大きな打刻エリアのタップで現在行を打刻
- 打刻単位を `行`、`単語`、`文字` から選択
- 打ち直しで現在行のタイムスタンプの少し前へ戻って再試行
- 間奏追加で `♪ 間奏` 行を挿入
- LRC、Enhanced LRC、WebVTT、SRT として出力
- 出力形式を変更しても打刻済みの行タイミングを維持し、選択中の形式へ変換
- 作業中の歌詞とタイミングを `localStorage` に一時保存

## Shortcuts

- Space: 現在行を打刻
- Shift + Space: 再生 / 停止
- R: 現在行を打ち直し
- ArrowUp: 前の行
- ArrowDown: 次の行
- J: 3秒戻る
- K: 3秒進む
- Ctrl / Cmd + Z: 取消
- Ctrl / Cmd + Y: やり直し
- ?: ヘルプを表示 / 非表示
