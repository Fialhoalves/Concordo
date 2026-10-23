#!/usr/bin/env node
'use strict';
// Gera src/renderer/icons.js a partir dos SVGs de src/renderer/assets/icons/*.svg.
// Para trocar um ícone, substitua o arquivo .svg (24x24, traço com currentColor) e rode: npm run icons
const fs = require('node:fs');
const path = require('node:path');

const dir = path.join(__dirname, '..', 'src', 'renderer', 'assets', 'icons');
const out = path.join(__dirname, '..', 'src', 'renderer', 'icons.js');
const map = {};
for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.svg')).sort()) {
  const svg = fs.readFileSync(path.join(dir, file), 'utf8');
  const inner = svg.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '').trim();
  if (/<script|on\w+=/i.test(inner)) throw new Error(`${file}: conteúdo não permitido`);
  map[path.basename(file, '.svg')] = inner;
}

const body = `/* ARQUIVO GERADO por tools/build-icons.js a partir de assets/icons/*.svg. Não edite à mão. */
(function (root) {
  'use strict';
  const SVGS = ${JSON.stringify(map, null, 2)};
  const NS = 'http://www.w3.org/2000/svg';

  // icon('microphone', { size: 20, class: 'x' }) -> <svg> pronto, que herda a cor do texto (currentColor)
  function icon(name, opts) {
    const o = opts || {};
    const inner = SVGS[name];
    const size = o.size || 20;
    const doc = new DOMParser().parseFromString(
      '<svg xmlns="' + NS + '" viewBox="0 0 24 24" width="' + size + '" height="' + size + '" fill="none" stroke="currentColor" ' +
        'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' + (inner || '') + '</svg>',
      'image/svg+xml',
    );
    const el = document.importNode(doc.documentElement, true);
    el.setAttribute('class', 'icon' + (o.class ? ' ' + o.class : ''));
    return el;
  }

  root.ConcordoIcons = { icon, names: Object.keys(SVGS) };
})(window);
`;
fs.writeFileSync(out, body);
console.log(`icons.js: ${Object.keys(map).length} ícones`);
