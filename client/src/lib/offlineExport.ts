/**
 * WebCodecs による実時間より速い書き出し。
 *
 * MediaRecorder は再生しながら録画するため、3分の動画には必ず3分かかる。
 * こちらは再生せず、フレームを1枚ずつ描いて直接エンコードするので、
 * CPU が許すかぎり速く終わる。
 *
 * 見た目をプレビューと合わせるため、AnalyserNode が返す値をここで再現する。
 * 再生していない以上ライブの AnalyserNode は使えないので、FFT を自前で回す。
 */
import {
  AudioBufferSource,
  BufferTarget,
  CanvasSource,
  Mp4OutputFormat,
  Output,
  WebMOutputFormat,
} from "mediabunny";
import { createRingState, type RingCalibration } from "./ringVisualizer";
import { drawFrame, type FrameOptions } from "./drawFrame";
// AnalyserNode の再現は解析側と共通。実装を二重に持つと、
// プレビューと書き出しで見た目がずれる原因になる。
import { FFT_SIZE, createAnalyserEmulation } from "./trackAnalysis";

/** 1080p でこの内容なら十分な量。上げてもエンコードが遅くなるだけ。 */
const VIDEO_BITRATE = 6_000_000;

export type OfflineExportOptions = {
  /** 元の音声ファイルのバイト列。 */
  audioData: ArrayBuffer;
  startSeconds: number;
  durationSeconds: number;
  /** 出力する動画のピクセルサイズ。 */
  width: number;
  height: number;
  /** 描画に使う論理幅。プレビューと同じ値を渡すと見た目が一致する。 */
  logicalWidth: number;
  fps: number;
  format: "mp4" | "webm";
  frame: Omit<FrameOptions, "width" | "height" | "scale" | "fft" | "wave" | "playing" | "time" | "ringState">;
  /** 読み込み時に作った基準。プレビューと同じものを渡すと絵が一致する。 */
  calibration?: RingCalibration | null;
  onProgress?: (ratio: number) => void;
  signal?: AbortSignal;
};


const videoCodecFor = (format: "mp4" | "webm") => (format === "mp4" ? "avc1.640028" : "vp8");

/**
 * この端末でのエンコード速度を実測する（1フレームあたりのミリ秒）。
 *
 * オフライン書き出しが必ず速いとは限らない。ハードウェアエンコーダの無い
 * 環境では、グローの多いこの映像はソフトウェアエンコードが重く、実時間録画
 * より遅くなることがある。数フレーム試してから選ぶ。
 */
export async function measureEncodeSpeed(
  format: "mp4" | "webm",
  width: number,
  height: number,
  paint: (ctx: OffscreenCanvasRenderingContext2D, index: number) => void,
): Promise<number> {
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d");
  if (!ctx) return Infinity;
  const frames = 12;
  let failed = false;
  const encoder = new VideoEncoder({ output: () => undefined, error: () => { failed = true; } });
  try {
    encoder.configure({
      codec: videoCodecFor(format),
      width,
      height,
      bitrate: VIDEO_BITRATE,
      framerate: 30,
      latencyMode: "realtime",
    });
    const started = performance.now();
    for (let i = 0; i < frames; i++) {
      paint(ctx, i);
      const frame = new VideoFrame(canvas, { timestamp: (i * 1e6) / 30, duration: 1e6 / 30 });
      encoder.encode(frame, { keyFrame: i === 0 });
      frame.close();
      if (encoder.encodeQueueSize > 6) await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await encoder.flush();
    if (failed) return Infinity;
    return (performance.now() - started) / frames;
  } catch {
    return Infinity;
  } finally {
    if (encoder.state !== "closed") encoder.close();
  }
}

/** この環境でオフライン書き出しが使えるか。 */
export async function canExportOffline(format: "mp4" | "webm", width: number, height: number) {
  if (typeof VideoEncoder === "undefined" || typeof AudioEncoder === "undefined") return false;
  if (typeof OffscreenCanvas === "undefined") return false;
  try {
    const video = await VideoEncoder.isConfigSupported({
      codec: videoCodecFor(format),
      width,
      height,
      bitrate: VIDEO_BITRATE,
      framerate: 30,
      latencyMode: "realtime",
    });
    const audio = await AudioEncoder.isConfigSupported({
      codec: format === "mp4" ? "mp4a.40.2" : "opus",
      sampleRate: 48000,
      numberOfChannels: 2,
      bitrate: 128_000,
    });
    return Boolean(video.supported && audio.supported);
  } catch {
    return false;
  }
}

/** 音声をデコードし、書き出す範囲だけを 48kHz ステレオに揃えて取り出す。 */
async function decodeSection(audioData: ArrayBuffer, startSeconds: number, durationSeconds: number) {
  const context = new AudioContext();
  let decoded: AudioBuffer;
  try {
    decoded = await context.decodeAudioData(audioData.slice(0));
  } finally {
    await context.close();
  }
  const sampleRate = 48000;
  const frames = Math.max(1, Math.round(durationSeconds * sampleRate));
  const offline = new OfflineAudioContext(2, frames, sampleRate);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start(0, startSeconds, durationSeconds);
  return offline.startRendering();
}

export async function exportOffline(options: OfflineExportOptions): Promise<Blob> {
  const { width, height, fps, format, signal } = options;
  const section = await decodeSection(options.audioData, options.startSeconds, options.durationSeconds);

  // 解析はモノラルで行う。AnalyserNode も入力をダウンミックスする。
  const left = section.getChannelData(0);
  const right = section.numberOfChannels > 1 ? section.getChannelData(1) : left;
  const mono = new Float32Array(left.length);
  for (let i = 0; i < mono.length; i++) mono[i] = (left[i] + right[i]) / 2;
  const analyse = createAnalyserEmulation(mono);

  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2Dコンテキストを作成できませんでした");

  const output = new Output({
    format: format === "mp4" ? new Mp4OutputFormat({ fastStart: "in-memory" }) : new WebMOutputFormat(),
    target: new BufferTarget(),
  });
  const videoSource = new CanvasSource(canvas, {
    // VP9 は同じ画でも VP8 の 1.2 倍ほど遅く、この内容では画質差も出にくい。
    codec: format === "mp4" ? "avc" : "vp8",
    bitrate: VIDEO_BITRATE,
    keyFrameInterval: 2,
    // realtime にすると品質より速度を優先した設定になる。
    // hardwareAcceleration は指定しない。prefer-hardware はハードウェア
    // エンコーダの無い端末で設定ごと拒否され、書き出せなくなる。
    onEncoderConfig: (config) => {
      config.latencyMode = "realtime";
    },
  });
  output.addVideoTrack(videoSource, { frameRate: fps });
  const audioSource = new AudioBufferSource({
    codec: format === "mp4" ? "aac" : "opus",
    bitrate: 160_000,
  });
  output.addAudioTrack(audioSource);
  await output.start();

  const logicalWidth = options.logicalWidth;
  const scale = width / logicalWidth;
  const logicalHeight = height / scale;
  const ringState = createRingState(options.calibration);
  const totalFrames = Math.max(1, Math.round(options.durationSeconds * fps));
  // プレビューと同じ色相・回転になるよう、開始位置ぶんの時間を渡す
  const timeOffset = options.startSeconds * 1000;

  try {
    for (let i = 0; i < totalFrames; i++) {
      if (signal?.aborted) throw new DOMException("中止しました", "AbortError");
      const seconds = i / fps;
      const { frequency, timeDomain } = analyse(Math.round((seconds + FFT_SIZE / section.sampleRate) * section.sampleRate));
      drawFrame(ctx, {
        ...options.frame,
        width: logicalWidth,
        height: logicalHeight,
        scale,
        fft: frequency,
        wave: timeDomain,
        playing: true,
        time: timeOffset + seconds * 1000,
        ringState,
      });
      await videoSource.add(seconds, 1 / fps);
      if (i % 5 === 0) options.onProgress?.((i / totalFrames) * 0.9);
    }
    await audioSource.add(section);
    options.onProgress?.(0.95);
    await output.finalize();
  } catch (error) {
    await output.cancel().catch(() => undefined);
    throw error;
  }

  const buffer = output.target.buffer;
  if (!buffer) throw new Error("書き出しに失敗しました");
  options.onProgress?.(1);
  return new Blob([buffer], { type: format === "mp4" ? "video/mp4" : "video/webm" });
}
