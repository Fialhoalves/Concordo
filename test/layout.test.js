'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { bestGrid } = require('../src/shared/layout');

const fits = (n, W, H, g, gap = 10) => {
  assert.ok(g.cols * g.rows >= n, 'cabe todo mundo');
  assert.ok(g.cols * g.w + gap * (g.cols - 1) <= W + 1, 'não passa da largura');
  assert.ok(g.rows * g.h + gap * (g.rows - 1) <= H + 1, 'não passa da altura');
};

test('um quadro só usa o espaço inteiro', () => {
  assert.deepEqual(bestGrid(1, 1200, 700), { cols: 1, rows: 1, w: 1200, h: 700 });
});

test('duas telas ficam lado a lado em janela larga e empilhadas em janela alta', () => {
  const wide = bestGrid(2, 1600, 600);
  assert.equal(wide.cols, 2);
  assert.equal(wide.rows, 1);
  const tall = bestGrid(2, 700, 1000);
  assert.equal(tall.cols, 1);
  assert.equal(tall.rows, 2);
});

test('os quadros saem em 16:9 e cabem no espaço, de 2 a 12', () => {
  for (const [W, H] of [[1300, 700], [800, 900], [500, 300], [1920, 1000]]) {
    for (let n = 2; n <= 12; n++) {
      const g = bestGrid(n, W, H);
      fits(n, W, H, g);
      assert.ok(Math.abs(g.w / g.h - 16 / 9) < 0.05, `proporção com n=${n} em ${W}x${H}`);
    }
  }
});

test('seis quadros numa janela larga viram 3x2, e não 5+1', () => {
  const g = bestGrid(6, 1600, 700);
  assert.equal(g.cols, 3);
  assert.equal(g.rows, 2);
});

test('entradas inválidas não quebram', () => {
  assert.deepEqual(bestGrid(0, 100, 100), { cols: 1, rows: 1, w: 0, h: 0 });
  assert.deepEqual(bestGrid(3, 0, 0), { cols: 1, rows: 1, w: 0, h: 0 });
});
