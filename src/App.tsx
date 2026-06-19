import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const STORAGE_KEY = "makelrc.autosave.v3";
const RETAKE_MARGIN_SECONDS = 2.5;
const SEEK_STEP_SECONDS = 3;

type OutputFormat = "lrc" | "enhanced-lrc" | "webvtt" | "srt";

type Snapshot = {
  timings: Array<number | undefined>;
  activeIndex: number;
};

type Draft = {
  lyrics: string;
  timings: Array<number | undefined>;
  activeIndex: number;
  format: OutputFormat;
};

function normalizeLyrics(text: string) {
  return text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}

function parseLines(text: string) {
  const normalized = normalizeLyrics(text);
  return normalized ? normalized.split("\n") : [];
}

function formatLrcTime(seconds: number | undefined) {
  if (!Number.isFinite(seconds)) return "--:--.--";
  const totalCentiseconds = Math.max(0, Math.round((seconds ?? 0) * 100));
  const minutes = Math.floor(totalCentiseconds / 6000);
  const secs = Math.floor((totalCentiseconds % 6000) / 100);
  const centiseconds = totalCentiseconds % 100;
  return `${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${String(centiseconds).padStart(2, "0")}`;
}

function formatSrtTime(seconds: number | undefined) {
  const millis = Math.max(0, Math.round((seconds ?? 0) * 1000));
  const hours = Math.floor(millis / 3600000);
  const minutes = Math.floor((millis % 3600000) / 60000);
  const secs = Math.floor((millis % 60000) / 1000);
  const ms = millis % 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
}

function formatWebVttTime(seconds: number | undefined) {
  return formatSrtTime(seconds).replace(",", ".");
}

function clampLineIndex(index: number, lineCount: number) {
  return Math.min(Math.max(index, 0), Math.max(0, lineCount - 1));
}

function buildOutput(lines: string[], timings: Array<number | undefined>, format: OutputFormat) {
  const rows = lines.map((text, index) => ({ index, text, time: timings[index] }));

  if (format === "webvtt") {
    const cues = rows.map((row, index) => {
      const start = Number.isFinite(row.time) ? row.time : 0;
      const nextTime = rows.slice(index + 1).find((candidate) => Number.isFinite(candidate.time))?.time;
      const end = Math.max((start ?? 0) + 0.2, Number.isFinite(nextTime) ? nextTime ?? 0 : (start ?? 0) + 4);
      return `${formatWebVttTime(start)} --> ${formatWebVttTime(end)}\n${row.text}`;
    });
    return ["WEBVTT", "", ...cues].join("\n\n");
  }

  if (format === "srt") {
    return rows
      .map((row, index) => {
        const start = Number.isFinite(row.time) ? row.time : 0;
        const nextTime = rows.slice(index + 1).find((candidate) => Number.isFinite(candidate.time))?.time;
        const end = Math.max((start ?? 0) + 0.2, Number.isFinite(nextTime) ? nextTime ?? 0 : (start ?? 0) + 4);
        return `${index + 1}\n${formatSrtTime(start)} --> ${formatSrtTime(end)}\n${row.text}`;
      })
      .join("\n\n");
  }

  return rows.map((row) => `[${formatLrcTime(row.time)}]${row.text}`).join("\n");
}

function readDraft(): Draft | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const draft = JSON.parse(raw) as Partial<Draft>;
    return {
      lyrics: normalizeLyrics(draft.lyrics ?? ""),
      timings: Array.isArray(draft.timings) ? draft.timings : [],
      activeIndex: Number.isInteger(draft.activeIndex) ? draft.activeIndex ?? 0 : 0,
      format: draft.format ?? "lrc",
    };
  } catch {
    return null;
  }
}

function isEditableTarget(target: EventTarget | null) {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}

export function App() {
  const initialDraft = useMemo(readDraft, []);
  const [lyrics, setLyrics] = useState(initialDraft?.lyrics ?? "");
  const [lines, setLines] = useState(() => parseLines(initialDraft?.lyrics ?? ""));
  const [timings, setTimings] = useState<Array<number | undefined>>(initialDraft?.timings ?? []);
  const [activeIndex, setActiveIndex] = useState(initialDraft?.activeIndex ?? 0);
  const [undoStack, setUndoStack] = useState<Snapshot[]>([]);
  const [redoStack, setRedoStack] = useState<Snapshot[]>([]);
  const [format, setFormat] = useState<OutputFormat>(initialDraft?.format ?? "lrc");
  const [saveStatus, setSaveStatus] = useState(initialDraft ? "Draft restored" : "Not saved");
  const [currentTime, setCurrentTime] = useState(0);
  const [audioUrl, setAudioUrl] = useState("");
  const [helpOpen, setHelpOpen] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const activeOutputRef = useRef<HTMLDivElement | null>(null);

  const output = useMemo(() => buildOutput(lines, timings, format), [format, lines, timings]);
  const activeLine = lines[activeIndex] ?? "Enter lyrics to start";

  const pushUndo = useCallback(() => {
    setUndoStack((stack) => {
      const next = [...stack, { timings: [...timings], activeIndex }];
      return next.length > 100 ? next.slice(1) : next;
    });
    setRedoStack([]);
  }, [activeIndex, timings]);

  const updateLyrics = useCallback((value: string) => {
    const normalized = normalizeLyrics(value);
    const nextLines = parseLines(normalized);
    setLyrics(normalized);
    setLines(nextLines);
    setTimings((current) => current.slice(0, nextLines.length));
    setActiveIndex((index) => clampLineIndex(index, nextLines.length));
  }, []);

  const stampCurrentLine = useCallback(() => {
    if (!lines.length) return;
    pushUndo();
    const audio = audioRef.current;
    setTimings((current) => {
      const next = [...current];
      next[activeIndex] = audio?.currentTime ?? 0;
      return next;
    });
    setActiveIndex((index) => clampLineIndex(index + 1, lines.length));
  }, [activeIndex, lines.length, pushUndo]);

  const retakeCurrentLine = useCallback(() => {
    if (!lines.length) return;
    const audio = audioRef.current;
    if (!audio) return;
    const currentStamp = timings[activeIndex];
    audio.currentTime = Number.isFinite(currentStamp)
      ? Math.max(0, (currentStamp ?? 0) - RETAKE_MARGIN_SECONDS)
      : Math.max(0, audio.currentTime - RETAKE_MARGIN_SECONDS);
    setSaveStatus("Ready to retake");
    setCurrentTime(audio.currentTime);
    void audio.play().catch(() => undefined);
  }, [activeIndex, lines.length, timings]);

  const moveActive = useCallback((delta: number) => {
    setActiveIndex((index) => clampLineIndex(index + delta, lines.length));
  }, [lines.length]);

  const seekBy = useCallback((delta: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = Math.max(0, audio.currentTime + delta);
    setCurrentTime(audio.currentTime);
  }, []);

  const undo = useCallback(() => {
    setUndoStack((stack) => {
      const snapshot = stack.at(-1);
      if (!snapshot) return stack;
      setRedoStack((redo) => [...redo, { timings: [...timings], activeIndex }]);
      setTimings([...snapshot.timings]);
      setActiveIndex(clampLineIndex(snapshot.activeIndex, lines.length));
      return stack.slice(0, -1);
    });
  }, [activeIndex, lines.length, timings]);

  const redo = useCallback(() => {
    setRedoStack((stack) => {
      const snapshot = stack.at(-1);
      if (!snapshot) return stack;
      setUndoStack((undoItems) => [...undoItems, { timings: [...timings], activeIndex }]);
      setTimings([...snapshot.timings]);
      setActiveIndex(clampLineIndex(snapshot.activeIndex, lines.length));
      return stack.slice(0, -1);
    });
  }, [activeIndex, lines.length, timings]);

  const clearTimings = useCallback(() => {
    pushUndo();
    setTimings([]);
    setActiveIndex(0);
  }, [pushUndo]);

  const togglePlayback = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) {
      void audio.play().catch(() => setSaveStatus("Playback failed"));
    } else {
      audio.pause();
    }
  }, []);

  const pasteLyrics = useCallback(async () => {
    if (!navigator.clipboard?.readText) return;
    const text = await navigator.clipboard.readText();
    if (text) updateLyrics(text);
  }, [updateLyrics]);

  const copyOutput = useCallback(async () => {
    if (!output) return;
    try {
      await navigator.clipboard.writeText(output);
      setSaveStatus("Copied");
    } catch {
      const textarea = document.createElement("textarea");
      textarea.className = "output-copy-source";
      textarea.value = output;
      document.body.append(textarea);
      textarea.select();
      document.execCommand("copy");
      textarea.remove();
      setSaveStatus("Copied");
    }
  }, [output]);

  const downloadOutput = useCallback(() => {
    if (!output) return;
    const extension = format === "webvtt" ? "vtt" : format === "srt" ? "srt" : "lrc";
    const blob = new Blob([output], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `lyrics.${extension}`;
    anchor.click();
    URL.revokeObjectURL(url);
  }, [format, output]);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      try {
        const draft: Draft = { lyrics, timings, activeIndex, format };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(draft));
        setSaveStatus("Draft saved");
      } catch {
        setSaveStatus("Draft save failed");
      }
    }, 200);
    setSaveStatus("Saving...");
    return () => window.clearTimeout(timeout);
  }, [activeIndex, format, lyrics, timings]);

  useEffect(() => {
    activeOutputRef.current?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();

      if (key === "?" && !isEditableTarget(event.target)) {
        event.preventDefault();
        setHelpOpen((open) => !open);
        return;
      }

      if (isEditableTarget(event.target)) return;

      if (event.code === "Space" && event.shiftKey) {
        event.preventDefault();
        togglePlayback();
        return;
      }

      if (event.code === "Space") {
        event.preventDefault();
        stampCurrentLine();
        return;
      }

      if (key === "r") {
        event.preventDefault();
        retakeCurrentLine();
        return;
      }

      if (event.code === "ArrowUp") {
        event.preventDefault();
        moveActive(-1);
        return;
      }

      if (event.code === "ArrowDown") {
        event.preventDefault();
        moveActive(1);
        return;
      }

      if (key === "j") {
        event.preventDefault();
        seekBy(-SEEK_STEP_SECONDS);
        return;
      }

      if (key === "k") {
        event.preventDefault();
        seekBy(SEEK_STEP_SECONDS);
        return;
      }

      if ((event.ctrlKey || event.metaKey) && key === "z") {
        event.preventDefault();
        undo();
        return;
      }

      if ((event.ctrlKey || event.metaKey) && key === "y") {
        event.preventDefault();
        redo();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [moveActive, redo, retakeCurrentLine, seekBy, stampCurrentLine, togglePlayback, undo]);

  useEffect(() => {
    let lastTouchEnd = 0;
    const onTouchEnd = (event: TouchEvent) => {
      const now = Date.now();
      if (now - lastTouchEnd <= 320) event.preventDefault();
      lastTouchEnd = now;
    };

    document.addEventListener("touchend", onTouchEnd, { passive: false });
    return () => document.removeEventListener("touchend", onTouchEnd);
  }, []);

  useEffect(() => {
    return () => {
      if (audioUrl) URL.revokeObjectURL(audioUrl);
    };
  }, [audioUrl]);

  return (
    <main className="app-shell">
      <section className="workspace" aria-label="MakeLRC editor">
        <header className="topbar">
          <div>
            <h1>MakeLRC</h1>
            <p>{saveStatus}</p>
          </div>
          <div className="topbar-actions">
            <button type="button" aria-expanded={helpOpen} onClick={() => setHelpOpen((open) => !open)}>
              Help
            </button>
            <button type="button" onClick={copyOutput}>Copy</button>
            <button type="button" onClick={downloadOutput}>Save LRC</button>
          </div>
        </header>

        {helpOpen && (
          <section className="help-panel">
            <h2>Keyboard shortcuts</h2>
            <div className="shortcut-grid">
              <span><kbd>Space</kbd></span><span>Stamp current line</span>
              <span><kbd>Shift</kbd> + <kbd>Space</kbd></span><span>Play / pause</span>
              <span><kbd>R</kbd></span><span>Retake current line from a little before its timestamp</span>
              <span><kbd>ArrowUp</kbd> / <kbd>ArrowDown</kbd></span><span>Previous / next line</span>
              <span><kbd>J</kbd> / <kbd>K</kbd></span><span>Back / forward 3 seconds</span>
              <span><kbd>Ctrl</kbd>/<kbd>Cmd</kbd> + <kbd>Z</kbd></span><span>Undo</span>
              <span><kbd>Ctrl</kbd>/<kbd>Cmd</kbd> + <kbd>Y</kbd></span><span>Redo</span>
              <span><kbd>?</kbd></span><span>Show / hide this help</span>
            </div>
          </section>
        )}

        <section className="audio-panel" aria-label="Audio">
          <label className="file-picker">
            <span>Choose audio</span>
            <input
              type="file"
              accept="audio/*"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (!file) return;
                if (audioUrl) URL.revokeObjectURL(audioUrl);
                const nextUrl = URL.createObjectURL(file);
                setAudioUrl(nextUrl);
                setSaveStatus(file.name);
              }}
            />
          </label>
          <audio
            ref={audioRef}
            controls
            playsInline
            preload="metadata"
            src={audioUrl}
            onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
            onLoadedMetadata={(event) => setCurrentTime(event.currentTarget.currentTime)}
          />
        </section>

        <section className="editor-grid">
          <section className="lyrics-panel" aria-label="Lyrics input">
            <div className="panel-heading">
              <h2>Lyrics</h2>
              <button type="button" onClick={pasteLyrics}>Paste</button>
            </div>
            <textarea
              value={lyrics}
              spellCheck={false}
              placeholder="Type or paste lyrics here. Blank lines are removed automatically."
              onChange={(event) => updateLyrics(event.target.value)}
            />
          </section>

          <section className="timing-panel" aria-label="Timing controls">
            <div className="timing-display">
              <span id="currentTime">{formatLrcTime(currentTime)}</span>
              <strong id="activeLine">{activeLine}</strong>
            </div>
            <button className="tap-zone" type="button" onClick={stampCurrentLine}>
              <span>Tap to stamp</span>
            </button>
            <div className="control-grid">
              <button type="button" onClick={togglePlayback}>Play / Pause</button>
              <button type="button" onClick={stampCurrentLine}>Stamp</button>
              <button type="button" onClick={retakeCurrentLine}>Retake</button>
              <button type="button" onClick={() => moveActive(-1)}>Previous</button>
              <button type="button" onClick={() => moveActive(1)}>Next</button>
              <button type="button" onClick={() => seekBy(-SEEK_STEP_SECONDS)}>-3s</button>
              <button type="button" onClick={() => seekBy(SEEK_STEP_SECONDS)}>+3s</button>
              <button type="button" disabled={!undoStack.length} onClick={undo}>Undo</button>
              <button type="button" disabled={!redoStack.length} onClick={redo}>Redo</button>
            </div>
            <div className="options-row">
              <label>
                Format
                <select value={format} onChange={(event) => setFormat(event.target.value as OutputFormat)}>
                  <option value="lrc">LRC</option>
                  <option value="enhanced-lrc">Enhanced LRC</option>
                  <option value="webvtt">WebVTT</option>
                  <option value="srt">SRT</option>
                </select>
              </label>
              <button type="button" onClick={clearTimings}>Clear timings</button>
            </div>
          </section>
        </section>

        <section className="preview-panel" aria-label="Output preview">
          <div className="panel-heading">
            <h2>Output</h2>
            <span>{lines.length} lines</span>
          </div>
          <div className="output-preview" role="textbox" aria-readonly="true" tabIndex={0}>
            {!lines.length && <div className="output-empty">Output will appear here.</div>}
            {lines.map((line, index) => (
              <div
                key={`${index}-${line}`}
                ref={index === activeIndex ? activeOutputRef : undefined}
                className={`output-line${index === activeIndex ? " is-active" : ""}`}
              >
                <span className="output-time">[{formatLrcTime(timings[index])}]</span>
                <span>{line}</span>
              </div>
            ))}
          </div>
        </section>
      </section>
    </main>
  );
}
