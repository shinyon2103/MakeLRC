const STORAGE_KEY = "makelrc.autosave.v1";

const elements = {
  audioFileInput: document.querySelector("#audioFileInput"),
  audioPlayer: document.querySelector("#audioPlayer"),
  lyricsInput: document.querySelector("#lyricsInput"),
  pasteButton: document.querySelector("#pasteButton"),
  playPauseButton: document.querySelector("#playPauseButton"),
  stampButton: document.querySelector("#stampButton"),
  previousButton: document.querySelector("#previousButton"),
  nextButton: document.querySelector("#nextButton"),
  undoButton: document.querySelector("#undoButton"),
  redoButton: document.querySelector("#redoButton"),
  clearTimingsButton: document.querySelector("#clearTimingsButton"),
  copyOutputButton: document.querySelector("#copyOutputButton"),
  downloadButton: document.querySelector("#downloadButton"),
  formatSelect: document.querySelector("#formatSelect"),
  outputPreview: document.querySelector("#outputPreview"),
  currentTime: document.querySelector("#currentTime"),
  activeLine: document.querySelector("#activeLine"),
  lineCount: document.querySelector("#lineCount"),
  saveStatus: document.querySelector("#saveStatus"),
  tapZone: document.querySelector("#tapZone"),
};

const state = {
  lines: [],
  activeIndex: 0,
  timings: [],
  undoStack: [],
  redoStack: [],
  audioUrl: "",
  saveTimer: 0,
};

function parseLines(text) {
  return text.replace(/\r\n/g, "\n").split("\n");
}

function formatLrcTime(seconds) {
  if (!Number.isFinite(seconds)) return "";
  const totalCentiseconds = Math.max(0, Math.round(seconds * 100));
  const minutes = Math.floor(totalCentiseconds / 6000);
  const secs = Math.floor((totalCentiseconds % 6000) / 100);
  const centiseconds = totalCentiseconds % 100;
  return `${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${String(centiseconds).padStart(2, "0")}`;
}

function formatClock(seconds) {
  return formatLrcTime(seconds || 0);
}

function formatSrtTime(seconds) {
  const millis = Math.max(0, Math.round((seconds || 0) * 1000));
  const hours = Math.floor(millis / 3600000);
  const minutes = Math.floor((millis % 3600000) / 60000);
  const secs = Math.floor((millis % 60000) / 1000);
  const ms = millis % 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
}

function getStampedLines() {
  return state.lines
    .map((text, index) => ({ text, time: state.timings[index] }))
    .filter((line) => line.text.trim().length > 0);
}

function buildOutput() {
  const stamped = getStampedLines();
  const format = elements.formatSelect.value;

  if (format === "webvtt") {
    const cues = stamped.map((line, index) => {
      const start = Number.isFinite(line.time) ? line.time : 0;
      const next = Number.isFinite(stamped[index + 1]?.time) ? stamped[index + 1].time : start + 4;
      return `${formatWebVttTime(start)} --> ${formatWebVttTime(Math.max(start + 0.2, next))}\n${line.text}`;
    });
    return ["WEBVTT", "", ...cues].join("\n\n");
  }

  if (format === "srt") {
    return stamped
      .map((line, index) => {
        const start = Number.isFinite(line.time) ? line.time : 0;
        const next = Number.isFinite(stamped[index + 1]?.time) ? stamped[index + 1].time : start + 4;
        return `${index + 1}\n${formatSrtTime(start)} --> ${formatSrtTime(Math.max(start + 0.2, next))}\n${line.text}`;
      })
      .join("\n\n");
  }

  return stamped
    .map((line) => {
      const time = Number.isFinite(line.time) ? formatLrcTime(line.time) : "--:--.--";
      return `[${time}]${line.text}`;
    })
    .join("\n");
}

function formatWebVttTime(seconds) {
  return formatSrtTime(seconds).replace(",", ".");
}

function pushUndo() {
  state.undoStack.push({
    timings: [...state.timings],
    activeIndex: state.activeIndex,
  });
  if (state.undoStack.length > 100) state.undoStack.shift();
  state.redoStack = [];
}

function restoreSnapshot(snapshot) {
  state.timings = [...snapshot.timings];
  state.activeIndex = Math.min(snapshot.activeIndex, Math.max(0, state.lines.length - 1));
  render();
  scheduleSave();
}

function stampCurrentLine() {
  if (!state.lines.length) return;
  pushUndo();
  state.timings[state.activeIndex] = elements.audioPlayer.currentTime || 0;
  state.activeIndex = Math.min(state.activeIndex + 1, Math.max(0, state.lines.length - 1));
  render();
  scheduleSave();
}

function moveActive(delta) {
  if (!state.lines.length) return;
  state.activeIndex = Math.min(Math.max(state.activeIndex + delta, 0), state.lines.length - 1);
  render();
  scheduleSave();
}

function undo() {
  const snapshot = state.undoStack.pop();
  if (!snapshot) return;
  state.redoStack.push({ timings: [...state.timings], activeIndex: state.activeIndex });
  restoreSnapshot(snapshot);
}

function redo() {
  const snapshot = state.redoStack.pop();
  if (!snapshot) return;
  state.undoStack.push({ timings: [...state.timings], activeIndex: state.activeIndex });
  restoreSnapshot(snapshot);
}

function clearTimings() {
  pushUndo();
  state.timings = [];
  state.activeIndex = 0;
  render();
  scheduleSave();
}

function syncLinesFromInput() {
  const nextLines = parseLines(elements.lyricsInput.value);
  state.lines = nextLines;
  state.timings.length = nextLines.length;
  state.activeIndex = Math.min(state.activeIndex, Math.max(0, nextLines.length - 1));
  render();
  scheduleSave();
}

function render() {
  const activeText = state.lines[state.activeIndex]?.trim();
  elements.currentTime.textContent = formatClock(elements.audioPlayer.currentTime);
  elements.activeLine.textContent = activeText || "歌詞を入力してください";
  elements.outputPreview.value = buildOutput();
  elements.lineCount.textContent = `${state.lines.filter((line) => line.trim()).length}行`;
  elements.undoButton.disabled = state.undoStack.length === 0;
  elements.redoButton.disabled = state.redoStack.length === 0;
}

function scheduleSave() {
  elements.saveStatus.textContent = "保存中...";
  window.clearTimeout(state.saveTimer);
  state.saveTimer = window.setTimeout(saveDraft, 200);
}

function saveDraft() {
  const payload = {
    lyrics: elements.lyricsInput.value,
    timings: state.timings,
    activeIndex: state.activeIndex,
    format: elements.formatSelect.value,
    savedAt: new Date().toISOString(),
  };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    elements.saveStatus.textContent = "一時保存済み";
  } catch {
    elements.saveStatus.textContent = "一時保存できません";
  }
}

function loadDraft() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return;
  try {
    const draft = JSON.parse(raw);
    elements.lyricsInput.value = draft.lyrics || "";
    elements.formatSelect.value = draft.format || "lrc";
    state.lines = parseLines(elements.lyricsInput.value);
    state.timings = Array.isArray(draft.timings) ? draft.timings : [];
    state.activeIndex = Number.isInteger(draft.activeIndex) ? draft.activeIndex : 0;
    elements.saveStatus.textContent = "一時保存を復元";
  } catch {
    elements.saveStatus.textContent = "一時保存の復元に失敗";
  }
}

async function pasteLyrics() {
  if (!navigator.clipboard?.readText) {
    elements.lyricsInput.focus();
    return;
  }
  const text = await navigator.clipboard.readText();
  if (!text) return;
  elements.lyricsInput.value = text;
  syncLinesFromInput();
}

async function copyOutput() {
  const text = elements.outputPreview.value;
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    elements.saveStatus.textContent = "コピー済み";
  } catch {
    elements.outputPreview.focus();
    elements.outputPreview.select();
    elements.saveStatus.textContent = "出力を選択しました";
  }
}

function downloadOutput() {
  const text = elements.outputPreview.value;
  if (!text) return;
  const extension = elements.formatSelect.value === "webvtt" ? "vtt" : elements.formatSelect.value === "srt" ? "srt" : "lrc";
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `lyrics.${extension}`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function togglePlayback() {
  if (elements.audioPlayer.paused) {
    elements.audioPlayer.play().catch(() => {
      elements.saveStatus.textContent = "再生できません";
    });
  } else {
    elements.audioPlayer.pause();
  }
}

function isEditableTarget(target) {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || target?.isContentEditable;
}

function bindEvents() {
  elements.audioFileInput.addEventListener("change", () => {
    const file = elements.audioFileInput.files?.[0];
    if (!file) return;
    if (state.audioUrl) URL.revokeObjectURL(state.audioUrl);
    state.audioUrl = URL.createObjectURL(file);
    elements.audioPlayer.src = state.audioUrl;
    elements.saveStatus.textContent = file.name;
  });

  elements.lyricsInput.addEventListener("input", syncLinesFromInput);
  elements.formatSelect.addEventListener("change", () => {
    render();
    scheduleSave();
  });

  elements.pasteButton.addEventListener("click", pasteLyrics);
  elements.playPauseButton.addEventListener("click", togglePlayback);
  elements.stampButton.addEventListener("click", stampCurrentLine);
  elements.tapZone.addEventListener("click", stampCurrentLine);
  elements.previousButton.addEventListener("click", () => moveActive(-1));
  elements.nextButton.addEventListener("click", () => moveActive(1));
  elements.undoButton.addEventListener("click", undo);
  elements.redoButton.addEventListener("click", redo);
  elements.clearTimingsButton.addEventListener("click", clearTimings);
  elements.copyOutputButton.addEventListener("click", copyOutput);
  elements.downloadButton.addEventListener("click", downloadOutput);
  elements.audioPlayer.addEventListener("timeupdate", render);
  elements.audioPlayer.addEventListener("loadedmetadata", render);

  document.addEventListener("keydown", (event) => {
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

    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
      event.preventDefault();
      undo();
      return;
    }

    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "y") {
      event.preventDefault();
      redo();
    }
  });

  let lastTouchEnd = 0;
  document.addEventListener(
    "touchend",
    (event) => {
      const now = Date.now();
      if (now - lastTouchEnd <= 320) event.preventDefault();
      lastTouchEnd = now;
    },
    { passive: false }
  );
}

loadDraft();
bindEvents();
syncLinesFromInput();
