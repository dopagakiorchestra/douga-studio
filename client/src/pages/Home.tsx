/* Design: Afterglow Console — dark editorial studio, Electric Coral #FF694A, asymmetric left controls / central canvas / right export rail. */
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  AudioLines,
  Check,
  Download,
  FileAudio,
  ImagePlus,
  Library,
  MonitorPlay,
  Music2,
  Pause,
  Play,
  Radio,
  RotateCcw,
  Share2,
  Sparkles,
  Upload,
  Waves,
} from "lucide-react";
import { createRingState, RING_INNER_RATIO, type RingMetrics } from "@/lib/ringVisualizer";
import { drawFrame, RAINBOW } from "@/lib/drawFrame";
import { canExportOffline, exportOffline, measureEncodeSpeed } from "@/lib/offlineExport";

const styles = [
  { id: "bars", label: "Spectrum", icon: Radio, desc: "縦方向のスペクトラム" },
  { id: "wave", label: "Waveform", icon: Waves, desc: "滑らかな波形ライン" },
  { id: "orbit", label: "Orbit", icon: Sparkles, desc: "円形の音の軌道" },
];

/** 書き出し範囲の最短の長さ（秒）。 */
const MIN_CLIP = 1;
/**
 * 一度に書き出せる長さの上限（秒）。
 * MediaRecorder は実時間で録画するので、ここがそのまま待ち時間になる。
 * 長すぎるとチャンクがメモリを圧迫するため上限を設けている。
 */
const MAX_EXPORT_SECONDS = 600;

/**
 * ビジュアライザーのスライダーの範囲。
 * 既定値は max をそのまま使うので、ここを直せば両方に反映される。
 */
const PARAMETERS = {
  sensitivity: { min: 0.1, max: 2.4, step: 0.05 },
  amplitude: { min: 0.25, max: 1.2, step: 0.05 },
  wobble: { min: 0, max: 1, step: 0.02 },
  lineWeight: { min: 0.4, max: 3, step: 0.1 },
} as const;

const SWATCHES = ["#FFFFFF", "#FF694A", "#7CFFCB", "#8FB8FF", "#F5D76E", "#E6A8FF"];
const RAINBOW_SWATCH =
  "conic-gradient(from 0deg, #ff4d4d, #ffd24d, #4dff88, #4ddbff, #6b6bff, #ff4dd2, #ff4d4d)";

function ColorPalette({ value, onChange }: { value: string; onChange: (color: string) => void }) {
  return <div className="color-palette">
    <button aria-label="レインボーを選択" title="時間で色が一周します" className={`color-swatch ${value === RAINBOW ? "active" : ""}`} style={{ background: RAINBOW_SWATCH }} onClick={() => onChange(RAINBOW)} />
    {SWATCHES.map((color) => <button key={color} aria-label={`${color}を選択`} className={`color-swatch ${value === color ? "active" : ""}`} style={{ background: color }} onClick={() => onChange(color)} />)}
    <label className="color-picker"><input type="color" value={value === RAINBOW ? "#FF694A" : value} onChange={(e) => onChange(e.target.value)} /> <span>カスタム</span></label>
  </div>;
}

function formatTime(seconds: number) {
  if (!Number.isFinite(seconds)) return "00:00";
  return `${Math.floor(seconds / 60).toString().padStart(2, "0")}:${Math.floor(seconds % 60).toString().padStart(2, "0")}`;
}

export default function Home() {
  const [audioUrl, setAudioUrl] = useState("");
  const [imageUrl, setImageUrl] = useState("");
  const [audioName, setAudioName] = useState("音源が選択されていません");
  const [title, setTitle] = useState("");
  const [artist, setArtist] = useState("");
  const [genre, setGenre] = useState("Instrumental");
  const [vizColor, setVizColor] = useState(RAINBOW);
  const [outerColor, setOuterColor] = useState("#FFFFFF");
  const [vizStyle, setVizStyle] = useState<"line" | "ring">("line");
  const [sensitivity, setSensitivity] = useState<number>(PARAMETERS.sensitivity.max);
  const [amplitude, setAmplitude] = useState<number>(PARAMETERS.amplitude.max);
  const [wobble, setWobble] = useState<number>(PARAMETERS.wobble.max);
  const [lineWeight, setLineWeight] = useState<number>(PARAMETERS.lineWeight.max);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);
  const [trimStart, setTrimStart] = useState(0);
  const [trimEnd, setTrimEnd] = useState(0);
  // Safari は WebM を録画できないため、iOS では既定を MP4 にする
  const isIOSDevice = typeof navigator !== "undefined" && (/iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1));
  const [format, setFormat] = useState<"webm" | "mp4">(isIOSDevice ? "mp4" : "webm");
  const [aspect, setAspect] = useState<"landscape" | "portrait">("landscape");
    const [exporting, setExporting] = useState(false);
  const [exportRemaining, setExportRemaining] = useState(0);
  const [exportUrl, setExportUrl] = useState("");
  const [exportFilename, setExportFilename] = useState("music-video.webm");
  const [canShareFile, setCanShareFile] = useState(false);
  /** オフライン書き出しの進捗（0〜1）。0 のときは実時間録画。 */
  const [exportProgress, setExportProgress] = useState(0);
  const audioRef = useRef<HTMLAudioElement>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const sourceRef = useRef<MediaElementAudioSourceNode | null>(null);
  const destinationRef = useRef<MediaStreamAudioDestinationNode | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const imageRef = useRef<HTMLInputElement>(null);
  const bgImageRef = useRef<HTMLImageElement | null>(null);
  const ringMetricsRef = useRef<RingMetrics>({ min: 0, max: 0 });
  const ringStateRef = useRef(createRingState());
  const exportUrlRef = useRef<string>("");
  const exportFileRef = useRef<File | null>(null);
  const audioFileRef = useRef<File | null>(null);

  useEffect(() => {
    const stopPlayback = () => { const audio = audioRef.current; if (audio) { audio.pause(); audio.currentTime = 0; } if (audioContextRef.current && audioContextRef.current.state !== "closed") audioContextRef.current.suspend(); setPlaying(false); };
    const handleVisibility = () => { if (document.visibilityState !== "visible") stopPlayback(); };
    document.addEventListener("visibilitychange", handleVisibility);
    window.addEventListener("pagehide", stopPlayback);
    window.addEventListener("beforeunload", stopPlayback);
    return () => { document.removeEventListener("visibilitychange", handleVisibility); window.removeEventListener("pagehide", stopPlayback); window.removeEventListener("beforeunload", stopPlayback); stopPlayback(); };
  }, []);

  // 書き出し範囲。終了が未設定（0）のうちは曲の終わりまでを指す。
  const clipEnd = trimEnd > trimStart ? trimEnd : duration;
  const clipLength = Math.max(0, clipEnd - trimStart);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const tick = () => {
      setProgress(audio.currentTime);
      // 書き出し範囲の終わりで止める。プレビューでも尺を確認できる。
      if (clipEnd > 0 && audio.currentTime >= clipEnd) { audio.pause(); audio.currentTime = trimStart; setPlaying(false); }
    };
    const meta = () => { setDuration(audio.duration); setTrimStart(0); setTrimEnd(audio.duration); };
    const ended = () => setPlaying(false);
    audio.addEventListener("timeupdate", tick);
    audio.addEventListener("loadedmetadata", meta);
    audio.addEventListener("ended", ended);
    return () => { audio.removeEventListener("timeupdate", tick); audio.removeEventListener("loadedmetadata", meta); audio.removeEventListener("ended", ended); };
  }, [audioUrl, trimStart, clipEnd]);

  useEffect(() => { if (!imageUrl) { bgImageRef.current = null; return; } const img = new Image(); img.src = imageUrl; img.onload = () => { bgImageRef.current = img; }; }, [imageUrl]);

  useEffect(() => {
    let frame: number | undefined;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const draw = (time: number) => {
      const rect = canvas.getBoundingClientRect();
      const targetW = aspect === "portrait" ? 1080 : 1920, targetH = aspect === "portrait" ? 1920 : 1080;
      if (canvas.width !== targetW || canvas.height !== targetH) { canvas.width = targetW; canvas.height = targetH; }
      const analyser = analyserRef.current;
      const fft = analyser ? new Uint8Array(analyser.frequencyBinCount) : null;
      const timeData = analyser ? new Uint8Array(analyser.fftSize) : null;
      if (analyser && fft && timeData) { analyser.getByteFrequencyData(fft); analyser.getByteTimeDomainData(timeData); }
      // 高さは表示boxではなくキャンバスから決める。9:16 では max-height が
      // 効いて表示boxの縦横比がキャンバスと変わるため、表示boxの高さを
      // そのまま使うと描画がキャンバスの中心からずれる。
      const scale = canvas.width / rect.width;
      const metrics = drawFrame(ctx, {
        width: rect.width,
        height: canvas.height / scale,
        scale,
        fft,
        wave: timeData,
        playing,
        time,
        style: vizStyle,
        vizColor,
        outerColor,
        sensitivity,
        amplitude,
        wobble,
        lineWeight,
        background: bgImageRef.current,
        title,
        artist,
        ringState: ringStateRef.current,
      });
      if (metrics) ringMetricsRef.current = metrics;
      if (playing) frame = window.setTimeout(() => draw(performance.now()), 33);
    };
    draw(performance.now());
    return () => { if (frame !== undefined) window.clearTimeout(frame); };
  }, [playing, imageUrl, title, artist, aspect, vizColor, outerColor, vizStyle, sensitivity, amplitude, wobble, lineWeight]);

  const handleAudio = (file?: File) => {
    if (!file) return;
    if (!file.type.includes("audio")) { toast.error("MP3またはWAVファイルを選択してください"); return; }
    audioFileRef.current = file; setAudioName(file.name); setAudioUrl(URL.createObjectURL(file)); toast.success("音源を読み込みました");
  };
  const handleImage = (file?: File) => { if (!file) return; setImageUrl(URL.createObjectURL(file)); toast.success("アートワークを設定しました"); };
  const togglePlay = async () => { const audio = audioRef.current; if (!audioUrl || !audio) { toast.info("まず音源をアップロードしてください"); return; } if (!audioContextRef.current) { const AudioCtx = window.AudioContext || (window as typeof window & { webkitAudioContext: typeof AudioContext }).webkitAudioContext; const ctx = new AudioCtx(); const analyser = ctx.createAnalyser(); analyser.fftSize = 256; analyser.smoothingTimeConstant = .5; analyser.minDecibels = -78; analyser.maxDecibels = -12; const destination = ctx.createMediaStreamDestination(); const source = ctx.createMediaElementSource(audio); source.connect(analyser); analyser.connect(ctx.destination); analyser.connect(destination); audioContextRef.current = ctx; analyserRef.current = analyser; sourceRef.current = source; destinationRef.current = destination; } if (audioContextRef.current.state === "suspended") await audioContextRef.current.resume(); if (playing) { audio.pause(); setPlaying(false); } else { if (audio.currentTime < trimStart || audio.currentTime >= clipEnd) audio.currentTime = trimStart; await audio.play(); setPlaying(true); } };
  const reset = () => { audioFileRef.current = null; setAudioUrl(""); setImageUrl(""); setAudioName("音源が選択されていません"); setProgress(0); setDuration(0); setTrimStart(0); setTrimEnd(0); setPlaying(false); toast.info("キャンバスをリセットしました"); };

  /** 書き出し前に、リングのグローと帯域の反応がちゃんと出ているかを確かめる。 */
  const validateRingFrame = () => {
    const canvas = canvasRef.current;
    if (!canvas || vizStyle !== "ring") return true;
    const ctx = canvas.getContext("2d");
    if (!ctx) return false;
    const cx = canvas.width / 2, cy = canvas.height / 2;
    const innerR = Math.min(canvas.width, canvas.height) * RING_INNER_RATIO;
    const image = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    const samplePixel = (x: number, y: number) => { const ix = Math.max(0, Math.min(canvas.width - 1, Math.round(x))), iy = Math.max(0, Math.min(canvas.height - 1, Math.round(y))), p = (iy * canvas.width + ix) * 4; return [image[p] / 255, image[p + 1] / 255, image[p + 2] / 255]; };
    // 色は選べるようになったので彩度では判定しない。
    // 芯が描かれていること（明るさ）と、その外へグローが漏れていることを見る。
    let litCore = false, glowOutside = false;
    for (let i = 0; i < 180 && !(litCore && glowOutside); i++) {
      const angle = (i / 180) * Math.PI * 2;
      const cos = Math.cos(angle), sin = Math.sin(angle);
      // 半径は音で ±数% 揺れるので、リング付近を少し幅を持たせて探す
      for (let offset = -0.08; offset <= 0.081 && !litCore; offset += 0.02) {
        const r = innerR * (1 + offset);
        const color = samplePixel(cx + cos * r, cy + sin * r);
        if (Math.max(...color) > .35) litCore = true;
      }
      const glow = samplePixel(cx + cos * (innerR * 1.35), cy + sin * (innerR * 1.35));
      if (glow[0] + glow[1] + glow[2] > .015) glowOutside = true;
    }
    // FFT が実際に届いているか（全周が無反応でないか）を確認する。
    // 帯域が均一な曲もあるため、強弱の比ではなくピークの有無で判定する。
    const responsive = ringMetricsRef.current.max >= .25;
    return litCore && glowOutside && responsive;
  };

  /** 書き出した Blob を保存できる状態にする。 */
  const publishResult = (blob: Blob, extension: string) => {
    const filename = `${title || "music-video"}.${extension}`;
    if (exportUrlRef.current) URL.revokeObjectURL(exportUrlRef.current);
    exportUrlRef.current = URL.createObjectURL(blob);
    const file = new File([blob], filename, { type: blob.type });
    exportFileRef.current = file;
    setCanShareFile(typeof navigator.canShare === "function" && navigator.canShare({ files: [file] }));
    setExportUrl(exportUrlRef.current);
    setExportFilename(filename);
    setExporting(false);
    toast.success("動画を書き出しました。ダウンロードボタンから保存できます");
  };

  /** iOS の「ビデオを保存」「ファイルに保存」はここから辿れる。 */
  const shareVideo = async () => {
    const file = exportFileRef.current;
    if (!file) return;
    try {
      await navigator.share({ files: [file], title: title || "music-video" });
    } catch (error) {
      if ((error as Error).name !== "AbortError") toast.error("共有シートを開けませんでした");
    }
  };

  /**
   * WebCodecs で実時間より速く書き出す。
   * 対応していない環境や失敗時は false を返し、実時間録画へ任せる。
   */
  const exportWithCodecs = async (seconds: number) => {
    const canvas = canvasRef.current;
    const file = audioFileRef.current;
    if (!canvas || !file) return false;
    const width = canvas.width, height = canvas.height;
    if (!(await canExportOffline(format, width, height))) return false;
    const logicalWidth = canvas.getBoundingClientRect().width || width / 2;
    const scale = width / logicalWidth;
    // この端末で本当に速いか実測する。ハードウェアエンコーダが無いと、
    // グローの多いこの映像は実時間録画より遅くなることがある。
    const ringState = createRingState();
    const probeFft = new Uint8Array(128).map((_, i) => Math.max(0, 230 - i * 1.4));
    const probeWave = new Uint8Array(256).map((_, i) => 128 + Math.round(Math.sin(i / 2.5) * 70));
    const msPerFrame = await measureEncodeSpeed(format, width, height, (probeCtx, index) => {
      drawFrame(probeCtx, {
        width: logicalWidth, height: height / scale, scale,
        fft: probeFft, wave: probeWave, playing: true, time: index * 33,
        style: vizStyle, vizColor, outerColor, sensitivity, amplitude, wobble, lineWeight,
        background: bgImageRef.current, title, artist, ringState,
      });
    });
    if (msPerFrame > 1000 / 30) return false;
    setExporting(true);
    setExportProgress(0);
    try {
      const blob = await exportOffline({
        audioData: await file.arrayBuffer(),
        startSeconds: trimStart,
        durationSeconds: seconds,
        width,
        height,
        // プレビューと同じ論理幅で描くと見た目が一致する
        logicalWidth,
        fps: 30,
        format,
        frame: {
          style: vizStyle,
          vizColor,
          outerColor,
          sensitivity,
          amplitude,
          wobble,
          lineWeight,
          background: bgImageRef.current,
          title,
          artist,
        },
        onProgress: setExportProgress,
      });
      publishResult(blob, format);
      return true;
    } catch (error) {
      console.error(error);
      toast.warning("高速書き出しに失敗したため、通常の録画で書き出します");
      setExporting(false);
      return false;
    } finally {
      setExportProgress(0);
    }
  };

  const exportVideo = async () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (!audioUrl) { toast.info("音源をアップロードすると書き出せます"); return; }
    const seconds = Math.min(clipLength || audioRef.current?.duration || 12, MAX_EXPORT_SECONDS);
    if (await exportWithCodecs(seconds)) return;
    // Safari は WebM を、一部の Chromium は MP4 を録画できない。
    // 選んだ形式が使えなければ、黙って落とさずもう一方へ切り替える。
    const pickMime = (kind: "webm" | "mp4") =>
      (kind === "mp4" ? ["video/mp4;codecs=avc1", "video/mp4"] : ["video/webm;codecs=vp9", "video/webm"])
        .find((candidate) => MediaRecorder.isTypeSupported(candidate));
    const mime = pickMime(format) ?? pickMime(format === "mp4" ? "webm" : "mp4");
    if (!mime) { toast.error("このブラウザは動画の書き出しに対応していません"); return; }
    if (!pickMime(format)) { toast.warning(`このブラウザは${format.toUpperCase()}に対応していないため、${mime.includes("mp4") ? "MP4" : "WebM"}で書き出します`); }
    setExporting(true);
    const videoStream = canvas.captureStream(30);
    const tracks = [...videoStream.getVideoTracks(), ...(destinationRef.current?.stream.getAudioTracks() || [])];
    const stream = new MediaStream(tracks);
    const recorder = new MediaRecorder(stream, { mimeType: mime });
    const chunks: Blob[] = []; recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    const audio = audioRef.current;
    const requested = clipLength || audio?.duration || 12;
    // 上限に当たったら黙って切り捨てず、そのことを伝える
    if (requested > MAX_EXPORT_SECONDS) {
      toast.warning(`書き出しは${formatTime(MAX_EXPORT_SECONDS)}までです。範囲を絞ると全体を書き出せます`);
    }
    const stopAfter = Math.min(requested, MAX_EXPORT_SECONDS) * 1000;
    const startedAt = performance.now();
    const remainingTimer = window.setInterval(() => { setExportRemaining(Math.max(0, Math.ceil((stopAfter - (performance.now() - startedAt)) / 1000))); }, 250);
    recorder.onstop = () => {
      window.clearInterval(remainingTimer);
      setExportRemaining(0);
      publishResult(new Blob(chunks, { type: mime }), mime.includes("mp4") ? "mp4" : "webm");
    };
    if (audio) { audio.currentTime = trimStart; await audio.play(); setPlaying(true); }
    if (vizStyle === "ring") { await new Promise((resolve) => window.setTimeout(resolve, 400)); if (!validateRingFrame()) { audio?.pause(); setPlaying(false); setExporting(false); toast.error("出力前チェック未達: グローまたは全周トゲの反応を確認してください"); return; } }
    recorder.start(250);
    window.setTimeout(() => { if (recorder.state !== "inactive") recorder.stop(); audio?.pause(); setPlaying(false); }, stopAfter);
  };

  return <div className="studio-shell">
    <header className="topbar"><div className="brand"><div className="brand-mark"><AudioLines size={19} /></div><div><div className="brand-name">sonic canvas</div><div className="brand-sub">music video maker</div></div></div><div className="top-status"><span className="status-dot" /> LOCAL SESSION <span className="slash">/</span> 01</div><button className="reset-button" onClick={reset}><RotateCcw size={14} /> リセット</button></header>
    <div className="signal-line"><span style={{ width: audioUrl ? "66%" : "18%" }} /></div>
    <main className="workspace">
      <aside className="left-rail">
        <div className="rail-kicker">01 / SOURCE</div>
        <section className="panel-section"><div className="section-label"><FileAudio size={14} /> 音源</div><button className="upload-zone" onClick={() => fileRef.current?.click()}><Upload size={19} /><strong>{audioUrl ? "音源を変更" : "MP3 / WAV を追加"}</strong><span>{audioName}</span></button><input ref={fileRef} hidden type="file" accept="audio/mpeg,audio/wav,audio/x-wav" onChange={(e) => handleAudio(e.target.files?.[0])} />{audioUrl && <div className="file-state"><Check size={13} /> 読み込み済み <span>44.1 kHz</span></div>}</section>
        <section className="panel-section"><div className="section-label"><ImagePlus size={14} /> アートワーク <em>任意</em></div><button className="image-zone" onClick={() => imageRef.current?.click()}>{imageUrl ? <img src={imageUrl} alt="アップロードしたアートワーク" /> : <><ImagePlus size={18} /><span>画像を追加</span><small>JPG / PNG</small></>}</button><input ref={imageRef} hidden type="file" accept="image/*" onChange={(e) => handleImage(e.target.files?.[0])} /><button className="text-link" onClick={() => setImageUrl("")}>デフォルト背景を使用</button></section>
        <section className="panel-section"><div className="section-label"><Library size={14} /> 情報</div><label>曲名<input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="曲名を入力" /></label><label>アーティスト名<input value={artist} onChange={(e) => setArtist(e.target.value)} placeholder="アーティスト名を入力" /></label><label>ジャンル<input value={genre} onChange={(e) => setGenre(e.target.value)} placeholder="Instrumental" /></label></section>
      </aside>
      <section className="preview-stage"><div className="stage-head"><div><div className="rail-kicker">02 / PREVIEW</div><h1>音を置く。画を決める。</h1></div><div className="stage-meta"><span className="live-dot" /> LIVE CANVAS<br /><small>{aspect === "portrait" ? "1080 × 1920" : "1920 × 1080"}</small></div></div><div className={`canvas-wrap ${vizStyle === "ring" ? "ring-preview" : ""}`}><canvas ref={canvasRef} /></div><div className="transport"><button className="play-button" onClick={togglePlay}>{playing ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" />}</button><div className="transport-track">{duration > 0 && <div className="transport-range" style={{ left: `${(trimStart / duration) * 100}%`, width: `${(clipLength / duration) * 100}%` }} />}<div className="transport-progress" style={{ width: `${duration ? (progress / duration) * 100 : 0}%` }} /><input type="range" min="0" max={duration || 1} value={progress} onChange={(e) => { const value = Number(e.target.value); setProgress(value); if (audioRef.current) audioRef.current.currentTime = value; }} /></div><span className="timecode">{formatTime(progress)} <i>/</i> {formatTime(duration)}</span><audio ref={audioRef} src={audioUrl} /></div>{duration > 0 && <div className="trim-panel"><div className="trim-head"><span>書き出し範囲</span><b>{formatTime(trimStart)} → {formatTime(clipEnd)}</b><em>{formatTime(Math.round(clipLength))}</em></div><label>開始<input type="range" min={0} max={duration} step={0.1} value={trimStart} onChange={(e) => { const value = Math.min(Number(e.target.value), clipEnd - MIN_CLIP); setTrimStart(Math.max(0, value)); if (audioRef.current && audioRef.current.currentTime < value) audioRef.current.currentTime = value; }} /></label><label>終了<input type="range" min={0} max={duration} step={0.1} value={clipEnd} onChange={(e) => setTrimEnd(Math.min(duration, Math.max(Number(e.target.value), trimStart + MIN_CLIP)))} /></label></div>}<div className="preview-caption"><span>{aspect === "portrait" ? "ショート / 1080 × 1920" : "フルHD / 1920 × 1080"} · BLACK BACKGROUND</span><span>{genre || "Instrumental"} <b>·</b> {audioName !== "音源が選択されていません" ? audioName : "no source"}</span></div></section>
      <aside className="right-rail"><div className="rail-kicker">03 / VISUALIZER</div><section className="panel-section"><div className="section-title">出力サイズ</div><div className="format-row size-row"><button className={aspect === "landscape" ? "active" : ""} onClick={() => setAspect("landscape")}>16:9 <small>フルHD</small></button><button className={aspect === "portrait" ? "active" : ""} onClick={() => setAspect("portrait")}>9:16 <small>ショート</small></button></div><div className="section-title">ビジュアライザー</div><div className="viz-style-switch"><button className={`viz-style-option ${vizStyle === "line" ? "selected" : ""}`} onClick={() => setVizStyle("line")}><Waves size={18} /><span>横線</span><small>穏やかな波形</small>{vizStyle === "line" && <Check size={14} />}</button><button className={`viz-style-option ${vizStyle === "ring" ? "selected" : ""}`} onClick={() => setVizStyle("ring")}><Radio size={18} /><span>二重円リング</span><small>放射状スペクトラム</small>{vizStyle === "ring" && <Check size={14} />}</button></div></section><section className="panel-section"><div className="section-title">{vizStyle === "ring" ? "内側リングの色" : "ラインの色"}</div><ColorPalette value={vizColor} onChange={setVizColor} />{vizStyle === "ring" && <><div className="section-title palette-gap">外側リングの色</div><ColorPalette value={outerColor} onChange={setOuterColor} /></>}<div className="fft-note"><AudioLines size={13} /> HIGH SENSITIVITY · 256 BAND FFT</div><div className="parameter-stack"><label>感度 <output>{sensitivity.toFixed(2)}</output><input type="range" min={PARAMETERS.sensitivity.min} max={PARAMETERS.sensitivity.max} step={PARAMETERS.sensitivity.step} value={sensitivity} onChange={(e) => setSensitivity(Number(e.target.value))} /></label><label>振幅の大きさ <output>{Math.round(amplitude * 100)}%</output><input type="range" min={PARAMETERS.amplitude.min} max={PARAMETERS.amplitude.max} step={PARAMETERS.amplitude.step} value={amplitude} onChange={(e) => setAmplitude(Number(e.target.value))} /></label><label>うねりの強さ <output>{Math.round(wobble * 100)}%</output><input type="range" min={PARAMETERS.wobble.min} max={PARAMETERS.wobble.max} step={PARAMETERS.wobble.step} value={wobble} onChange={(e) => setWobble(Number(e.target.value))} /></label><label>線の太さ <output>{lineWeight.toFixed(1)}px</output><input type="range" min={PARAMETERS.lineWeight.min} max={PARAMETERS.lineWeight.max} step={PARAMETERS.lineWeight.step} value={lineWeight} onChange={(e) => setLineWeight(Number(e.target.value))} /></label></div></section><div className="export-card"><div className="export-orbit"><MonitorPlay size={22} /></div><div className="rail-kicker">EXPORT READY</div><h2>映像を書き出す</h2><p>音声とビジュアライザーを一枚の動画にまとめます。</p><div className="format-row"><button className={format === "webm" ? "active" : ""} onClick={() => setFormat("webm")}>WebM <small>推奨</small></button><button className={format === "mp4" ? "active" : ""} onClick={() => setFormat("mp4")}>MP4</button></div><button className="export-button" onClick={exportVideo} disabled={exporting}>{exporting ? <><span className="spinner" /> 書き出し中… {exportProgress > 0 ? `${Math.round(exportProgress * 100)}%` : `残り ${formatTime(exportRemaining)}`}</> : <><Download size={17} /> {format.toUpperCase()} を書き出す</>}</button><div className="export-note"><span className="status-dot" /> ブラウザ内で処理 · ファイルは保存されません</div>{clipLength > 0 && !exporting && <div className="export-note">録画は実時間です · 所要 約{formatTime(Math.min(Math.round(clipLength), MAX_EXPORT_SECONDS))}</div>}{exportUrl && <div className="export-result"><video className="export-video-preview" src={exportUrl} controls playsInline preload="metadata" /><p>{isIOSDevice ? "「共有して保存」から「ビデオを保存」または「\"ファイル\"に保存」を選べます" : "プレビューを確認してダウンロードできます"}</p>{canShareFile && <button className="export-share-button" onClick={shareVideo}><Share2 size={14} /> 共有して保存</button>}<a className="export-download-link" href={exportUrl} download={exportFilename}><Download size={14} /> 動画をダウンロード</a></div>}</div><div className="shortcut-note"><Music2 size={15} /><span>ヒント<br /><b>音源を選んで、再生しながらスタイルを試してみましょう。</b></span></div></aside>
    </main>
  </div>;
}
