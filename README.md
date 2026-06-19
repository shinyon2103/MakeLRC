# MakeLRC

Web-based synchronized lyrics editor for creating LRC files while playing audio.

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

- Load a local audio file.
- Type or paste lyrics into the lyrics box. Blank lines are removed automatically.
- Press Space or tap the large timing area to stamp the current line.
- Use Retake to jump a little before the current line timestamp and immediately retry.
- Export as LRC, Enhanced LRC, WebVTT, or SRT.
- Draft lyrics and timings are saved to `localStorage`.

## Shortcuts

- Space: stamp current line
- Shift + Space: play / pause
- R: retake current line
- ArrowUp: previous line
- ArrowDown: next line
- J: back 3 seconds
- K: forward 3 seconds
- Ctrl / Cmd + Z: undo
- Ctrl / Cmd + Y: redo
- ?: show / hide help
