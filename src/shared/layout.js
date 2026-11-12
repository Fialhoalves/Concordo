// Grade do palco de vídeo: para N quadros num espaço W×H, escolhe quantas colunas e linhas deixam
// os quadros (na proporção pedida, 16:9 por padrão) com a maior área possível.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ConcordoLayout = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  function bestGrid(n, width, height, { gap = 10, ratio = 16 / 9 } = {}) {
    const count = Math.max(0, Math.floor(n) || 0);
    const W = Math.max(0, Number(width) || 0);
    const H = Math.max(0, Number(height) || 0);
    if (!count || !W || !H) return { cols: 1, rows: 1, w: 0, h: 0 };
    // um quadro só usa o espaço inteiro (o vídeo se ajusta dentro dele)
    if (count === 1) return { cols: 1, rows: 1, w: Math.floor(W), h: Math.floor(H) };
    let best = null;
    for (let cols = 1; cols <= count; cols++) {
      const rows = Math.ceil(count / cols);
      const cellW = (W - gap * (cols - 1)) / cols;
      const cellH = (H - gap * (rows - 1)) / rows;
      if (cellW <= 0 || cellH <= 0) continue;
      const w = Math.min(cellW, cellH * ratio);
      if (!best || w > best.w + 0.01) best = { cols, rows, w, h: w / ratio };
    }
    if (!best) return { cols: 1, rows: count, w: 0, h: 0 };
    return { cols: best.cols, rows: best.rows, w: Math.floor(best.w), h: Math.floor(best.h) };
  }

  return { bestGrid };
});
