/**
 * 二重円リング（円形スペクトラム）の描画ロジック。
 *
 * 参照デザイン:
 * - 内側 … なめらかな円。細い白芯 + 時間で色相が回るレインボーのブルーム。
 *          線上には時間波形の速い成分だけを取り出した細い針状のヒゲが房状に走る。
 * - 外側 … 内側の約1.9倍径の 1px 白のなめらかな円。
 *          全周に目盛りが並び、強い帯域ほど長いトゲが伸びる。
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

/**
 * 音量追従の状態。フレームをまたいで保持する。
 *
 * 1フレームぶんの音（約6ms）だけを見て正規化すると、静かになっても
 * その場のピークまで持ち上がってしまい、強弱がまったく出ない。
 * そこで「その曲が大きいときの値」を基準として覚えておき、
 * 現在の音をその基準との比で見ることで、弱くなったぶんだけ絵も弱くする。
 */
export type RingState = {
  /** 短いリリースでならした現在の音量。 */
  level: number;
  /** ゆっくり減衰する音量の基準。 */
  reference: number;
  /** 同じく、ヒゲ用（波形の速い成分）の基準。 */
  detailReference: number;
  /** 前回描画した時刻（ミリ秒）。 */
  lastTime: number;
};

export const createRingState = (): RingState => ({
  level: 0,
  reference: 0,
  detailReference: 0,
  lastTime: 0,
});

/** 音量の基準が半分まで下がるのにかかる時間（ミリ秒）。 */
const LOUDNESS_HALF_LIFE = 3500;
/** コマごとのばらつきをならすリリースの半減期（ミリ秒）。 */
const LEVEL_RELEASE_HALF_LIFE = 240;
/** これ以下の音量は無音として扱う（RMS）。 */
const SILENCE_RMS = 0.004;
/**
 * 音量比にかける指数。1 より大きいほど、少し弱くなっただけで
 * 大きく小さくなる＝弱さに敏感になる。
 */
const LOUDNESS_EXPONENT = 1.35;

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
  /** 音量追従の状態。呼び出し側で使い回す。 */
  state: RingState;
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
  if (!playing || !wave || length === 0) return { at: () => 0, peak: 0, rms: 0 };
  // 移動平均を引いたハイパス。窓が狭すぎると超高域しか拾えないので、
  // 中高域のアタックにも反応する幅にする。
  const radius = Math.max(2, Math.round(length / 42));
  const taps = radius * 2 + 1;
  const detail = new Float32Array(length);
  let peak = 0;
  let square = 0;
  for (let i = 0; i < length; i++) {
    let sum = 0;
    for (let k = -radius; k <= radius; k++) sum += wave[((i + k) % length + length) % length];
    detail[i] = (wave[i] - sum / taps) / 128;
    peak = Math.max(peak, Math.abs(detail[i]));
    const sample = (wave[i] - 128) / 128;
    square += sample * sample;
  }
  // ここでは正規化しない。生の大きさのまま返し、
  // 曲全体の基準との比較は呼び出し側（音量追従）に任せる。
  return {
    peak,
    rms: Math.sqrt(square / length),
    at: (t: number) => {
      const position = (((t % 1) + 1) % 1) * length;
      const index = Math.floor(position);
      const fraction = position - index;
      return detail[index % length] * (1 - fraction) + detail[(index + 1) % length] * fraction;
    },
  };
};

/** 配列を円環として移動平均する。継ぎ目なく、なめらかな輪郭を作る。 */
const smoothCircular = (values: number[], radius: number, passes: number) => {
  const count = values.length;
  let current = values;
  for (let pass = 0; pass < passes; pass++) {
    const next = new Array<number>(count);
    for (let i = 0; i < count; i++) {
      let total = 0;
      for (let k = -radius; k <= radius; k++) total += current[((i + k) % count + count) % count];
      next[i] = total / (radius * 2 + 1);
    }
    current = next;
  }
  return current;
};

type Point = { x: number; y: number };

/** 半径配列から輪郭の頂点を作る（12時始まり・時計回り）。 */
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

/** 内側リングの分割数。細かく取り、平滑化して丸い線にする。 */
const INNER_POINTS = 512;
/** 外側リングの輪郭をならす窓の半径（サンプル数）。大きいほど丸くなる。 */
const OUTER_SMOOTH_RADIUS = 11;
/** 外周の目盛り本数。参照映像の角度密度（約1.7度おき）に合わせる。 */
const TICK_COUNT = 208;
/** ヒゲが伸びる最大量（内側半径比）。 */
const HAIR_LIMIT = 0.22;
/** ヒゲの強弱カーブ。大きいほど弱い音で短くなる。 */
const HAIR_EXPONENT = 1.35;

export function drawRing(ctx: CanvasRenderingContext2D, options: RingOptions): RingMetrics {
  const { width, height, glowScale, fft, wave, playing, time, sensitivity, state } = options;
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

  // ---- 音量追従 -----------------------------------------------------------
  // 立ち上がりは即座、戻りはゆっくり。こうすると「その曲が大きいときの値」が
  // 基準として残り、音が弱まったフレームでは比が下がって絵も一緒に弱くなる。
  const elapsed = state.lastTime > 0 ? Math.max(0, Math.min(500, time - state.lastTime)) : 0;
  state.lastTime = time;
  const release = Math.pow(0.5, elapsed / LEVEL_RELEASE_HALF_LIFE);
  const decay = Math.pow(0.5, elapsed / LOUDNESS_HALF_LIFE);
  state.level = Math.max(hair.rms, state.level * release);
  state.reference = Math.max(state.level, state.reference * decay);
  state.detailReference = Math.max(hair.peak, state.detailReference * decay);
  const ratio = state.reference > SILENCE_RMS ? state.level / state.reference : 0;
  const energy = Math.pow(Math.max(0, Math.min(1, ratio)), LOUDNESS_EXPONENT);
  // ヒゲも同じ考え方で、曲の大きいときの速い成分を 1 とした比で出す
  const hairScale = state.detailReference > 1e-4 ? 1 / state.detailReference : 0;

  const bass = (playing && fft?.length ? fft.slice(1, 10).reduce((a, b) => a + b, 0) / (9 * 255) : 0) * energy;
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
    const shape = shapeAt(i / INNER_POINTS) * 0.035 * react * energy;
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
  // グローの強さも音量で息をさせる。ただしリング自体は常に見えるよう下限を残す。
  const shine = 0.55 + 0.45 * energy;
  // 色の帯を白芯よりはっきり太くする。細いと芯の白に負けて色相が読めない。
  glowPass(neonSoft, innerR * 0.095, innerR * 0.34 * bloom, 0.45 * shine);
  glowPass(neonSoft, innerR * 0.075, innerR * 0.16 * bloom, 0.55 * shine);
  glowPass(neon, innerR * 0.07, innerR * 0.06, 0.9 * shine);
  glowPass("#ffffff", innerR * 0.026, innerR * 0.025, 1);

  // 線上を走る針状のヒゲ（時間波形の速い成分）
  ctx.globalAlpha = 0.92;
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = Math.max(0.7, innerR * 0.011);
  ctx.shadowColor = neon;
  ctx.shadowBlur = innerR * 0.04 * glowScale;
  ctx.beginPath();
  for (let i = 0; i <= INNER_POINTS; i++) {
    const index = i % INNER_POINTS;
    // 曲が大きいときの速い成分を 1 とした比。弱まればそのぶん短くなる。
    const sample = hair.at(index / INNER_POINTS) * hairScale;
    const magnitude = Math.min(
      HAIR_LIMIT,
      Math.pow(Math.min(1, Math.abs(sample)), HAIR_EXPONENT) * 0.26 * react,
    );
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

  // ---- 外側リング（なめらかな白い円 + 目盛り） -----------------------------
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

  // 帯域ごとの細かい凹凸をならしてから輪郭にする。目盛りと同じ分割数で
  // 描くので、角の立った多角形ではなく丸い線になり、目盛りもその上に乗る。
  const outerShape = smoothCircular(levels, OUTER_SMOOTH_RADIUS, 2);
  const outerRadii = outerShape.map(
    (value) => outerR * (1 + (value - 0.3) * 0.07 * react * energy),
  );
  const outerPoints = buildPolygon(outerRadii);

  ctx.globalAlpha = 0.95;
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 1;
  ctx.shadowBlur = 0;
  ctx.beginPath();
  tracePolygon(ctx, outerPoints);
  ctx.stroke();

  // 目盛りの太さと最短の長さは間隔に対する比で決める。
  // リング径を変えても線が詰まって帯にならず、抜け感が保たれる。
  // 最短でも線の外へわずかに出るので、音が弱くても目盛りの並びは残り、
  // 素の多角形に戻ってしまうことがない（丸いキャップで点に見える）。
  const spacing = (TAU * outerR) / TICK_COUNT;
  ctx.lineWidth = Math.max(0.5, spacing * 0.26);
  const baseLength = Math.max(0.7, spacing * 0.6);
  for (let i = 0; i < TICK_COUNT; i++) {
    const emphasis = Math.max(0, levels[i] - floor) / span;
    // 伸びる量だけを音量に追従させる。弱い場面では長さが素直に縮む。
    const reach = emphasis * energy;
    const base = outerPoints[i];
    const distance = outerRadii[i] || 1;
    const nx = base.x / distance;
    const ny = base.y / distance;
    const length = baseLength + outerR * reach * 0.11 * react;
    ctx.globalAlpha = 0.6 + reach * 0.4;
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
