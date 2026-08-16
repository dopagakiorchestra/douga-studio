/**
 * 二重円リング（円形スペクトラム）の描画ロジック。
 *
 * 参照デザイン:
 * - 内側 … なめらかな円。細い白芯 + 時間で色相が回るレインボーのブルーム。
 *          線上には時間波形の速い成分だけを取り出した細い針状のヒゲが房状に走る。
 * - 外側 … 内側の約1.9倍径の 1px 白ローポリ（16角形）。
 *          全周に目盛りが並び、弱い帯域は点、強い帯域だけ長いトゲが伸びる。
 */

const TAU = Math.PI * 2;

/** キャンバス短辺に対する内側リング半径の比率。 */
export const RING_INNER_RATIO = 0.075;
/** 内側リングに対する外側リングの倍率。 */
export const RING_OUTER_SCALE = 1.9;
/** キャンバス短辺に対する外側リング半径の比率。 */
export const RING_OUTER_RATIO = RING_INNER_RATIO * RING_OUTER_SCALE;
/** レインボーが一周する時間（ミリ秒）。 */
export const RING_HUE_PERIOD = 2880;
/**
 * 帯域の割り当てが円を一周する時間（ミリ秒）。
 * 固定だとキックのアタックが毎回同じ位置で跳ねてしまうので、
 * 帯域と角度の対応をゆっくり回して、反応する場所を移動させる。
 */
export const RING_BAND_DRIFT_PERIOD = 18000;

export type RingMetrics = { min: number; max: number };

export type RingOptions = {
  /** 描画座標系での幅・高さ（CSS ピクセル）。 */
  width: number;
  height: number;
  /**
   * 描画座標系 1 単位あたりのデバイスピクセル数。
   * shadowBlur は CTM の影響を受けないため、グロー量の指定に使う。
   */
  glowScale: number;
  fft: Uint8Array | null;
  wave: Uint8Array | null;
  playing: boolean;
  /** 経過時間（ミリ秒）。内側リングの色相に使う。 */
  time: number;
  /** 反応量の倍率（感度スライダー）。 */
  sensitivity: number;
};

const smoothstep = (t: number) => t * t * (3 - 2 * t);

/** 継ぎ目のクロスフェードに使う円周の割合。 */
const SEAM_ARC = 0.12;

/**
 * FFT を対数軸で円周へ割り当てるサンプラーを作る。
 *
 * 線形割り当てだと高域ビンがほぼ無音になり円の一部が完全に死ぬため、
 * 低域から高域までを対数で一周に配る。掃引の終端（高域）と始端（低域）は
 * そのままだと 12 時位置で段差になるので、最後の SEAM_ARC ぶんだけ
 * 掃引の続き（低域側）へクロスフェードして繋ぐ。
 * 一定値へ寄せる方式と違い、帯域ごとの強弱を潰さずに継ぎ目だけを消せる。
 */
const createSpectrum = (fft: Uint8Array | null, playing: boolean) => {
  const bins = fft?.length ?? 0;
  if (!playing || !fft || bins === 0) return () => 0;
  const lowBin = 2;
  const highBin = Math.max(lowBin + 1, Math.floor(bins * 0.82));
  const ratio = highBin / lowBin;
  const rawAt = (t: number) => {
    const position = Math.max(1, lowBin * Math.pow(ratio, t));
    const index = Math.floor(position);
    const fraction = position - index;
    const a = fft[Math.min(index, bins - 1)] / 255;
    const b = fft[Math.min(index + 1, bins - 1)] / 255;
    const level = a + (b - a) * fraction;
    return Math.min(1, Math.pow(level, 0.8) * (1 + Math.max(0, Math.min(1, t)) * 0.55));
  };
  return (t: number) => {
    const u = ((t % 1) + 1) % 1;
    if (u < 1 - SEAM_ARC) return rawAt(u);
    const blend = smoothstep((u - (1 - SEAM_ARC)) / SEAM_ARC);
    return rawAt(u) * (1 - blend) + rawAt(u - 1) * blend;
  };
};

/**
 * 内側リングの形を作る低次ハーモニクスの重み。
 * 角度の周期関数の和なので、どんな音でも継ぎ目なく閉じた丸い線になる。
 * spin は 1 秒あたりの回転数。それぞれ速さと向きを変えてあるので、
 * 全体が硬く回らず、うねりが常に組み変わりながら動く。
 */
const SHAPE_HARMONICS = [
  { order: 2, band: 0.04, phase: 0, spin: 0.055 },
  { order: 3, band: 0.13, phase: 1.1, spin: -0.038 },
  { order: 5, band: 0.28, phase: 2.4, spin: 0.026 },
  { order: 7, band: 0.5, phase: 3.9, spin: -0.017 },
];

/**
 * 時間波形を円周へ巻き付け、隣接サンプルとの差分（ハイパス）を返すサンプラー。
 *
 * 生の波形をそのまま使うと低域のうねりでリング全体が歪むだけになるので、
 * 速い変化だけを取り出して参照映像のような房状の針を作る。
 * 常に剰余で折り返すため継ぎ目補正は不要。
 */
const createWaveDetail = (wave: Uint8Array | null, playing: boolean) => {
  const length = wave?.length ?? 0;
  if (!playing || !wave || length === 0) return { at: () => 0, drive: 0 };
  // 移動平均を引いたハイパス。窓が狭すぎると超高域しか拾えないので、
  // 中高域のアタックにも反応する幅にする。
  const radius = Math.max(2, Math.round(length / 42));
  const taps = radius * 2 + 1;
  const detail = new Float32Array(length);
  let peak = 0;
  for (let i = 0; i < length; i++) {
    let sum = 0;
    for (let k = -radius; k <= radius; k++) sum += wave[((i + k) % length + length) % length];
    detail[i] = (wave[i] - sum / taps) / 128;
    peak = Math.max(peak, Math.abs(detail[i]));
  }
  // フレーム内のピークで正規化する。音量の小さい曲でもヒゲが出るようにしつつ、
  // 無音では drive が 0 に落ちてリングが静止する。
  const scale = 1 / Math.max(peak, 1e-4);
  return {
    drive: Math.min(1, peak / 0.05),
    at: (t: number) => {
      const position = (((t % 1) + 1) % 1) * length;
      const index = Math.floor(position);
      const fraction = position - index;
      return (detail[index % length] * (1 - fraction) + detail[(index + 1) % length] * fraction) * scale;
    },
  };
};

type Point = { x: number; y: number };

/** 半径配列からローポリ多角形の頂点を作る（12時始まり・時計回り）。 */
const buildPolygon = (radii: number[]): Point[] =>
  radii.map((r, i) => {
    const angle = (i / radii.length) * TAU - Math.PI / 2;
    return { x: Math.cos(angle) * r, y: Math.sin(angle) * r };
  });

const tracePolygon = (path: Path2D | CanvasRenderingContext2D, points: Point[]) => {
  path.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) path.lineTo(points[i].x, points[i].y);
  path.closePath();
};

/**
 * 多角形の辺上（弦上）の点を求める。
 * 半径補間ではなく実際の辺をたどるので、線に沿わせた目盛りがズレない。
 */
const pointOnPolygon = (points: Point[], t: number): Point => {
  const count = points.length;
  const position = (((t % 1) + 1) % 1) * count;
  const index = Math.floor(position);
  const fraction = position - index;
  const a = points[index % count];
  const b = points[(index + 1) % count];
  return { x: a.x + (b.x - a.x) * fraction, y: a.y + (b.y - a.y) * fraction };
};

/** 内側リングの分割数。細かく取り、平滑化して丸い線にする。 */
const INNER_POINTS = 512;
/** 外側リングの角数。参照映像に合わせてはっきり多角形に見える粗さにする。 */
const OUTER_SIDES = 16;
/** 外周の目盛り本数。参照映像の角度密度（約1.7度おき）に合わせる。 */
const TICK_COUNT = 208;
/** これ未満の帯域は点だけを打つ。 */
const TICK_DOT_THRESHOLD = 0.09;
/** ヒゲが伸びる最大量（内側半径比）。 */
const HAIR_LIMIT = 0.22;

export function drawRing(ctx: CanvasRenderingContext2D, options: RingOptions): RingMetrics {
  const { width, height, glowScale, fft, wave, playing, time, sensitivity } = options;
  const shortest = Math.min(width, height);
  const innerR = shortest * RING_INNER_RATIO;
  const outerR = shortest * RING_OUTER_RATIO;
  const react = Math.max(0.35, Math.min(2.4, sensitivity));

  const seconds = time / 1000;
  // 帯域と角度の対応をゆっくり回す。キックのアタックを担当する位置が
  // 一箇所に固定されず、円周をまわりながら跳ねるようになる。
  const bandDrift = playing ? time / RING_BAND_DRIFT_PERIOD : 0;
  const spectrum = createSpectrum(fft, playing);
  const detailAt = (t: number) => spectrum(t - bandDrift);
  // 内側の形は帯域ごとの強さを低次ハーモニクスの振幅に割り当てて作る。
  // ハーモニクスごとに向きと速さの違う回転を与え、うねりが組み変わり続けるようにする。
  const harmonics = SHAPE_HARMONICS.map((h) => ({ ...h, gain: spectrum(h.band) }));
  const shapeAt = (t: number) =>
    harmonics.reduce(
      (sum, h) => sum + h.gain * Math.cos(TAU * (h.order * t + h.spin * seconds) + h.phase),
      0,
    ) / harmonics.length;
  const hair = createWaveDetail(wave, playing);
  const bass = playing && fft?.length ? fft.slice(1, 10).reduce((a, b) => a + b, 0) / (9 * 255) : 0;
  const hue = ((time / (RING_HUE_PERIOD / 360)) % 360 + 360) % 360;
  const neon = `hsl(${hue.toFixed(1)}, 100%, 58%)`;
  const neonSoft = `hsla(${hue.toFixed(1)}, 100%, 60%, 0.55)`;

  ctx.save();
  ctx.translate(width / 2, height / 2);
  ctx.globalCompositeOperation = "lighter";
  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  // ---- 内側リング（なめらかなネオンの円） ---------------------------------
  const innerRadii: number[] = [];
  for (let i = 0; i < INNER_POINTS; i++) {
    const shape = shapeAt(i / INNER_POINTS) * 0.035 * react;
    innerRadii.push(innerR * (1 + shape + bass * 0.02 * react));
  }
  const innerPoints = buildPolygon(innerRadii);
  const innerPath = new Path2D();
  tracePolygon(innerPath, innerPoints);

  const glowPass = (stroke: string, lineWidth: number, blur: number, alpha: number) => {
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = stroke;
    ctx.lineWidth = Math.max(0.75, lineWidth);
    ctx.shadowColor = stroke;
    ctx.shadowBlur = blur * glowScale;
    ctx.stroke(innerPath);
  };

  const bloom = 1 + bass * 0.55;
  glowPass(neonSoft, innerR * 0.05, innerR * 0.34 * bloom, 0.45);
  glowPass(neonSoft, innerR * 0.04, innerR * 0.16 * bloom, 0.55);
  glowPass(neon, innerR * 0.028, innerR * 0.06, 0.9);
  glowPass("#ffffff", innerR * 0.018, innerR * 0.025, 1);

  // 線上を走る針状のヒゲ（時間波形の速い成分）
  ctx.globalAlpha = 0.92;
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = Math.max(0.7, innerR * 0.011);
  ctx.shadowColor = neon;
  ctx.shadowBlur = innerR * 0.04 * glowScale;
  ctx.beginPath();
  for (let i = 0; i <= INNER_POINTS; i++) {
    const index = i % INNER_POINTS;
    const sample = hair.at(index / INNER_POINTS);
    const magnitude = Math.min(HAIR_LIMIT, Math.pow(Math.abs(sample), 1.15) * 0.15 * hair.drive * react);
    const offset = Math.sign(sample) * magnitude * innerR;
    const base = innerPoints[index];
    const distance = innerRadii[index] || 1;
    const x = base.x + (base.x / distance) * offset;
    const y = base.y + (base.y / distance) * offset;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.stroke();

  // ---- 外側リング（1px 白ローポリ + 目盛り） -------------------------------
  const outerRadii: number[] = [];
  for (let i = 0; i < OUTER_SIDES; i++) {
    const level = detailAt(i / OUTER_SIDES);
    outerRadii.push(outerR * (1 + (level - 0.3) * 0.075 * react));
  }
  const outerPoints = buildPolygon(outerRadii);

  ctx.globalAlpha = 0.95;
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 1;
  ctx.shadowBlur = 0;
  ctx.beginPath();
  tracePolygon(ctx, outerPoints);
  ctx.stroke();

  let frameMin = 1;
  let frameMax = 0;
  let sum = 0;
  const levels: number[] = [];
  for (let i = 0; i < TICK_COUNT; i++) {
    const level = detailAt(i / TICK_COUNT);
    levels.push(level);
    sum += level;
    frameMin = Math.min(frameMin, level);
    frameMax = Math.max(frameMax, level);
  }
  // 全周の平均を差し引いてから伸ばす。広帯域な曲でも全周が同じ長さのトゲに
  // ならず、参照映像のように「突出した帯域だけ長い」房ができる。
  const floor = (sum / TICK_COUNT) * 0.6;
  const span = Math.max(0.15, 1 - floor);

  // 目盛りの太さ・点の大きさは間隔に対する比で決める。
  // リング径を変えても線が詰まって帯にならず、抜け感が保たれる。
  const spacing = (TAU * outerR) / TICK_COUNT;
  ctx.lineWidth = Math.max(0.5, spacing * 0.26);
  ctx.fillStyle = "#ffffff";
  const dotRadius = Math.max(0.35, spacing * 0.22);
  for (let i = 0; i < TICK_COUNT; i++) {
    const emphasis = Math.max(0, levels[i] - floor) / span;
    const base = pointOnPolygon(outerPoints, i / TICK_COUNT);
    const distance = Math.hypot(base.x, base.y) || 1;
    const nx = base.x / distance;
    const ny = base.y / distance;
    if (emphasis < TICK_DOT_THRESHOLD) {
      ctx.globalAlpha = 0.85;
      ctx.beginPath();
      ctx.arc(base.x, base.y, dotRadius, 0, TAU);
      ctx.fill();
      continue;
    }
    const length = outerR * (0.006 + emphasis * 0.11 * react);
    ctx.globalAlpha = 0.6 + emphasis * 0.4;
    ctx.beginPath();
    ctx.moveTo(base.x, base.y);
    ctx.lineTo(base.x + nx * length, base.y + ny * length);
    ctx.stroke();
  }

  ctx.restore();
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
  ctx.shadowBlur = 0;
  return { min: frameMin, max: frameMax };
}
