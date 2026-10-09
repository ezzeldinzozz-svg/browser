'use strict';

// Address bar answers: arithmetic ("12*7+3"), unit conversions ("10 km in miles") and commands
// ("settings", "clear history"). Pure functions; main.js puts the result in the suggestions.

// ---- arithmetic: + - * / % ^ and parentheses, without eval
function calculate(text) {
  const src = text.replace(/\s+/g, '').replace(/×/g, '*').replace(/÷/g, '/').replace(/,/g, '');
  if (!/^[\d.+\-*/%^()]+$/.test(src) || !/\d[+\-*/%^]|\)[+\-*/%^(]|\d\(/.test(src)) return null;
  let i = 0;
  const peek = () => src[i];
  function number() {
    const m = src.slice(i).match(/^\d*\.?\d+(?:e[+-]?\d+)?/i);
    if (!m) throw new Error('number');
    i += m[0].length;
    return parseFloat(m[0]);
  }
  function factor() {
    if (peek() === '-') { i++; return -factor(); }
    if (peek() === '+') { i++; return factor(); }
    let v;
    if (peek() === '(') {
      i++;
      v = expr();
      if (peek() !== ')') throw new Error(')');
      i++;
    } else v = number();
    if (peek() === '^') { i++; v = Math.pow(v, factor()); }
    return v;
  }
  function term() {
    let v = factor();
    while (peek() === '*' || peek() === '/' || peek() === '%' || peek() === '(') {
      const op = peek() === '(' ? '*' : src[i++];
      const r = factor();
      v = op === '*' ? v * r : op === '/' ? v / r : v % r;
    }
    return v;
  }
  function expr() {
    let v = term();
    while (peek() === '+' || peek() === '-') v = src[i++] === '+' ? v + term() : v - term();
    return v;
  }
  try {
    const v = expr();
    if (i !== src.length || !Number.isFinite(v)) return null;
    return format(v);
  } catch {
    return null;
  }
}

const format = (v) => (Math.abs(v) >= 1e15 || (Math.abs(v) < 1e-6 && v !== 0) ? v.toExponential(6) : String(+v.toPrecision(12)));

// ---- unit conversion
const UNITS = {
  length: { m: 1, meter: 1, meters: 1, metre: 1, km: 1000, kilometer: 1000, kilometers: 1000, cm: 0.01, mm: 0.001, mi: 1609.344, mile: 1609.344, miles: 1609.344, yd: 0.9144, yard: 0.9144, yards: 0.9144, ft: 0.3048, foot: 0.3048, feet: 0.3048, in: 0.0254, inch: 0.0254, inches: 0.0254 },
  mass: { kg: 1, kilogram: 1, kilograms: 1, g: 0.001, gram: 0.001, grams: 0.001, lb: 0.45359237, lbs: 0.45359237, pound: 0.45359237, pounds: 0.45359237, oz: 0.028349523, ounce: 0.028349523, ounces: 0.028349523, t: 1000, ton: 1000, tons: 1000 },
  volume: { l: 1, liter: 1, liters: 1, litre: 1, ml: 0.001, gal: 3.785411784, gallon: 3.785411784, gallons: 3.785411784, cup: 0.2365882, cups: 0.2365882, floz: 0.0295735 },
  speed: { kmh: 1, kph: 1, mph: 1.609344, 'm/s': 3.6, ms: 3.6, knot: 1.852, knots: 1.852 },
};
const TEMPS = { c: 'C', celsius: 'C', '°c': 'C', f: 'F', fahrenheit: 'F', '°f': 'F', k: 'K', kelvin: 'K' };

function convert(text) {
  const m = text.trim().toLowerCase().match(/^(-?\d+(?:[.,]\d+)?)\s*([a-z°/]+)\s+(?:in|to|as)\s+([a-z°/]+)$/);
  if (!m) return null;
  const value = parseFloat(m[1].replace(',', '.'));
  const [from, to] = [m[2], m[3]];
  if (TEMPS[from] && TEMPS[to]) {
    const c = TEMPS[from] === 'C' ? value : TEMPS[from] === 'F' ? ((value - 32) * 5) / 9 : value - 273.15;
    const out = TEMPS[to] === 'C' ? c : TEMPS[to] === 'F' ? (c * 9) / 5 + 32 : c + 273.15;
    return `${format(+out.toFixed(2))} °${TEMPS[to]}`;
  }
  for (const table of Object.values(UNITS)) {
    if (table[from] && table[to]) return `${format(+((value * table[from]) / table[to]).toPrecision(6))} ${to}`;
  }
  return null;
}

// ---- commands
const COMMANDS = [
  { id: 'settings', label: 'Open Settings', words: ['settings', 'preferences', 'options'] },
  { id: 'history', label: 'Open History', words: ['history'] },
  { id: 'downloads', label: 'Open Downloads', words: ['downloads'] },
  { id: 'bookmarks', label: 'Open Bookmark Manager', words: ['bookmarks', 'bookmark manager'] },
  { id: 'extensions', label: 'Manage Extensions', words: ['extensions', 'addons', 'add-ons'] },
  { id: 'clear', label: 'Clear Browsing Data…', words: ['clear history', 'clear browsing data', 'clear cache', 'clear cookies', 'delete history'] },
  { id: 'private', label: 'New Private Window', words: ['private', 'incognito', 'new private window'] },
  { id: 'tasks', label: 'Open Task Manager', words: ['task manager', 'tasks'] },
  { id: 'whatsnew', label: "What's New in Operecs", words: ["what's new", 'whats new', 'release notes', 'changelog'] },
  { id: 'shortcuts', label: 'Keyboard Shortcuts', words: ['shortcuts', 'keyboard shortcuts'] },
];

function command(text) {
  const q = text.trim().toLowerCase();
  if (q.length < 3) return null;
  return COMMANDS.find((c) => c.words.some((w) => w === q || (q.length >= 4 && w.startsWith(q)))) || null;
}

function answer(text) {
  const calc = calculate(text);
  if (calc !== null) return { kind: 'answer', text: calc, title: `= ${calc}` };
  const conv = convert(text);
  if (conv) return { kind: 'answer', text: conv.split(' ')[0], title: `= ${conv}` };
  return null;
}

module.exports = { answer, command, calculate, convert };
