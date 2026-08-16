/**
 * 1フレームぶんの描画。
 *
 * プレビューのループと、書き出し（オフライン描画）の両方から呼ぶ。
 * 見た目を1か所に集約しておかないと、プレビューと書き出しがずれる。
 */
import { drawRing, hueAt, neonColor, type RingMetrics, type RingState } from "./ringVisualizer";

/** パレットで「時間で色相が一周する」を表す値。 */
export const RAINBOW = "rainbow";

export type VizStyle = "line" | "ring";

export type FrameOptions = {
  /** 描画に使う論理サイズ（CSSピクセル相当）。 */
  width: number;
  height: number;
  /** 論理1あたりの出力ピクセル数。 */
  scale: number;
  fft: Uint8Array | null;
  wave: Uint8Array | null;
  playing: boolean;
  /** 経過時間（ミリ秒）。 */
  time: number;
  style: VizStyle;
  /** 内側リング／ラインの色。RAINBOW なら時間で一周する。 */
  vizColor: string;
  /** 外側リングの色。RAINBOW なら時間で一周する。 */
  outerColor: string;
  sensitivity: number;
  amplitude: number;
  wobble: number;
  lineWeight: number;
  background: CanvasImageSource | null;
  title: string;
  artist: string;
  ringState: RingState;
};

export function drawFrame(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  options: FrameOptions,
): RingMetrics | null {
  const { width: w, height: h, scale, fft, wave, playing, time } = options;
  const context = ctx as CanvasRenderingContext2D;
  context.setTransform(scale, 0, 0, scale, 0, 0);
  context.clearRect(0, 0, w, h);
  const grad = context.createLinearGradient(0, 0, w, h);
  grad.addColorStop(0, "#000000");
  grad.addColorStop(1, "#050505");
  context.fillStyle = grad;
  context.fillRect(0, 0, w, h);

  const bass = fft ? fft.slice(0, 12).reduce((a, b) => a + b, 0) / (12 * 255) : 0.18;
  const treble = fft ? fft.slice(40, 90).reduce((a, b) => a + b, 0) / (50 * 255) : 0.2;

  if (options.background) {
    context.globalAlpha = 0.72;
    context.drawImage(options.background, 0, 0, w, h);
    context.fillStyle = "rgba(0,0,0,.28)";
    context.fillRect(0, 0, w, h);
    context.globalAlpha = 1;
  }

  // レインボーを選んでいるときだけ、時間で一周する色相を使う
  const accent = options.vizColor === RAINBOW ? neonColor(hueAt(time)) : options.vizColor;
  context.shadowColor = accent;
  context.shadowBlur = 20;
  context.strokeStyle = accent;
  context.fillStyle = accent;
  context.lineWidth = 2;

  let metrics: RingMetrics | null = null;
  if (options.style === "line") {
    const length = wave?.length || 256;
    const sampleAt = (x: number) => {
      const index = Math.min(Math.floor(((x - 24) / (w - 48)) * (length - 1)), length - 1);
      return wave ? (wave[index] - 128) / 128 : 0;
    };
    context.beginPath();
    for (let x = 24; x <= w - 24; x += 3) {
      const ripple = Math.sin(x * 0.035 + time / 230) * options.wobble * (2 + treble * 9);
      const y = h / 2 + ripple + (playing ? sampleAt(x) * h * options.amplitude * options.sensitivity : Math.sin(x * 0.025) * 3);
      if (x === 24) context.moveTo(x, y);
      else context.lineTo(x, y);
    }
    context.lineWidth = Math.max(0.45, options.lineWeight + bass * 0.8 + (playing ? Math.abs(Math.sin(time / 100)) * 0.3 : 0));
    context.stroke();
    context.globalAlpha = 0.2;
    context.lineWidth = 1;
    context.beginPath();
    for (let x = 24; x <= w - 24; x += 3) {
      const y = h / 2 - (playing ? sampleAt(x) * h * options.amplitude * options.sensitivity * 0.62 : 0) + Math.sin(x * 0.03 + time / 280) * 2;
      if (x === 24) context.moveTo(x, y);
      else context.lineTo(x, y);
    }
    context.stroke();
    context.globalAlpha = 1;
  } else {
    metrics = drawRing(context, {
      width: w,
      height: h,
      glowScale: scale,
      fft,
      wave,
      playing,
      time,
      sensitivity: options.sensitivity,
      innerColor: options.vizColor === RAINBOW ? null : options.vizColor,
      outerColor: options.outerColor === RAINBOW ? neonColor(hueAt(time)) : options.outerColor,
      state: options.ringState,
    });
  }

  context.shadowBlur = 0;
  const cleanTitle = options.title.trim();
  const cleanArtist = options.artist.trim();
  if (cleanTitle || cleanArtist) {
    context.textAlign = "center";
    context.textBaseline = "middle";
    if (cleanTitle) {
      context.fillStyle = "rgba(255,255,255,.92)";
      context.font = "600 16px 'Space Grotesk', sans-serif";
      context.fillText(cleanTitle, w / 2, h - (cleanArtist ? 46 : 28));
    }
    if (cleanArtist) {
      context.fillStyle = "rgba(255,255,255,.58)";
      context.font = "12px 'IBM Plex Mono', monospace";
      context.fillText(cleanArtist, w / 2, h - 22);
    }
    context.textAlign = "start";
  }
  return metrics;
}
