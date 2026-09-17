/**
 * 1フレームぶんの描画。
 *
 * プレビューのループと、書き出し（オフライン描画）の両方から呼ぶ。
 * 見た目を1か所に集約しておかないと、プレビューと書き出しがずれる。
 */
import { drawRing, hueAt, neonColor, RING_OUTER_RATIO, type RingMetrics, type RingState } from "./ringVisualizer";

/** パレットで「時間で色相が一周する」を表す値。 */
export const RAINBOW = "rainbow";

export type VizStyle = "line" | "ring";

/**
 * 曲名とアーティスト名を置く位置。
 *
 * ショート動画は下 3 割ほどと右端がプラットフォームの UI（共有ボタン、
 * チャンネル名、説明、下のタブバー）で覆われる。画面の下端に置くと
 * そこに完全に隠れてしまうので、覆われない範囲を選べるようにしている。
 */
export type LabelPosition = "top" | "aboveRing" | "bottom";

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
  /** 文字の置き場所。 */
  labelPosition: LabelPosition;
  /**
   * プレビューだけで、SNS の UI に隠れる範囲の目安を薄く描く。
   * 書き出す映像には入れない。
   */
  guides?: boolean;
  ringState: RingState;
};

/**
 * ショート動画でプラットフォームの UI に覆われる割合（高さ・幅に対する比）。
 * YouTube ショートの実機を測った値。TikTok や Reels もおおむね同じ。
 */
const SHORTS_COVER_TOP = 0.12;
const SHORTS_COVER_BOTTOM = 0.34;
const SHORTS_COVER_RIGHT = 0.14;

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
    // アートワークはそのままの明るさで敷く。
    // 以前は 72% の不透明度で描いたうえに黒をかぶせていたため、
    // 元画像の 6 割弱の明るさまで沈んでいた。
    context.drawImage(options.background, 0, 0, w, h);
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
    // 黒い縁取りを敷いてから白で塗る。アートワークは明るい砂浜のことも
    // 空のこともあるので、白を薄く置くだけだと背景に溶けて読めなくなる。
    // 縁取りは文字の外へ半分しか出ないため、太さは字の大きさの 2 割強を取る。
    const label = (text: string, size: number, font: string, y: number) => {
      context.font = font;
      context.lineJoin = "round";
      context.lineWidth = size * 0.22;
      context.strokeStyle = "rgba(0,0,0,.85)";
      context.strokeText(text, w / 2, y);
      context.fillStyle = "#ffffff";
      context.fillText(text, w / 2, y);
    };
    const shortest = Math.min(w, h);
    // リングの針は外径の 1.6 倍ほどまで伸びる。その外側に置かないと
    // 盛り上がりで文字に針が刺さる。
    const ringClear = h / 2 - shortest * RING_OUTER_RATIO * 2.7;
    const top =
      options.labelPosition === "bottom"
        ? h - (cleanTitle && cleanArtist ? 46 : 28)
        : options.labelPosition === "top"
          ? h * SHORTS_COVER_TOP
          : Math.max(h * SHORTS_COVER_TOP, ringClear - (cleanTitle && cleanArtist ? 22 : 0));
    // 下寄せのときだけ従来どおり曲名が上、それ以外は上から曲名→アーティスト名。
    if (cleanTitle) label(cleanTitle, 16, "600 16px 'Space Grotesk', sans-serif", top);
    if (cleanArtist) label(cleanArtist, 13, "13px 'IBM Plex Mono', monospace", cleanTitle ? top + 24 : top);
    context.textAlign = "start";
  }

  // SNS の UI に隠れる範囲の目安。プレビュー専用で、書き出しには入らない。
  if (options.guides && h > w) {
    context.save();
    context.setLineDash([6, 5]);
    context.lineWidth = 1;
    context.strokeStyle = "rgba(255,255,255,.34)";
    context.fillStyle = "rgba(0,0,0,.28)";
    const bottom = h * (1 - SHORTS_COVER_BOTTOM);
    const right = w * (1 - SHORTS_COVER_RIGHT);
    context.fillRect(0, 0, w, h * SHORTS_COVER_TOP);
    context.fillRect(0, bottom, w, h - bottom);
    context.fillRect(right, h * SHORTS_COVER_TOP, w - right, bottom - h * SHORTS_COVER_TOP);
    context.beginPath();
    context.moveTo(0, h * SHORTS_COVER_TOP);
    context.lineTo(w, h * SHORTS_COVER_TOP);
    context.moveTo(0, bottom);
    context.lineTo(w, bottom);
    context.moveTo(right, h * SHORTS_COVER_TOP);
    context.lineTo(right, bottom);
    context.stroke();
    context.setLineDash([]);
    context.fillStyle = "rgba(255,255,255,.5)";
    context.font = "9px 'IBM Plex Mono', monospace";
    context.textAlign = "start";
    context.fillText("SNSのUIで隠れる目安", 8, bottom + 12);
    context.restore();
  }
  return metrics;
}
