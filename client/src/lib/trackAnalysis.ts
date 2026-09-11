/**
 * 音源そのものの解析。
 *
 * 役割は2つある。
 * 1. 再生していない状態で AnalyserNode と同じ値を作る（書き出し用）。
 * 2. 曲全体を一度走査して、リングの基準を確定させる。
 *
 * 2 が無いと、基準を再生しながら育てることになる。すると曲の頭では
 * 基準が 0 から始まるので最初の音で全部が上限を打ち、逆に静かな部分では
 * 数秒で基準が下がってまた大きく見える。つまり絵が曲の盛り上がりと
 * 噛み合わなくなる。先に全曲を測ってしまえば、1 フレーム目から
 * 「その曲のいちばん大きいところ」との比で描ける。
 */
import { BAND_COUNT, BAND_PEAK_FLOOR, measureWave, sampleBands, type RingCalibration } from "./ringVisualizer";

/** Home.tsx の AnalyserNode と同じ設定。ここがずれると見た目が変わる。 */
export const FFT_SIZE = 256;
const MIN_DECIBELS = -78;
const MAX_DECIBELS = -12;
const SMOOTHING = 0.5;

/**
 * 解析のコマ数（1秒あたり）。
 * ここで欲しいのは百分位だけなので、描画と同じ 60 まで細かく見る必要はない。
 * 30 にすると 3 分の曲で解析が半分の時間で終わる。
 */
const ANALYSIS_FPS = 30;
/**
 * 基準に使う百分位。最大値そのものだと、1 発のクリップや事故的な
 * ピークで曲全体の尺が決まってしまう。
 */
const REFERENCE_PERCENTILE = 0.97;

/** 2の冪サイズの実数入力 FFT（in-place、ビット反転並べ替え）。 */
export function fft(re: Float32Array, im: Float32Array) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const angle = (-2 * Math.PI) / len;
    const wRe = Math.cos(angle);
    const wIm = Math.sin(angle);
    for (let i = 0; i < n; i += len) {
      let curRe = 1;
      let curIm = 0;
      for (let k = 0; k < len / 2; k++) {
        const aRe = re[i + k];
        const aIm = im[i + k];
        const bRe = re[i + k + len / 2] * curRe - im[i + k + len / 2] * curIm;
        const bIm = re[i + k + len / 2] * curIm + im[i + k + len / 2] * curRe;
        re[i + k] = aRe + bRe;
        im[i + k] = aIm + bIm;
        re[i + k + len / 2] = aRe - bRe;
        im[i + k + len / 2] = aIm - bIm;
        const nextRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
      }
    }
  }
}

/**
 * AnalyserNode の getByteFrequencyData / getByteTimeDomainData を再現する。
 * Blackman 窓 → FFT → 時間方向の平滑化 → dB → 0〜255、という仕様どおりの順序。
 */
export function createAnalyserEmulation(mono: Float32Array) {
  const bins = FFT_SIZE / 2;
  const window = new Float32Array(FFT_SIZE);
  for (let i = 0; i < FFT_SIZE; i++) {
    window[i] = 0.42 - 0.5 * Math.cos((2 * Math.PI * i) / FFT_SIZE) + 0.08 * Math.cos((4 * Math.PI * i) / FFT_SIZE);
  }
  const smoothed = new Float32Array(bins);
  const re = new Float32Array(FFT_SIZE);
  const im = new Float32Array(FFT_SIZE);
  const frequency = new Uint8Array(bins);
  const timeDomain = new Uint8Array(FFT_SIZE);
  const range = MAX_DECIBELS - MIN_DECIBELS;

  return (endSample: number) => {
    const start = endSample - FFT_SIZE;
    for (let i = 0; i < FFT_SIZE; i++) {
      const index = start + i;
      const sample = index >= 0 && index < mono.length ? mono[index] : 0;
      timeDomain[i] = Math.max(0, Math.min(255, Math.round(sample * 128 + 128)));
      re[i] = sample * window[i];
      im[i] = 0;
    }
    fft(re, im);
    for (let k = 0; k < bins; k++) {
      const magnitude = Math.hypot(re[k], im[k]) / FFT_SIZE;
      smoothed[k] = SMOOTHING * smoothed[k] + (1 - SMOOTHING) * magnitude;
      const db = smoothed[k] > 0 ? 20 * Math.log10(smoothed[k]) : -Infinity;
      const scaled = Math.round((255 * (db - MIN_DECIBELS)) / range);
      frequency[k] = Math.max(0, Math.min(255, Number.isFinite(scaled) ? scaled : 0));
    }
    return { frequency, timeDomain };
  };
}

/**
 * 百分位。渡した配列をその場で並べ替えるので、呼んだあとの中身は元の順序ではない。
 * 曲の長さぶんの配列を帯域の数だけ複製すると、それだけで数十MBになる。
 */
function percentileInPlace(values: Float32Array, ratio: number) {
  if (values.length === 0) return 0;
  values.sort();
  return values[Math.min(values.length - 1, Math.floor(ratio * values.length))];
}

/**
 * 曲全体を走査して、リングの基準を作る。
 * デコードを含めて 3 分の曲で 1 秒弱。読み込み時に一度だけ実行する。
 */
export async function analyseTrack(audioData: ArrayBuffer): Promise<RingCalibration> {
  const context = new AudioContext();
  let decoded: AudioBuffer;
  try {
    decoded = await context.decodeAudioData(audioData.slice(0));
  } finally {
    await context.close();
  }

  const left = decoded.getChannelData(0);
  const right = decoded.numberOfChannels > 1 ? decoded.getChannelData(1) : left;
  const mono = new Float32Array(left.length);
  for (let i = 0; i < mono.length; i++) mono[i] = (left[i] + right[i]) / 2;

  const analyse = createAnalyserEmulation(mono);
  const step = decoded.sampleRate / ANALYSIS_FPS;
  const frames = Math.max(1, Math.floor(mono.length / step));

  const rms = new Float32Array(frames);
  const detailPeak = new Float32Array(frames);
  const bandValues: Float32Array[] = [];
  for (let i = 0; i < BAND_COUNT; i++) bandValues.push(new Float32Array(frames));

  const bands = new Float32Array(BAND_COUNT);
  for (let f = 0; f < frames; f++) {
    const { frequency, timeDomain } = analyse(Math.round(f * step) + FFT_SIZE);
    const wave = measureWave(timeDomain);
    rms[f] = wave.rms;
    detailPeak[f] = wave.peak;
    sampleBands(frequency, bands);
    for (let i = 0; i < BAND_COUNT; i++) bandValues[i][f] = bands[i];
  }

  const bandPeak = new Float32Array(BAND_COUNT);
  const bandAverage = new Float32Array(BAND_COUNT);
  for (let i = 0; i < BAND_COUNT; i++) {
    // 並べ替えで順序が壊れるので、山を取るのは最後。
    const values = bandValues[i];
    const peak = percentileInPlace(values, REFERENCE_PERCENTILE);
    bandPeak[i] = peak;
    // 描画側と同じ正規化をしたうえでの平均。1 フレーム目の上振れが
    // 跳ねないよう、これを bandAverage の初期値にする。
    // 平均は順序に依存しないので、並べ替えたあとでも同じ値になる。
    const divisor = Math.max(peak, BAND_PEAK_FLOOR);
    let total = 0;
    for (let f = 0; f < frames; f++) total += Math.min(1, values[f] / divisor);
    bandAverage[i] = total / frames;
  }

  return {
    reference: percentileInPlace(rms, REFERENCE_PERCENTILE),
    detailReference: percentileInPlace(detailPeak, REFERENCE_PERCENTILE),
    bandPeak,
    bandAverage,
  };
}
