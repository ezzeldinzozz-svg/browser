'use strict';

// Minimal, zero-dependency QR Code generator (Byte mode, ECC Level L, Versions 1–10, up to 271 bytes).
// Returns an SVG string for any URL.

const CAPACITIES = [0, 17, 32, 53, 78, 106, 134, 154, 192, 230, 271];
const EC_CW = [0, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18];
const BLOCKS = [0, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4];
const ALIGN = [
  [],
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
];

// GF(256) log/exp tables with primitive polynomial 0x11d
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x = (x << 1) ^ (x & 128 ? 0x11d : 0);
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

function rsEncode(data, ecLen) {
  let gen = new Uint8Array([1]);
  for (let i = 0; i < ecLen; i++) {
    const next = new Uint8Array(gen.length + 1);
    for (let j = 0; j < gen.length; j++) {
      next[j] ^= gen[j];
      next[j + 1] ^= gen[j] ? EXP[LOG[gen[j]] + i] : 0;
    }
    gen = next;
  }
  const rem = new Uint8Array(ecLen);
  for (const b of data) {
    const factor = b ^ rem[0];
    rem.copyWithin(0, 1);
    rem[ecLen - 1] = 0;
    if (factor) {
      for (let j = 0; j < ecLen; j++) {
        if (gen[j + 1]) rem[j] ^= EXP[LOG[gen[j + 1]] + LOG[factor]];
      }
    }
  }
  return rem;
}

function encode(text) {
  const bytes = Buffer.from(String(text || ''), 'utf8');
  let ver = 1;
  while (ver <= 10 && bytes.length > CAPACITIES[ver]) ver++;
  if (ver > 10) return null;

  const size = 17 + ver * 4;
  const totalData = CAPACITIES[ver] + (ver <= 9 ? 2 : 3);
  const bits = [];
  const pushBits = (val, len) => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1);
  };
  pushBits(0b0100, 4); // Byte mode
  pushBits(bytes.length, ver <= 9 ? 8 : 16);
  for (const b of bytes) pushBits(b, 8);
  for (let i = 0; i < 4 && bits.length < totalData * 8; i++) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);

  const dataCw = new Uint8Array(totalData);
  for (let i = 0; i < bits.length / 8; i++) {
    let v = 0;
    for (let b = 0; b < 8; b++) v = (v << 1) | bits[i * 8 + b];
    dataCw[i] = v;
  }
  for (let i = bits.length / 8, p = 0; i < totalData; i++, p ^= 1) {
    dataCw[i] = p ? 0x11 : 0xec;
  }

  const numBlocks = BLOCKS[ver];
  const ecLen = EC_CW[ver];
  const shortLen = Math.floor(totalData / numBlocks);
  const numShort = numBlocks - (totalData % numBlocks);
  const dataBlocks = [];
  const ecBlocks = [];
  let offset = 0;
  for (let b = 0; b < numBlocks; b++) {
    const len = shortLen + (b < numShort ? 0 : 1);
    const block = dataCw.subarray(offset, offset + len);
    offset += len;
    dataBlocks.push(block);
    ecBlocks.push(rsEncode(block, ecLen));
  }

  const finalBits = [];
  const maxDataLen = shortLen + (numShort < numBlocks ? 1 : 0);
  for (let i = 0; i < maxDataLen; i++) {
    for (let b = 0; b < numBlocks; b++) {
      if (i < dataBlocks[b].length) pushBits.call({ push: (x) => finalBits.push(x) }, dataBlocks[b][i], 8);
    }
  }
  // Wait: pushBits uses bits array above, let's push directly to finalBits
  finalBits.length = 0;
  const pushFinal = (val) => {
    for (let i = 7; i >= 0; i--) finalBits.push((val >> i) & 1);
  };
  for (let i = 0; i < maxDataLen; i++) {
    for (let b = 0; b < numBlocks; b++) if (i < dataBlocks[b].length) pushFinal(dataBlocks[b][i]);
  }
  for (let i = 0; i < ecLen; i++) {
    for (let b = 0; b < numBlocks; b++) pushFinal(ecBlocks[b][i]);
  }

  const grid = Array.from({ length: size }, () => new Uint8Array(size));
  const reserved = Array.from({ length: size }, () => new Uint8Array(size));
  const set = (r, c, v) => {
    if (r >= 0 && r < size && c >= 0 && c < size) {
      grid[r][c] = v ? 1 : 0;
      reserved[r][c] = 1;
    }
  };

  const finder = (r0, c0) => {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const inOuter = r >= 0 && r <= 6 && c >= 0 && c <= 6;
        const onBorder = r === 0 || r === 6 || c === 0 || c === 6;
        const inInner = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        set(r0 + r, c0 + c, inOuter && (onBorder || inInner));
      }
    }
  };
  finder(0, 0);
  finder(0, size - 7);
  finder(size - 7, 0);

  for (let i = 8; i < size - 8; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }

  const align = ALIGN[ver];
  for (const r of align) {
    for (const c of align) {
      if (reserved[r][c]) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          set(r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
        }
      }
    }
  }

  for (let i = 0; i < 9; i++) {
    if (i !== 6) {
      reserved[8][i] = 1;
      reserved[i][8] = 1;
    }
    if (i < 8) {
      reserved[8][size - 1 - i] = 1;
      reserved[size - 1 - i][8] = 1;
    }
  }
  set(size - 8, 8, 1);
  if (ver >= 7) {
    for (let i = 0; i < 6; i++) {
      for (let j = 0; j < 3; j++) {
        reserved[i][size - 11 + j] = 1;
        reserved[size - 11 + j][i] = 1;
      }
    }
  }

  let bitIdx = 0;
  let up = true;
  for (let col = size - 1; col >= 1; col -= 2) {
    if (col === 6) col--;
    for (let step = 0; step < size; step++) {
      const r = up ? size - 1 - step : step;
      for (let dc = 0; dc < 2; dc++) {
        const c = col - dc;
        if (!reserved[r][c]) {
          const bit = bitIdx < finalBits.length ? finalBits[bitIdx++] : 0;
          grid[r][c] = bit ^ ((r + c) % 2 === 0 ? 1 : 0); // Mask 0
        }
      }
    }
    up = !up;
  }

  // Format info for Level L (01), Mask 0 (000) -> 0x77c4
  const fmt = 0x77c4;
  const fbits = [];
  for (let i = 0; i < 15; i++) fbits.push((fmt >> i) & 1);
  const fPos1 = [
    [8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8],
    [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8],
  ];
  for (let i = 0; i < 15; i++) {
    grid[fPos1[i][0]][fPos1[i][1]] = fbits[14 - i];
    if (i < 7) grid[size - 1 - i][8] = fbits[14 - i];
    else grid[8][size - 15 + i] = fbits[14 - i];
  }

  if (ver >= 7) {
    let vinfo = ver << 12;
    for (let i = 5; i >= 0; i--) if ((vinfo >> (i + 12)) & 1) vinfo ^= 0x1f25 << i;
    const vbits = (ver << 12) | vinfo;
    for (let i = 0; i < 18; i++) {
      const bit = (vbits >> i) & 1;
      const r = Math.floor(i / 3);
      const c = size - 11 + (i % 3);
      grid[r][c] = bit;
      grid[c][r] = bit;
    }
  }

  return grid;
}

function svg(text) {
  const grid = encode(text);
  if (!grid) return null;
  const n = grid.length;
  const pad = 2;
  const total = n + pad * 2;
  let path = '';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (grid[r][c]) path += `M${c + pad},${r + pad}h1v1h-1z`;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges"><rect width="${total}" height="${total}" rx="2" fill="#fff"/><path d="${path}" fill="#0c0a11"/></svg>`;
}

module.exports = { svg, encode };
