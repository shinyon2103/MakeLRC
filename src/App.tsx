import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";

const STORAGE_KEY = "makelrc.autosave.v3";
const RETAKE_MARGIN_SECONDS = 2.5;
const SEEK_STEP_SECONDS = 3;
const AUDIO_FILE_EXTENSIONS = new Set([
  "aac",
  "aif",
  "aiff",
  "caf",
  "flac",
  "m4a",
  "mp3",
  "mp4",
  "oga",
  "ogg",
  "opus",
  "wav",
  "weba",
  "webm",
]);

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

function isLikelyAudioFile(file: File) {
  if (file.type.startsWith("audio/")) return true;
  const extension = file.name.split(".").pop()?.toLowerCase();
  return extension ? AUDIO_FILE_EXTENSIONS.has(extension) : false;
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
  const [saveStatus, setSaveStatus] = useState(initialDraft ? "一時保存を復元" : "未保存");
  const [currentTime, setCurrentTime] = useState(0);
  const [audioUrl, setAudioUrl] = useState("");
  const [isAudioDragging, setIsAudioDragging] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const outputPreviewRef = useRef<HTMLDivElement | null>(null);
  const activeOutputRef = useRef<HTMLDivElement | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const displayedCentisecondRef = useRef(-1);

  const output = useMemo(() => buildOutput(lines, timings, format), [format, lines, timings]);
  const activeLine = lines[activeIndex] ?? "歌詞を入力してください";

  const pushUndo = useCallback(() => {
    setUndoStack((stack) => {
      const next = [...stack, { timings: [...timings], activeIndex }];
      return next.length > 100 ? next.slice(1) : next;
    });
    setRedoStack([]);
  }, [activeIndex, timings]);

  const releaseButtonFocus = useCallback(() => {
    const activeElement = document.activeElement;
    if (activeElement instanceof HTMLButtonElement) {
      activeElement.blur();
    }
  }, []);

  const preventButtonMouseFocus = useCallback((event: ReactMouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
  }, []);

  const syncCurrentTime = useCallback((force = false) => {
    const nextTime = audioRef.current?.currentTime ?? 0;
    const nextCentisecond = Math.round(nextTime * 100);
    if (force || nextCentisecond !== displayedCentisecondRef.current) {
      displayedCentisecondRef.current = nextCentisecond;
      setCurrentTime(nextTime);
    }
  }, []);

  const stopTimeLoop = useCallback(() => {
    if (animationFrameRef.current !== null) {
      window.cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
  }, []);

  const startTimeLoop = useCallback(() => {
    stopTimeLoop();

    const tick = () => {
      syncCurrentTime();
      if (!audioRef.current?.paused) {
        animationFrameRef.current = window.requestAnimationFrame(tick);
      }
    };

    animationFrameRef.current = window.requestAnimationFrame(tick);
  }, [stopTimeLoop, syncCurrentTime]);

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
    releaseButtonFocus();
    pushUndo();
    const audio = audioRef.current;
    setTimings((current) => {
      const next = [...current];
      next[activeIndex] = audio?.currentTime ?? 0;
      return next;
    });
    setActiveIndex((index) => clampLineIndex(index + 1, lines.length));
  }, [activeIndex, lines.length, pushUndo, releaseButtonFocus]);

  const retakeCurrentLine = useCallback(() => {
    if (!lines.length) return;
    releaseButtonFocus();
    const audio = audioRef.current;
    if (!audio) return;
    const currentStamp = timings[activeIndex];
    audio.currentTime = Number.isFinite(currentStamp)
      ? Math.max(0, (currentStamp ?? 0) - RETAKE_MARGIN_SECONDS)
      : Math.max(0, audio.currentTime - RETAKE_MARGIN_SECONDS);
    setSaveStatus("打ち直し準備");
    syncCurrentTime(true);
    void audio.play().then(startTimeLoop).catch(() => undefined);
  }, [activeIndex, lines.length, releaseButtonFocus, startTimeLoop, syncCurrentTime, timings]);

  const moveActive = useCallback((delta: number) => {
    releaseButtonFocus();
    setActiveIndex((index) => clampLineIndex(index + delta, lines.length));
  }, [lines.length, releaseButtonFocus]);

  const seekBy = useCallback((delta: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    releaseButtonFocus();
    audio.currentTime = Math.max(0, audio.currentTime + delta);
    syncCurrentTime(true);
  }, [releaseButtonFocus, syncCurrentTime]);

  const undo = useCallback(() => {
    releaseButtonFocus();
    setUndoStack((stack) => {
      const snapshot = stack.at(-1);
      if (!snapshot) return stack;
      setRedoStack((redo) => [...redo, { timings: [...timings], activeIndex }]);
      setTimings([...snapshot.timings]);
      setActiveIndex(clampLineIndex(snapshot.activeIndex, lines.length));
      return stack.slice(0, -1);
    });
  }, [activeIndex, lines.length, releaseButtonFocus, timings]);

  const redo = useCallback(() => {
    releaseButtonFocus();
    setRedoStack((stack) => {
      const snapshot = stack.at(-1);
      if (!snapshot) return stack;
      setUndoStack((undoItems) => [...undoItems, { timings: [...timings], activeIndex }]);
      setTimings([...snapshot.timings]);
      setActiveIndex(clampLineIndex(snapshot.activeIndex, lines.length));
      return stack.slice(0, -1);
    });
  }, [activeIndex, lines.length, releaseButtonFocus, timings]);

  const clearTimings = useCallback(() => {
    releaseButtonFocus();
    pushUndo();
    setTimings([]);
    setActiveIndex(0);
  }, [pushUndo, releaseButtonFocus]);

  const togglePlayback = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    releaseButtonFocus();
    if (audio.paused) {
      void audio.play().then(startTimeLoop).catch(() => setSaveStatus("再生できません"));
    } else {
      audio.pause();
      syncCurrentTime(true);
    }
  }, [releaseButtonFocus, startTimeLoop, syncCurrentTime]);

  const pasteLyrics = useCallback(async () => {
    if (!navigator.clipboard?.readText) return;
    const text = await navigator.clipboard.readText();
    if (text) updateLyrics(text);
  }, [updateLyrics]);

  const copyOutput = useCallback(async () => {
    if (!output) return;
    try {
      await navigator.clipboard.writeText(output);
      setSaveStatus("コピーしました");
    } catch {
      const textarea = document.createElement("textarea");
      textarea.className = "output-copy-source";
      textarea.value = output;
      document.body.append(textarea);
      textarea.select();
      document.execCommand("copy");
      textarea.remove();
      setSaveStatus("コピーしました");
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

  const loadAudioFile = useCallback((file: File) => {
    if (!isLikelyAudioFile(file)) {
      setSaveStatus("音源ファイルを選択してください");
      return;
    }

    if (audioUrl) URL.revokeObjectURL(audioUrl);
    const nextUrl = URL.createObjectURL(file);
    setAudioUrl(nextUrl);
    setCurrentTime(0);
    displayedCentisecondRef.current = -1;
    setSaveStatus(file.name);
  }, [audioUrl]);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      try {
        const draft: Draft = { lyrics, timings, activeIndex, format };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(draft));
        setSaveStatus("一時保存済み");
      } catch {
        setSaveStatus("一時保存できません");
      }
    }, 200);
    setSaveStatus("保存中...");
    return () => window.clearTimeout(timeout);
  }, [activeIndex, format, lyrics, timings]);

  useEffect(() => {
    const container = outputPreviewRef.current;
    const activeLineElement = activeOutputRef.current;
    if (!container || !activeLineElement) return;

    const itemTop = activeLineElement.offsetTop;
    const itemBottom = itemTop + activeLineElement.offsetHeight;
    const visibleTop = container.scrollTop;
    const visibleBottom = visibleTop + container.clientHeight;

    if (itemTop < visibleTop) {
      container.scrollTop = itemTop;
    } else if (itemBottom > visibleBottom) {
      container.scrollTop = itemBottom - container.clientHeight;
    }
  }, [activeIndex]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return undefined;

    const onPlay = () => startTimeLoop();
    const onPause = () => {
      stopTimeLoop();
      syncCurrentTime(true);
    };
    const onSeeked = () => syncCurrentTime(true);
    const onLoadedMetadata = () => syncCurrentTime(true);

    audio.addEventListener("play", onPlay);
    audio.addEventListener("pause", onPause);
    audio.addEventListener("seeked", onSeeked);
    audio.addEventListener("loadedmetadata", onLoadedMetadata);

    return () => {
      audio.removeEventListener("play", onPlay);
      audio.removeEventListener("pause", onPause);
      audio.removeEventListener("seeked", onSeeked);
      audio.removeEventListener("loadedmetadata", onLoadedMetadata);
      stopTimeLoop();
    };
  }, [startTimeLoop, stopTimeLoop, syncCurrentTime]);

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
        event.stopPropagation();
        togglePlayback();
        return;
      }

      if (event.code === "Space") {
        event.preventDefault();
        event.stopPropagation();
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

    const onKeyUp = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target)) return;

      if (event.code === "Space") {
        event.preventDefault();
        event.stopPropagation();
      }
    };

    document.addEventListener("keydown", onKeyDown, { capture: true });
    document.addEventListener("keyup", onKeyUp, { capture: true });
    return () => {
      document.removeEventListener("keydown", onKeyDown, { capture: true });
      document.removeEventListener("keyup", onKeyUp, { capture: true });
    };
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
      <section className="workspace" aria-label="MakeLRC エディタ">
        <header className="topbar">
          <div className="brand-block">
            <h1>MakeLRC</h1>
            <p>{saveStatus}</p>
          </div>
          <div className="topbar-actions">
            <button type="button" aria-expanded={helpOpen} onMouseDown={preventButtonMouseFocus} onClick={() => setHelpOpen((open) => !open)}>
              ヘルプ
            </button>
            <button type="button" onMouseDown={preventButtonMouseFocus} onClick={copyOutput}>コピー</button>
            <button type="button" onMouseDown={preventButtonMouseFocus} onClick={downloadOutput}>保存</button>
          </div>
        </header>

        {helpOpen && (
          <section className="help-panel">
            <h2>ショートカット</h2>
            <div className="shortcut-grid">
              <span><kbd>Space</kbd></span><span>現在行を打刻</span>
              <span><kbd>Shift</kbd> + <kbd>Space</kbd></span><span>再生 / 停止</span>
              <span><kbd>R</kbd></span><span>現在行の少し前へ戻って打ち直し</span>
              <span><kbd>ArrowUp</kbd> / <kbd>ArrowDown</kbd></span><span>前の行 / 次の行</span>
              <span><kbd>J</kbd> / <kbd>K</kbd></span><span>3秒戻る / 3秒進む</span>
              <span><kbd>Ctrl</kbd>/<kbd>Cmd</kbd> + <kbd>Z</kbd></span><span>取消</span>
              <span><kbd>Ctrl</kbd>/<kbd>Cmd</kbd> + <kbd>Y</kbd></span><span>やり直し</span>
              <span><kbd>?</kbd></span><span>ヘルプを表示 / 非表示</span>
            </div>
          </section>
        )}

        <section
          className={`audio-panel${isAudioDragging ? " is-dragging" : ""}`}
          aria-label="音源"
          onDragEnter={(event) => {
            event.preventDefault();
            setIsAudioDragging(true);
          }}
          onDragOver={(event) => {
            event.preventDefault();
            event.dataTransfer.dropEffect = "copy";
          }}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
              setIsAudioDragging(false);
            }
          }}
          onDrop={(event) => {
            event.preventDefault();
            setIsAudioDragging(false);
            const file = event.dataTransfer.files[0];
            if (file) loadAudioFile(file);
          }}
        >
          <label className="file-picker">
            <span>音源を選択</span>
            <input
              type="file"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (!file) return;
                loadAudioFile(file);
                event.currentTarget.value = "";
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
            onLoadedMetadata={() => syncCurrentTime(true)}
          />
        </section>

        <section className="editor-grid">
          <section className="lyrics-panel" aria-label="歌詞入力">
            <div className="panel-heading">
              <h2>歌詞</h2>
              <button type="button" onMouseDown={preventButtonMouseFocus} onClick={pasteLyrics}>貼り付け</button>
            </div>
            <textarea
              value={lyrics}
              spellCheck={false}
              placeholder="ここに歌詞を入力または貼り付け。空行は自動で削除されます。"
              onChange={(event) => updateLyrics(event.target.value)}
            />
          </section>

          <section className="timing-panel" aria-label="タイミング操作">
            <div className="timing-display">
              <span id="currentTime">{formatLrcTime(currentTime)}</span>
              <strong id="activeLine">{activeLine}</strong>
            </div>
            <button className="tap-zone" type="button" onMouseDown={preventButtonMouseFocus} onClick={stampCurrentLine}>
              <span>タップで打刻</span>
            </button>
            <div className="control-grid">
              <button type="button" onMouseDown={preventButtonMouseFocus} onClick={togglePlayback}>再生/停止</button>
              <button type="button" onMouseDown={preventButtonMouseFocus} onClick={retakeCurrentLine}>打ち直し</button>
              <button type="button" onMouseDown={preventButtonMouseFocus} onClick={() => moveActive(-1)}>前へ</button>
              <button type="button" onMouseDown={preventButtonMouseFocus} onClick={() => moveActive(1)}>次へ</button>
              <button type="button" onMouseDown={preventButtonMouseFocus} onClick={() => seekBy(-SEEK_STEP_SECONDS)}>-3秒</button>
              <button type="button" onMouseDown={preventButtonMouseFocus} onClick={() => seekBy(SEEK_STEP_SECONDS)}>+3秒</button>
              <button type="button" disabled={!undoStack.length} onMouseDown={preventButtonMouseFocus} onClick={undo}>取消</button>
              <button type="button" disabled={!redoStack.length} onMouseDown={preventButtonMouseFocus} onClick={redo}>やり直し</button>
            </div>
            <div className="options-row">
              <label>
                形式
                <select value={format} onChange={(event) => setFormat(event.target.value as OutputFormat)}>
                  <option value="lrc">LRC</option>
                  <option value="enhanced-lrc">Enhanced LRC</option>
                  <option value="webvtt">WebVTT</option>
                  <option value="srt">SRT</option>
                </select>
              </label>
              <button type="button" onMouseDown={preventButtonMouseFocus} onClick={clearTimings}>時刻クリア</button>
            </div>
          </section>
        </section>

        <section className="preview-panel" aria-label="出力プレビュー">
          <div className="panel-heading">
            <h2>出力</h2>
            <span>{lines.length}行</span>
          </div>
          <div ref={outputPreviewRef} className="output-preview" role="textbox" aria-readonly="true" tabIndex={0}>
            {!lines.length && <div className="output-empty">出力はここに表示されます。</div>}
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
