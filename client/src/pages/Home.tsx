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
  Sparkles,
  Upload,
  Waves,
} from "lucide-react";
import { drawRing, RING_INNER_RATIO, type RingMetrics } from "@/lib/ringVisualizer";

const styles = [
  { id: "bars", label: "Spectrum", icon: Radio, desc: "縦方向のスペクトラム" },
  { id: "wave", label: "Waveform", icon: Waves, desc: "滑らかな波形ライン" },
  { id: "orbit", label: "Orbit", icon: Sparkles, desc: "円形の音の軌道" },
];

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
  const [vizColor, setVizColor] = useState("#FF694A");
  const [vizStyle, setVizStyle] = useState<"line" | "ring">("line");
  const [sensitivity, setSensitivity] = useState(1.15);
  const [amplitude, setAmplitude] = useState(0.34);
  const [wobble, setWobble] = useState(0.08);
  const [lineWeight, setLineWeight] = useState(0.8);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);
  const [format, setFormat] = useState<"webm" | "mp4">("webm");
  const [aspect, setAspect] = useState<"landscape" | "portrait">("landscape");
    const [exporting, setExporting] = useState(false);
  const [exportRemaining, setExportRemaining] = useState(0);
  const [exportUrl, setExportUrl] = useState("");
  const [exportFilename, setExportFilename] = useState("music-video.webm");
  const isIOSDevice = typeof navigator !== "undefined" && (/iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1));
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

  useEffect(() => {
    const stopPlayback = () => { const audio = audioRef.current; if (audio) { audio.pause(); audio.currentTime = 0; } if (audioContextRef.current && audioContextRef.current.state !== "closed") audioContextRef.current.suspend(); setPlaying(false); };
    const handleVisibility = () => { if (document.visibilityState !== "visible") stopPlayback(); };
    document.addEventListener("visibilitychange", handleVisibility);
    window.addEventListener("pagehide", stopPlayback);
    window.addEventListener("beforeunload", stopPlayback);
    return () => { document.removeEventListener("visibilitychange", handleVisibility); window.removeEventListener("pagehide", stopPlayback); window.removeEventListener("beforeunload", stopPlayback); stopPlayback(); };
  }, []);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const tick = () => setProgress(audio.currentTime);
    const ended = () => setPlaying(false);
    audio.addEventListener("timeupdate", tick);
    audio.addEventListener("loadedmetadata", () => setDuration(audio.duration));
    audio.addEventListener("ended", ended);
    return () => { audio.removeEventListener("timeupdate", tick); audio.removeEventListener("ended", ended); };
  }, [audioUrl]);

  useEffect(() => { if (!imageUrl) { bgImageRef.current = null; return; } const img = new Image(); img.src = imageUrl; img.onload = () => { bgImageRef.current = img; }; }, [imageUrl]);

  useEffect(() => {
    let frame: number | undefined;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const draw = (time: number) => {
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      const targetW = aspect === "portrait" ? 1080 : 1920, targetH = aspect === "portrait" ? 1920 : 1080;
      if (canvas.width !== targetW || canvas.height !== targetH) { canvas.width = targetW; canvas.height = targetH; }
      ctx.setTransform(canvas.width / rect.width, 0, 0, canvas.height / rect.height, 0, 0);
      const w = rect.width, h = rect.height;
      ctx.clearRect(0, 0, w, h);
      const grad = ctx.createLinearGradient(0, 0, w, h);
      grad.addColorStop(0, "#000000"); grad.addColorStop(1, "#050505"); ctx.fillStyle = grad; ctx.fillRect(0, 0, w, h);
      const fft = analyserRef.current ? new Uint8Array(analyserRef.current.frequencyBinCount) : null;
      const timeData = analyserRef.current ? new Uint8Array(analyserRef.current.fftSize) : null;
      analyserRef.current?.getByteFrequencyData(fft!);
      analyserRef.current?.getByteTimeDomainData(timeData!);
      const bass = fft ? fft.slice(0, 12).reduce((a, b) => a + b, 0) / (12 * 255) : .18;
      const treble = fft ? fft.slice(40, 90).reduce((a, b) => a + b, 0) / (50 * 255) : .2;
      if (bgImageRef.current) { ctx.globalAlpha = .72; ctx.drawImage(bgImageRef.current, 0, 0, w, h); ctx.fillStyle = "rgba(0,0,0,.28)"; ctx.fillRect(0, 0, w, h); ctx.globalAlpha = 1; }
      const accent = vizColor;
      ctx.shadowColor = accent; ctx.shadowBlur = 20; ctx.strokeStyle = accent; ctx.fillStyle = accent; ctx.lineWidth = 2;
      if (vizStyle === "line") {
        ctx.beginPath();
        for (let x = 24; x <= w - 24; x += 3) {
          const index = Math.min(Math.floor(((x - 24) / (w - 48)) * ((timeData?.length || 256) - 1)), (timeData?.length || 256) - 1);
          const local = timeData ? (timeData[index] - 128) / 128 : 0;
          const ripple = Math.sin(x * .035 + time / 230) * wobble * (2 + treble * 9);
          const y = h / 2 + ripple + (playing ? local * h * amplitude * sensitivity : Math.sin(x * .025) * 3);
          x === 24 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        }
        ctx.lineWidth = Math.max(.45, lineWeight + bass * .8 + (playing ? Math.abs(Math.sin(time / 100)) * .3 : 0));
        ctx.stroke();
        ctx.globalAlpha = .2; ctx.lineWidth = 1; ctx.beginPath();
        for (let x = 24; x <= w - 24; x += 3) { const index = Math.min(Math.floor(((x - 24) / (w - 48)) * ((timeData?.length || 256) - 1)), (timeData?.length || 256) - 1); const local = timeData ? (timeData[index] - 128) / 128 : 0; const y = h / 2 - (playing ? local * h * amplitude * sensitivity * .62 : 0) + Math.sin(x * .03 + time / 280) * 2; x === 24 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); }
        ctx.stroke(); ctx.globalAlpha = 1;
      } else {
        ringMetricsRef.current = drawRing(ctx, {
          width: w,
          height: h,
          glowScale: canvas.width / rect.width,
          fft,
          wave: timeData,
          playing,
          time,
          sensitivity,
        });
      }
      ctx.shadowBlur = 0;
      const cleanTitle = title.trim(), cleanArtist = artist.trim();
      if (cleanTitle || cleanArtist) { ctx.textAlign = "center"; ctx.textBaseline = "middle"; if (cleanTitle) { ctx.fillStyle = "rgba(255,255,255,.92)"; ctx.font = "600 16px 'Space Grotesk', sans-serif"; ctx.fillText(cleanTitle, w / 2, h - (cleanArtist ? 46 : 28)); } if (cleanArtist) { ctx.fillStyle = "rgba(255,255,255,.58)"; ctx.font = "12px 'IBM Plex Mono', monospace"; ctx.fillText(cleanArtist, w / 2, h - 22); } ctx.textAlign = "start"; }
      if (playing) frame = window.setTimeout(() => draw(performance.now()), 33);
    };
    draw(performance.now());
    return () => { if (frame !== undefined) window.clearTimeout(frame); };
  }, [playing, imageUrl, title, artist, aspect, vizColor, vizStyle, sensitivity, amplitude, wobble, lineWeight]);

  const handleAudio = (file?: File) => {
    if (!file) return;
    if (!file.type.includes("audio")) { toast.error("MP3またはWAVファイルを選択してください"); return; }
    setAudioName(file.name); setAudioUrl(URL.createObjectURL(file)); toast.success("音源を読み込みました");
  };
  const handleImage = (file?: File) => { if (!file) return; setImageUrl(URL.createObjectURL(file)); toast.success("アートワークを設定しました"); };
  const togglePlay = async () => { const audio = audioRef.current; if (!audioUrl || !audio) { toast.info("まず音源をアップロードしてください"); return; } if (!audioContextRef.current) { const AudioCtx = window.AudioContext || (window as typeof window & { webkitAudioContext: typeof AudioContext }).webkitAudioContext; const ctx = new AudioCtx(); const analyser = ctx.createAnalyser(); analyser.fftSize = 256; analyser.smoothingTimeConstant = .55; const destination = ctx.createMediaStreamDestination(); const source = ctx.createMediaElementSource(audio); source.connect(analyser); analyser.connect(ctx.destination); analyser.connect(destination); audioContextRef.current = ctx; analyserRef.current = analyser; sourceRef.current = source; destinationRef.current = destination; } if (audioContextRef.current.state === "suspended") await audioContextRef.current.resume(); if (playing) { audio.pause(); setPlaying(false); } else { await audio.play(); setPlaying(true); } };
  const reset = () => { setAudioUrl(""); setImageUrl(""); setAudioName("音源が選択されていません"); setProgress(0); setDuration(0); setPlaying(false); toast.info("キャンバスをリセットしました"); };

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
    let saturated = false, glowOutside = false;
    for (let i = 0; i < 180 && !(saturated && glowOutside); i++) {
      const angle = (i / 180) * Math.PI * 2;
      const cos = Math.cos(angle), sin = Math.sin(angle);
      // 半径は音で ±数% 揺れるので、リング付近を少し幅を持たせて探す
      for (let offset = -0.08; offset <= 0.081 && !saturated; offset += 0.02) {
        const r = innerR * (1 + offset);
        const color = samplePixel(cx + cos * r, cy + sin * r);
        const max = Math.max(...color), min = Math.min(...color);
        if (max - min >= .25 && max > .25) saturated = true;
      }
      const glow = samplePixel(cx + cos * (innerR + 40), cy + sin * (innerR + 40));
      if (glow[0] + glow[1] + glow[2] > .015) glowOutside = true;
    }
    // FFT が実際に届いているか（全周が無反応でないか）を確認する。
    // 帯域が均一な曲もあるため、強弱の比ではなくピークの有無で判定する。
    const responsive = ringMetricsRef.current.max >= .25;
    return saturated && glowOutside && responsive;
  };

  const exportVideo = async () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (!audioUrl) { toast.info("音源をアップロードすると書き出せます"); return; }
    if (format === "mp4" && !MediaRecorder.isTypeSupported("video/mp4")) { toast.warning("このブラウザはMP4書き出しに対応していないため、WebMで書き出します"); }
    setExporting(true);
    const videoStream = canvas.captureStream(30);
    const tracks = [...videoStream.getVideoTracks(), ...(destinationRef.current?.stream.getAudioTracks() || [])];
    const stream = new MediaStream(tracks);
    const mimeCandidates = format === "mp4" ? ["video/mp4;codecs=avc1", "video/mp4"] : ["video/webm;codecs=vp9", "video/webm"];
    const mime = mimeCandidates.find((candidate) => MediaRecorder.isTypeSupported(candidate));
    if (!mime) { setExporting(false); toast.error(`${format.toUpperCase()}の書き出しはこのブラウザに対応していません。SafariではWebMをお試しください。`); return; }
    const recorder = new MediaRecorder(stream, { mimeType: mime });
    const chunks: Blob[] = []; recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    const audio = audioRef.current;
    const stopAfter = Math.min((audio?.duration || 12) * 1000, 120000);
    const startedAt = performance.now();
    const remainingTimer = window.setInterval(() => { setExportRemaining(Math.max(0, Math.ceil((stopAfter - (performance.now() - startedAt)) / 1000))); }, 250);
    recorder.onstop = () => { window.clearInterval(remainingTimer); setExportRemaining(0); const blob = new Blob(chunks, { type: mime }); const extension = mime.includes("mp4") ? "mp4" : "webm"; const filename = `${title || "music-video"}.${extension}`; const objectUrl = URL.createObjectURL(blob); const finish = (url: string) => { setExportUrl(url); setExportFilename(filename); setExporting(false); toast.success("動画を書き出しました。ダウンロードボタンから保存できます"); }; if (isIOSDevice) { const reader = new FileReader(); reader.onloadend = () => finish(typeof reader.result === "string" ? reader.result : objectUrl); reader.readAsDataURL(blob); } else { finish(objectUrl); } };
    if (audio) { audio.currentTime = 0; await audio.play(); setPlaying(true); }
    if (vizStyle === "ring") { await new Promise((resolve) => window.setTimeout(resolve, 120)); if (!validateRingFrame()) { audio?.pause(); setPlaying(false); setExporting(false); toast.error("出力前チェック未達: グローまたは全周トゲの反応を確認してください"); return; } }
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
      <section className="preview-stage"><div className="stage-head"><div><div className="rail-kicker">02 / PREVIEW</div><h1>音を置く。画を決める。</h1></div><div className="stage-meta"><span className="live-dot" /> LIVE CANVAS<br /><small>{aspect === "portrait" ? "1080 × 1920" : "1920 × 1080"}</small></div></div><div className={`canvas-wrap ${vizStyle === "ring" ? "ring-preview" : ""}`}><canvas ref={canvasRef} /></div><div className="transport"><button className="play-button" onClick={togglePlay}>{playing ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" />}</button><div className="transport-track"><div className="transport-progress" style={{ width: `${duration ? (progress / duration) * 100 : 0}%` }} /><input type="range" min="0" max={duration || 1} value={progress} onChange={(e) => { const value = Number(e.target.value); setProgress(value); if (audioRef.current) audioRef.current.currentTime = value; }} /></div><span className="timecode">{formatTime(progress)} <i>/</i> {formatTime(duration)}</span><audio ref={audioRef} src={audioUrl} /></div><div className="preview-caption"><span>{aspect === "portrait" ? "ショート / 1080 × 1920" : "フルHD / 1920 × 1080"} · BLACK BACKGROUND</span><span>{genre || "Instrumental"} <b>·</b> {audioName !== "音源が選択されていません" ? audioName : "no source"}</span></div></section>
      <aside className="right-rail"><div className="rail-kicker">03 / VISUALIZER</div><section className="panel-section"><div className="section-title">出力サイズ</div><div className="format-row size-row"><button className={aspect === "landscape" ? "active" : ""} onClick={() => setAspect("landscape")}>16:9 <small>フルHD</small></button><button className={aspect === "portrait" ? "active" : ""} onClick={() => setAspect("portrait")}>9:16 <small>ショート</small></button></div><div className="section-title">ビジュアライザー</div><div className="viz-style-switch"><button className={`viz-style-option ${vizStyle === "line" ? "selected" : ""}`} onClick={() => setVizStyle("line")}><Waves size={18} /><span>横線</span><small>穏やかな波形</small>{vizStyle === "line" && <Check size={14} />}</button><button className={`viz-style-option ${vizStyle === "ring" ? "selected" : ""}`} onClick={() => setVizStyle("ring")}><Radio size={18} /><span>二重円リング</span><small>放射状スペクトラム</small>{vizStyle === "ring" && <Check size={14} />}</button></div></section><section className="panel-section"><div className="section-title">ビジュアライザーの色</div><div className="color-palette">{["#FF694A","#7CFFCB","#8FB8FF","#F5D76E","#E6A8FF"].map((color) => <button key={color} aria-label={`${color}を選択`} className={`color-swatch ${vizColor === color ? "active" : ""}`} style={{ background: color }} onClick={() => setVizColor(color)} />)}<label className="color-picker"><input type="color" value={vizColor} onChange={(e) => setVizColor(e.target.value)} /> <span>カスタム</span></label></div><div className="fft-note"><AudioLines size={13} /> HIGH SENSITIVITY · 256 BAND FFT</div><div className="parameter-stack"><label>感度 <output>{sensitivity.toFixed(2)}</output><input type="range" min="0.1" max="2.4" step="0.05" value={sensitivity} onChange={(e) => setSensitivity(Number(e.target.value))} /></label><label>振幅の大きさ <output>{Math.round(amplitude * 100)}%</output><input type="range" min="0.25" max="1.2" step="0.05" value={amplitude} onChange={(e) => setAmplitude(Number(e.target.value))} /></label><label>うねりの強さ <output>{Math.round(wobble * 100)}%</output><input type="range" min="0" max="1" step="0.02" value={wobble} onChange={(e) => setWobble(Number(e.target.value))} /></label><label>線の太さ <output>{lineWeight.toFixed(1)}px</output><input type="range" min="0.4" max="3" step="0.1" value={lineWeight} onChange={(e) => setLineWeight(Number(e.target.value))} /></label></div></section><div className="export-card"><div className="export-orbit"><MonitorPlay size={22} /></div><div className="rail-kicker">EXPORT READY</div><h2>映像を書き出す</h2><p>音声とビジュアライザーを一枚の動画にまとめます。</p><div className="format-row"><button className={format === "webm" ? "active" : ""} onClick={() => setFormat("webm")}>WebM <small>推奨</small></button><button className={format === "mp4" ? "active" : ""} onClick={() => setFormat("mp4")}>MP4</button></div><button className="export-button" onClick={exportVideo} disabled={exporting}>{exporting ? <><span className="spinner" /> 書き出し中… 残り約 {exportRemaining}秒</> : <><Download size={17} /> {format.toUpperCase()} を書き出す</>}</button><div className="export-note"><span className="status-dot" /> ブラウザ内で処理 · ファイルは保存されません</div>{exportUrl && <div className="export-result"><video className="export-video-preview" src={exportUrl} controls playsInline preload="metadata" /><p>{isIOSDevice ? "ダウンロードボタンで保存できない場合は、動画を画面録画してください" : "プレビューを確認してダウンロードできます"}</p><a className="export-download-link" href={exportUrl} download={exportFilename}><Download size={14} /> 動画をダウンロード</a></div>}</div><div className="shortcut-note"><Music2 size={15} /><span>ヒント<br /><b>音源を選んで、再生しながらスタイルを試してみましょう。</b></span></div></aside>
    </main>
  </div>;
}
