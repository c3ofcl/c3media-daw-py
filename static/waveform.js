// ===== 波形表示用のユーティリティ(DOMに依存しない純粋な計算と描画) =====
//
// 流れ:
//   1. computePeaks(audioBuffer)   デコード済み音声から「一定サンプルごとの最小/最大」を作る(ファイルごとに1回)
//   2. drawPeaks(ctx, peaks, opts) 指定した時間範囲・ズーム率で、Canvasへ縦線を並べて波形を描く
//
// 描画のたびに生のサンプル(数百万個)を走査すると、トリミング中など頻繁に再描画される場面で重くなる。
// そこで最初にピークを作り、さらに「2個ずつまとめて粗くした段階(ピラミッド)」を重ねて持っておく。
// 描画時は1ピクセルあたりのサンプル数に合った段階を選ぶので、描画の手間は
// 曲の長さではなく表示幅(ピクセル数)にしか比例しない。

(function () {
  const BASE_SAMPLES_PER_BUCKET = 64; // 最も細かい段階での、1個のピークがまとめるサンプル数
  const MAX_LEVELS = 24;

  // AudioBuffer(または同じ形のオブジェクト)から、最小/最大のピークのピラミッドを作る。
  // 複数チャンネルは、チャンネルをまたいだ最小・最大でまとめる(モノラルの輪郭として描く)。
  function computePeaks(buffer) {
    const len = buffer.length;
    const channels = buffer.numberOfChannels;
    const n = Math.max(1, Math.ceil(len / BASE_SAMPLES_PER_BUCKET));
    const mins = new Float32Array(n).fill(Infinity);
    const maxs = new Float32Array(n).fill(-Infinity);

    for (let c = 0; c < channels; c++) {
      const data = buffer.getChannelData(c);
      for (let b = 0; b < n; b++) {
        const start = b * BASE_SAMPLES_PER_BUCKET;
        const end = Math.min(len, start + BASE_SAMPLES_PER_BUCKET);
        let mn = mins[b];
        let mx = maxs[b];
        for (let i = start; i < end; i++) {
          const v = data[i];
          if (v < mn) mn = v;
          if (v > mx) mx = v;
        }
        mins[b] = mn;
        maxs[b] = mx;
      }
    }
    // 長さ0など、サンプルが1つも無かった箇所は無音(0)として扱う
    for (let b = 0; b < n; b++) {
      if (!Number.isFinite(mins[b])) mins[b] = 0;
      if (!Number.isFinite(maxs[b])) maxs[b] = 0;
    }

    const levels = [{ spb: BASE_SAMPLES_PER_BUCKET, n, mins, maxs }];
    while (levels[levels.length - 1].n > 1 && levels.length < MAX_LEVELS) {
      const prev = levels[levels.length - 1];
      const m = Math.ceil(prev.n / 2);
      const nextMins = new Float32Array(m);
      const nextMaxs = new Float32Array(m);
      for (let i = 0; i < m; i++) {
        const a = 2 * i;
        const b = a + 1;
        nextMins[i] = b < prev.n ? Math.min(prev.mins[a], prev.mins[b]) : prev.mins[a];
        nextMaxs[i] = b < prev.n ? Math.max(prev.maxs[a], prev.maxs[b]) : prev.maxs[a];
      }
      levels.push({ spb: prev.spb * 2, n: m, mins: nextMins, maxs: nextMaxs });
    }
    return { sampleRate: buffer.sampleRate, levels };
  }

  // ピークを Canvas(2D)へ描く。幅・高さはCanvas上のピクセル単位(高解像度画面ではCSSピクセルの倍)。
  //   startSec : このCanvasの左端が、元の音声ファイルの何秒目に当たるか
  //   secPerPx : Canvasの1ピクセルが何秒分か(ズーム率が高いほど小さい)
  //   width/height : Canvasのピクセル数
  //   color    : 波形の塗りつぶし色
  function drawPeaks(ctx, peaks, opts) {
    const { startSec, secPerPx, width, height, color } = opts;
    const sampleRate = peaks.sampleRate;
    const samplesPerPx = sampleRate * secPerPx;
    const levels = peaks.levels;

    // 「1ピクセル >= 1ピーク」になる範囲で、最も粗い段階を選ぶ(1ピクセルあたり1〜2個のピークを見れば済む)
    let lv = 0;
    while (lv + 1 < levels.length && levels[lv + 1].spb <= samplesPerPx) lv++;
    const L = levels[lv];

    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = color;
    const mid = height / 2;
    const amp = (height / 2) * 0.9; // 上下に少し余白を残す

    for (let x = 0; x < width; x++) {
      const s0 = (startSec + x * secPerPx) * sampleRate;
      let i0 = Math.floor(s0 / L.spb);
      if (i0 >= L.n) break; // 音声データの終わりを過ぎた
      if (i0 < 0) i0 = 0;
      let i1 = Math.ceil((s0 + samplesPerPx) / L.spb);
      if (i1 <= i0) i1 = i0 + 1;
      if (i1 > L.n) i1 = L.n;

      let mn = Infinity;
      let mx = -Infinity;
      for (let i = i0; i < i1; i++) {
        if (L.mins[i] < mn) mn = L.mins[i];
        if (L.maxs[i] > mx) mx = L.maxs[i];
      }
      mx = Math.min(1, mx);
      mn = Math.max(-1, mn);
      const top = mid - mx * amp;
      const bottom = mid - mn * amp;
      // 無音でも中心に細い線が出るよう、最低1ピクセルの高さを確保する
      ctx.fillRect(x, top, 1, Math.max(1, bottom - top));
    }
  }

  globalThis.Waveform = { computePeaks, drawPeaks };
})();
