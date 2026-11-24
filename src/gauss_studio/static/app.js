/* ============================================================
   GAUSS STUDIO — front-end
   Exact arithmetic previews + asynchronous Python engine.
   ============================================================ */

'use strict';

/* ---------- tiny helpers ---------- */

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

const REDUCED_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const TOUCH_DEVICE = window.matchMedia('(pointer: coarse)').matches;
const STORAGE_KEY = 'gauss-studio:board:v1';
const SOUND_KEY = 'gauss-studio:sound';
const SEEN_KEY = 'gauss-studio:seen';
const MAX_HISTORY_STORED = 80;
const API = '/api';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, REDUCED_MOTION ? 0 : ms));
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const pad2 = (value) => String(value).padStart(2, '0');

function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character]);
}

function plural(number, one, few, many) {
  const n = Math.abs(number) % 100;
  const n1 = n % 10;
  if (n > 10 && n < 20) return many;
  if (n1 > 1 && n1 < 5) return few;
  if (n1 === 1) return one;
  return many;
}

function cloneMatrix(matrix) {
  return matrix.map((row) => row.slice());
}

/* ---------- exact fractions ---------- */

function bigAbs(value) {
  return value < 0n ? -value : value;
}

function bigGcd(a, b) {
  a = bigAbs(a);
  b = bigAbs(b);
  while (b) {
    const next = a % b;
    a = b;
    b = next;
  }
  return a || 1n;
}

class Frac {
  constructor(numerator = 0n, denominator = 1n) {
    let n = typeof numerator === 'bigint' ? numerator : BigInt(numerator);
    let d = typeof denominator === 'bigint' ? denominator : BigInt(denominator);
    if (d === 0n) throw new Error('zero denominator');
    if (d < 0n) {
      n = -n;
      d = -d;
    }
    const divisor = bigGcd(n, d);
    this.n = n / divisor;
    this.d = d / divisor;
  }

  static of(numerator, denominator = 1n) {
    return new Frac(numerator, denominator);
  }

  static parse(raw, { emptyZero = false } = {}) {
    let text = String(raw ?? '')
      .trim()
      .replace(/[−–—]/g, '-')
      .replace(/,/g, '.')
      .replace(/\s+/g, ' ');

    if (!text) return emptyZero ? new Frac(0n) : null;
    if (text.length > 32) return null;

    try {
      const mixed = text.match(/^([+-]?\d+)\s+(\d+)\/(\d+)$/);
      if (mixed) {
        const sign = mixed[1].startsWith('-') ? -1n : 1n;
        const whole = bigAbs(BigInt(mixed[1]));
        const numerator = BigInt(mixed[2]);
        const denominator = BigInt(mixed[3]);
        if (denominator === 0n) return null;
        const value = new Frac(sign * (whole * denominator + numerator), denominator);
        return Frac.valid(value) ? value : null;
      }

      const slash = text.match(/^([+-]?\d+)\/([+-]?\d+)$/);
      if (slash) {
        if (BigInt(slash[2]) === 0n) return null;
        const value = new Frac(BigInt(slash[1]), BigInt(slash[2]));
        return Frac.valid(value) ? value : null;
      }

      const decimal = text.match(/^([+-]?)(\d+)(?:\.(\d+))?$/);
      if (decimal) {
        const fractionPart = decimal[3] || '';
        const digits = decimal[2] + fractionPart;
        const denominator = 10n ** BigInt(fractionPart.length);
        let numerator = BigInt(digits);
        if (decimal[1] === '-') numerator = -numerator;
        const value = new Frac(numerator, denominator);
        return Frac.valid(value) ? value : null;
      }
    } catch (error) {
      return null;
    }
    return null;
  }

  static valid(value) {
    return bigAbs(value.n) <= 10n ** 12n && value.d <= 10n ** 12n;
  }

  add(other) {
    return new Frac(this.n * other.d + other.n * this.d, this.d * other.d);
  }

  sub(other) {
    return new Frac(this.n * other.d - other.n * this.d, this.d * other.d);
  }

  mul(other) {
    return new Frac(this.n * other.n, this.d * other.d);
  }

  div(other) {
    return new Frac(this.n * other.d, this.d * other.n);
  }

  neg() {
    return new Frac(-this.n, this.d);
  }

  abs() {
    return new Frac(bigAbs(this.n), this.d);
  }

  isZero() {
    return this.n === 0n;
  }

  isOne() {
    return this.n === 1n && this.d === 1n;
  }

  equals(other) {
    return this.n === other.n && this.d === other.d;
  }

  toString() {
    return this.d === 1n ? String(this.n) : `${this.n}/${this.d}`;
  }

  plain() {
    const negative = this.n < 0n;
    const body = this.d === 1n
      ? String(bigAbs(this.n))
      : `${bigAbs(this.n)}/${this.d}`;
    return negative ? `−${body}` : body;
  }
}

const ZERO = new Frac(0n);
const ONE = new Frac(1n);

function fractionHTML(value) {
  const negative = value.n < 0n;
  const n = bigAbs(value.n);
  const body = value.d === 1n
    ? `<span class="int">${n}</span>`
    : `<span class="frac"><span class="num">${n}</span><span class="den">${value.d}</span></span>`;
  return negative
    ? `<span class="value-negative"><span class="sign">−</span>${body}</span>`
    : body;
}

function fractionInline(value) {
  return `<span class="inline-frac">${fractionHTML(value)}</span>`;
}

function prettyValue(raw) {
  const parsed = Frac.parse(raw, { emptyZero: true });
  return parsed ? parsed.plain() : String(raw);
}

function matrixToFractions(matrix) {
  return matrix.map((row) => row.map((cell) => Frac.parse(cell, { emptyZero: true }) || ZERO));
}

function determinantOf(matrix) {
  const size = matrix.length;
  if (!size) return ZERO;
  const work = matrixToFractions(matrix);
  let determinant = ONE;
  for (let column = 0; column < size; column += 1) {
    let pivot = column;
    while (pivot < size && work[pivot][column].isZero()) pivot += 1;
    if (pivot === size) return ZERO;
    if (pivot !== column) {
      [work[column], work[pivot]] = [work[pivot], work[column]];
      determinant = determinant.neg();
    }
    const pivotValue = work[column][column];
    determinant = determinant.mul(pivotValue);
    for (let row = column + 1; row < size; row += 1) {
      if (work[row][column].isZero()) continue;
      const factor = work[row][column].div(pivotValue);
      for (let index = column; index < size; index += 1) {
        work[row][index] = work[row][index].sub(factor.mul(work[column][index]));
      }
    }
  }
  return determinant;
}

/* ---------- DOM references ---------- */

const dom = {
  body: document.body,
  matrix: $('#matrix'),
  matrixScroll: $('#matrixScroll'),
  matrixCard: $('#matrixCard'),
  flowOverlay: $('#flowOverlay'),
  flowPath: $('#flowPath'),
  boardIndex: $('#boardIndex'),
  presetName: $('#presetName'),
  remainingMoves: $('#remainingMoves'),
  remainingWord: $('#remainingWord'),
  progressBar: $('#progressBar'),
  progressTrack: $('.progress-track'),
  missionHint: $('#missionHint'),
  selectionLegend: $('#selectionLegend'),
  clearSelectionBtn: $('#clearSelectionBtn'),
  undoBtn: $('#undoBtn'),
  redoBtn: $('#redoBtn'),
  resetBtn: $('#resetBtn'),
  soundBtn: $('#soundBtn'),
  helpBtn: $('#helpBtn'),
  newBtn: $('#newBtn'),
  previewBar: $('#previewBar'),
  previewCaption: $('#previewCaption'),
  previewValues: $('#previewValues'),
  matrixSize: $('#matrixSize'),
  matrixKind: $('#matrixKind'),
  stageTitleLead: $('#stageTitleLead'),
  stageTitleAccent: $('#stageTitleAccent'),
  statusPanelTitle: $('#statusPanelTitle'),
  rankLabel: $('#rankLabel'),
  freeLabel: $('#freeLabel'),
  zeroLabel: $('#zeroLabel'),
  rhsToggleControl: $('#rhsToggleControl'),
  rhsColsControl: $('#rhsColsControl'),
  rhsColsCount: $('#rhsColsCount'),
  inverseNote: $('#inverseNote'),
  equationNote: $('#equationNote'),
  newModalTitle: $('#newModalTitle'),
  opTabs: $$('.op-tab'),
  factorField: $('#factorField'),
  factorInput: $('#factorInput'),
  factorDown: $('#factorDown'),
  factorUp: $('#factorUp'),
  factorQuick: $('#factorQuick'),
  expression: $('#expression'),
  applyBtn: $('#applyBtn'),
  applyLabel: $('#applyLabel'),
  dockHint: $('#dockHint'),
  statusPill: $('#statusPill'),
  rankValue: $('#rankValue'),
  freeValue: $('#freeValue'),
  zeroValue: $('#zeroValue'),
  pivotMap: $('#pivotMap'),
  solutionSlot: $('#solutionSlot'),
  hintBtn: $('#hintBtn'),
  hintSlot: $('#hintSlot'),
  historyList: $('#historyList'),
  historyCount: $('#historyCount'),
  badgeGrid: $('#badgeGrid'),
  collectionCount: $('#collectionCount'),
  newModal: $('#newModal'),
  helpModal: $('#helpModal'),
  varsCount: $('#varsCount'),
  rowsCount: $('#rowsCount'),
  varsLabel: $('#varsLabel'),
  rowsLabel: $('#rowsLabel'),
  augToggle: $('#augToggle'),
  matrixEditor: $('#matrixEditor'),
  presetList: $('#presetList'),
  randomBtn: $('#randomBtn'),
  createBoardBtn: $('#createBoardBtn'),
  winOverlay: $('#winOverlay'),
  winTitle: $('#winTitle'),
  winSub: $('#winSub'),
  winMatrix: $('#winMatrix'),
  winSolution: $('#winSolution'),
  winAchievements: $('#winAchievements'),
  nextChallengeBtn: $('#nextChallengeBtn'),
  stayBtn: $('#stayBtn'),
  toastStack: $('#toastStack'),
  confetti: $('#confetti'),
  footerVersion: $('#footerVersion'),
};

/* ---------- achievements ---------- */

const ACHIEVEMENTS = [
  { id: 'first-zero', icon: '◌', title: 'Первый ноль', description: 'обнулите элемент' },
  { id: 'triple', icon: '✦', title: 'Тройной удар', description: '3 нуля за ход' },
  { id: 'combo', icon: '⚡', title: 'Серия ×3', description: '3 хода подряд' },
  { id: 'finish', icon: '✓', title: 'Финиш', description: 'достигните цели' },
];

const OP_META = {
  subtract: { label: 'Вычесть', symbol: '−', preposition: 'из' },
  add: { label: 'Прибавить', symbol: '+', preposition: 'к' },
  swap: { label: 'Поменять', symbol: '⇄', preposition: '' },
  scale: { label: 'Умножить', symbol: '×', preposition: '' },
};

/* ---------- state ---------- */

function storedValue(key, fallback = null) {
  try {
    return window.localStorage.getItem(key) ?? fallback;
  } catch (error) {
    return fallback;
  }
}

function persistValue(key, value) {
  try {
    window.localStorage.setItem(key, value);
  } catch (error) {
    /* private mode / quota — the studio still works */
  }
}

const state = {
  matrix: [],
  augmented: 1,
  goal: 'echelon',
  analysis: null,
  presets: [],
  activePreset: 'classic',
  presetName: 'Классика 3×3',
  boardId: 0,
  selection: { source: null, target: null },
  op: 'subtract',
  factor: '1',
  factorFrac: ONE,
  history: [],
  historyIndex: 0,
  basePlan: 1,
  hint: null,
  inverseDeterminant: null,
  busy: false,
  autoplay: false,
  initialized: false,
  winShown: false,
  achievements: new Set(),
  stats: {
    streak: 0,
    totalOps: 0,
    hintsUsed: 0,
    hintThisBoard: false,
    undoThisBoard: false,
  },
  soundEnabled: storedValue(SOUND_KEY, '1') !== '0',
  editor: null,
  lastFocused: null,
  activeModal: null,
  persistTimer: null,
};

/* ---------- sound ---------- */

class SoundEngine {
  constructor() {
    this.context = null;
    this.enabled = state.soundEnabled;
  }

  setEnabled(enabled) {
    this.enabled = enabled;
  }

  ensure() {
    if (!this.enabled) return null;
    try {
      if (!this.context) {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextClass) return null;
        this.context = new AudioContextClass();
      }
      if (this.context.state === 'suspended') {
        this.context.resume().catch(() => {});
      }
      return this.context;
    } catch (error) {
      return null;
    }
  }

  tone(frequency, duration = 0.07, { type = 'sine', volume = 0.025, delay = 0, slide = 0 } = {}) {
    if (!this.enabled) return;
    const context = this.ensure();
    if (!context) return;
    try {
      const start = context.currentTime + delay;
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = type;
      oscillator.frequency.setValueAtTime(frequency, start);
      if (slide) {
        oscillator.frequency.exponentialRampToValueAtTime(slide, start + duration);
      }
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(volume, start + 0.008);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start(start);
      oscillator.stop(start + duration + 0.03);
    } catch (error) {
      /* audio is a garnish, never a blocker */
    }
  }

  click() {
    this.tone(760, 0.025, { type: 'triangle', volume: 0.012 });
  }

  move() {
    this.tone(390, 0.05, { type: 'sine', volume: 0.022, slide: 520 });
    this.tone(780, 0.035, { type: 'sine', volume: 0.01, delay: 0.03 });
  }

  zero(count) {
    const base = 540;
    const notes = [0, 4, 7];
    for (let i = 0; i < Math.min(3, Math.max(1, count)); i += 1) {
      this.tone(base * 2 ** (notes[i] / 12), 0.16, {
        type: 'sine',
        volume: 0.028,
        delay: i * 0.055,
        slide: base * 2 ** (notes[i] / 12) * 1.015,
      });
    }
  }

  error() {
    this.tone(160, 0.13, { type: 'triangle', volume: 0.025, slide: 110 });
  }

  undo() {
    this.tone(560, 0.06, { type: 'sine', volume: 0.018, slide: 380 });
  }

  win() {
    [523.25, 659.25, 783.99, 1046.5].forEach((frequency, index) => {
      this.tone(frequency, 0.5, {
        type: 'sine',
        volume: 0.03,
        delay: index * 0.1,
        slide: frequency * 1.003,
      });
    });
    this.tone(261.63, 0.8, { type: 'triangle', volume: 0.014, delay: 0.05 });
  }
}

const sfx = new SoundEngine();

/* ---------- confetti ---------- */

class Confetti {
  constructor(canvas) {
    this.canvas = canvas;
    this.context = canvas.getContext('2d');
    this.particles = [];
    this.animation = null;
    this.colors = ['#8e7dff', '#46e7d2', '#c9f56e', '#ffc66b', '#ff7b87', '#f3f4ff'];
    this.resize = this.resize.bind(this);
    this.frame = this.frame.bind(this);
    window.addEventListener('resize', this.resize);
    this.resize();
  }

  resize() {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.width = window.innerWidth;
    this.height = window.innerHeight;
    this.canvas.width = Math.floor(this.width * this.dpr);
    this.canvas.height = Math.floor(this.height * this.dpr);
  }

  burst(x, y, count = 18, power = 1) {
    if (REDUCED_MOTION) return;
    for (let i = 0; i < count; i += 1) {
      const angle = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 1.5;
      const speed = (2.4 + Math.random() * 5.2) * power;
      this.particles.push({
        x,
        y,
        vx: Math.cos(angle) * speed + (Math.random() - 0.5) * 2,
        vy: Math.sin(angle) * speed - Math.random() * 2,
        size: 2.5 + Math.random() * 5.5,
        color: this.colors[Math.floor(Math.random() * this.colors.length)],
        rotation: Math.random() * Math.PI,
        spin: (Math.random() - 0.5) * 0.28,
        life: 0,
        maxLife: 62 + Math.random() * 70,
        shape: Math.random() > 0.55 ? 'rect' : 'circle',
      });
    }
    if (!this.animation) {
      this.animation = requestAnimationFrame(this.frame);
    }
  }

  burstAt(element, count = 14, power = 1) {
    if (!element) {
      this.burst(this.width / 2, this.height / 2, count, power);
      return;
    }
    const rect = element.getBoundingClientRect();
    this.burst(rect.left + rect.width * 0.5, rect.top + rect.height * 0.5, count, power);
  }

  celebrate() {
    if (REDUCED_MOTION) return;
    this.burst(this.width * 0.5, this.height * 0.48, 110, 1.35);
    window.setTimeout(() => this.burst(this.width * 0.22, this.height * 0.42, 55, 1.1), 160);
    window.setTimeout(() => this.burst(this.width * 0.78, this.height * 0.4, 55, 1.1), 290);
  }

  frame() {
    const ctx = this.context;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);
    const alive = [];
    for (const particle of this.particles) {
      particle.life += 1;
      particle.vy += 0.075;
      particle.vx *= 0.994;
      particle.vy *= 0.994;
      particle.x += particle.vx;
      particle.y += particle.vy;
      particle.rotation += particle.spin;
      if (particle.life >= particle.maxLife) continue;
      const alpha = Math.max(0, 1 - particle.life / particle.maxLife);
      ctx.save();
      ctx.translate(particle.x, particle.y);
      ctx.rotate(particle.rotation);
      ctx.globalAlpha = alpha;
      ctx.fillStyle = particle.color;
      if (particle.shape === 'rect') {
        ctx.fillRect(-particle.size / 2, -particle.size / 4, particle.size, particle.size / 2);
      } else {
        ctx.beginPath();
        ctx.arc(0, 0, particle.size / 2.6, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
      alive.push(particle);
    }
    this.particles = alive;
    if (this.particles.length) {
      this.animation = requestAnimationFrame(this.frame);
    } else {
      this.animation = null;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    }
  }
}

const confetti = new Confetti(dom.confetti);

/* ---------- API ---------- */

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

function errorDetail(payload) {
  if (!payload) return 'Неизвестная ошибка.';
  if (typeof payload.detail === 'string') return payload.detail;
  if (Array.isArray(payload.detail)) {
    return payload.detail
      .map((item) => {
        const path = Array.isArray(item.loc) ? item.loc.slice(1).join('.') : '';
        return path ? `${path}: ${item.msg}` : item.msg;
      })
      .join('; ');
  }
  return 'Сервер не принял запрос.';
}

async function apiRequest(path, payload) {
  let response;
  try {
    response = await fetch(`${API}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    throw new ApiError('Нет связи с Python-сервером. Проверьте, что приложение запущено.', 0);
  }
  let data = null;
  try {
    data = await response.json();
  } catch (error) {
    data = null;
  }
  if (!response.ok) {
    throw new ApiError(errorDetail(data), response.status);
  }
  return data;
}

async function getPresets() {
  let response;
  try {
    response = await fetch(`${API}/presets`);
  } catch (error) {
    throw new ApiError('Нет связи с Python-сервером. Запустите `uv run gauss-studio`.', 0);
  }
  if (!response.ok) throw new ApiError('Не удалось загрузить пресеты.', response.status);
  return response.json();
}

function boardPayload() {
  return {
    matrix: cloneMatrix(state.matrix),
    augmented: state.augmented,
    goal: state.goal,
  };
}

async function analyzeBoard(matrix, augmented, goal) {
  return apiRequest('/analyze', { matrix, augmented, goal });
}

/* ---------- UI primitives ---------- */

function toast(title, message = '', type = 'info', duration = 3400) {
  const icons = { info: '✦', success: '✓', warn: '!', error: '×' };
  const node = document.createElement('div');
  node.className = `toast is-${type}`;
  node.innerHTML = `
    <span class="toast-icon" aria-hidden="true">${icons[type] || icons.info}</span>
    <div class="toast-copy"><strong>${escapeHTML(title)}</strong>${message ? `<p>${escapeHTML(message)}</p>` : ''}</div>
  `;
  node.addEventListener('click', () => {
    node.classList.add('is-leaving');
    window.setTimeout(() => node.remove(), 320);
  });
  dom.toastStack.appendChild(node);
  while (dom.toastStack.children.length > 3) {
    dom.toastStack.firstElementChild.remove();
  }
  window.setTimeout(() => {
    node.classList.add('is-leaving');
    window.setTimeout(() => node.remove(), 320);
  }, duration);
}

function syncBodyLock() {
  const hasLayer = Boolean(document.querySelector('.modal-layer:not([hidden]), .win-layer:not([hidden])'));
  dom.body.classList.toggle('modal-open', hasLayer);
}

function openModal(layer) {
  if (!layer) return;
  if (state.activeModal && state.activeModal !== layer) {
    state.activeModal.hidden = true;
  }
  state.lastFocused = document.activeElement;
  state.activeModal = layer;
  layer.hidden = false;
  syncBodyLock();
  window.requestAnimationFrame(() => {
    const focusable = layer.querySelector('input, button, [href], [tabindex]:not([tabindex="-1"])');
    if (focusable) focusable.focus({ preventScroll: true });
  });
}

function closeModal(layer = state.activeModal) {
  if (!layer) return;
  layer.hidden = true;
  if (state.activeModal === layer) state.activeModal = null;
  syncBodyLock();
  if (state.lastFocused && typeof state.lastFocused.focus === 'function') {
    state.lastFocused.focus({ preventScroll: true });
  }
  state.lastFocused = null;
}

function setBusy(busy) {
  state.busy = busy;
  dom.matrix.classList.toggle('is-busy', busy);
  dom.applyBtn.disabled = busy || !validateOperation().ok;
  $$('.matrix-row', dom.matrix).forEach((row) => row.classList.toggle('is-busy', busy));
  dom.opTabs.forEach((tab) => { tab.disabled = busy; });
}

function rowLabel(index) {
  return `R${index + 1}`;
}

function variableNames(count) {
  const names = ['x', 'y', 'z', 'w', 'v', 'u', 't', 's', 'q', 'p'];
  return Array.from({ length: count }, (_, index) => names[index] || `x${index + 1}`);
}

function isInverseMode() {
  return state.goal === 'inverse';
}

function isEquationMode() {
  return state.goal === 'equation';
}

function leftBlock(matrix = state.matrix, augmented = state.augmented) {
  if (!matrix.length) return [];
  const coefficientCount = matrix[0].length - augmented;
  return matrix.map((row) => row.slice(0, coefficientCount));
}

function rightBlock(matrix = state.matrix, augmented = state.augmented) {
  if (!matrix.length || augmented <= 0) return [];
  const coefficientCount = matrix[0].length - augmented;
  return matrix.map((row) => row.slice(coefficientCount));
}

function editorRhsCols(editor = state.editor) {
  if (!editor) return 0;
  if (editor.mode === 'equation') return editor.rhsCols || 1;
  if (editor.mode === 'inverse') return 0;
  return editor.aug ? 1 : 0;
}

function identityRows(size) {
  return Array.from({ length: size }, (_, row) => (
    Array.from({ length: size }, (_, column) => (row === column ? '1' : '0'))
  ));
}

function boardWithIdentity(matrix) {
  const identity = identityRows(matrix.length);
  return matrix.map((row, index) => [...row, ...identity[index]]);
}

function makeInverseDefault() {
  return [
    ['1', '2', '3'],
    ['0', '1', '4'],
    ['5', '6', '0'],
  ];
}

function randomInvertibleMatrix(size) {
  const values = identityRows(size);
  for (let step = 0; step < size * 3; step += 1) {
    const source = Math.floor(Math.random() * size);
    const target = Math.floor(Math.random() * size);
    if (source === target) continue;
    let factor = Math.floor(Math.random() * 7) - 3;
    if (factor === 0) factor = 1;
    for (let column = 0; column < size; column += 1) {
      const next = Frac.parse(values[target][column], { emptyZero: true })
        .add(Frac.of(BigInt(factor)).mul(Frac.parse(values[source][column], { emptyZero: true })));
      values[target][column] = next.toString();
    }
  }
  return values;
}

/* ---------- matrix rendering ---------- */

function buildHeader() {
  const inverse = isInverseMode();
  const equation = isEquationMode();
  const coefficientCount = state.matrix[0].length - state.augmented;
  const names = (inverse || equation)
    ? Array.from({ length: coefficientCount }, (_, index) => `a${subscript(index + 1)}`)
    : (state.analysis?.variable_names || variableNames(coefficientCount));
  const pivotColumns = new Set(state.analysis?.pivot_columns || []);
  const pieces = ['<div class="matrix-header" role="row">', '<div class="header-cell" aria-hidden="true"></div>'];
  for (let column = 0; column < coefficientCount; column += 1) {
    pieces.push(`
      <div class="header-cell${pivotColumns.has(column) ? ' is-pivot' : ''}" data-header-col="${column}" role="columnheader">
        <span class="var-name">${escapeHTML(names[column] || `x${column + 1}`)}</span>
        <span class="var-index">${(inverse || equation) ? 'A' : pad2(column + 1)}</span>
      </div>
    `);
  }
  if (state.augmented > 0) {
    pieces.push('<div class="header-sep" aria-hidden="true"></div>');
    const equationSolved = equation && state.analysis?.goal_met;
    for (let rhs = 0; rhs < state.augmented; rhs += 1) {
      let label;
      let indexLabel;
      if (inverse) {
        label = `e${subscript(rhs + 1)}`;
        indexLabel = 'I';
      } else if (equation) {
        label = `${equationSolved ? 'x' : 'b'}${subscript(rhs + 1)}`;
        indexLabel = equationSolved ? 'X' : 'B';
      } else {
        label = state.augmented === 1 ? 'b' : `b${subscript(rhs + 1)}`;
        indexLabel = rhs === 0 ? 'rhs' : `rhs${rhs + 1}`;
      }
      pieces.push(`
        <div class="header-cell rhs" data-header-rhs="${rhs}" role="columnheader">
          <span class="var-name">${label}</span>
          <span class="var-index">${indexLabel}</span>
        </div>
      `);
    }
  }
  pieces.push('</div>');
  return pieces.join('');
}

function subscript(number) {
  const digits = '₀₁₂₃₄₅₆₇₈₉';
  return String(number).split('').map((digit) => digits[Number(digit)] ?? digit).join('');
}

function buildMatrixStructure() {
  if (!state.matrix.length) return;
  const rows = state.matrix.length;
  const cols = state.matrix[0].length;
  const coefficientCount = cols - state.augmented;

  dom.matrix.style.setProperty('--coeff-cols', String(coefficientCount));
  dom.matrix.style.setProperty('--aug-cols', String(state.augmented));
  dom.matrix.classList.toggle('no-aug', state.augmented === 0);
  dom.matrix.classList.toggle('is-inverse', isInverseMode());
  dom.matrix.classList.toggle('is-equation', isEquationMode());

  const pieces = [buildHeader()];
  for (let row = 0; row < rows; row += 1) {
    const cells = [];
    for (let column = 0; column < coefficientCount; column += 1) {
      cells.push(`
        <div class="matrix-cell" data-row="${row}" data-col="${column}" role="gridcell">
          <span class="cell-value"></span>
        </div>
      `);
    }
    if (state.augmented > 0) {
      cells.push('<div class="matrix-sep" aria-hidden="true"></div>');
      for (let rhs = 0; rhs < state.augmented; rhs += 1) {
        const column = coefficientCount + rhs;
        cells.push(`
          <div class="matrix-cell rhs" data-row="${row}" data-col="${column}" role="gridcell">
            <span class="cell-value"></span>
          </div>
        `);
      }
    }
    pieces.push(`
      <div class="matrix-row" data-row="${row}" role="row" tabindex="0" aria-label="Строка ${row + 1}">
        <div class="row-tag">
          <span class="row-tag-main"><small>R</small>${row + 1}</span>
          <span class="row-tag-sub"></span>
        </div>
        ${cells.join('')}
      </div>
    `);
  }
  dom.matrix.innerHTML = pieces.join('');
  updateCellValues();
  updateHighlights();
  updateRowAria();
}

function updateCellValues() {
  if (!state.matrix.length) return;
  const fractions = matrixToFractions(state.matrix);
  $$('.matrix-cell', dom.matrix).forEach((cell) => {
    const row = Number(cell.dataset.row);
    const column = Number(cell.dataset.col);
    const value = fractions[row]?.[column] || ZERO;
    const valueElement = cell.querySelector('.cell-value');
    if (!valueElement) return;
    const compact = value.plain().length > 5;
    valueElement.className = `cell-value${value.isZero() ? ' is-zero' : ''}${compact ? ' is-compact' : ''}`;
    valueElement.innerHTML = fractionHTML(value);
    valueElement.title = value.plain();
  });
}

function updateRowAria() {
  $$('.matrix-row', dom.matrix).forEach((rowElement) => {
    const row = Number(rowElement.dataset.row);
    const values = state.matrix[row].map((cell) => {
      const value = Frac.parse(cell, { emptyZero: true }) || ZERO;
      return value.plain();
    });
    const coefficientCount = state.matrix[0].length - state.augmented;
    const left = values.slice(0, coefficientCount).join(', ');
    const right = values.slice(coefficientCount).join(', ');
    rowElement.setAttribute(
      'aria-label',
      `Строка ${row + 1}: ${left}${state.augmented
        ? `, ${isInverseMode()
          ? 'единичный блок'
          : (isEquationMode()
            ? (state.analysis?.goal_met ? 'решение X' : 'матрица B')
            : 'правая часть')} ${right}`
        : ''}. Нажмите, чтобы выбрать.`,
    );
  });
}

function updateHighlights() {
  if (!state.matrix.length) return;
  const coefficientCount = state.matrix[0].length - state.augmented;
  const fractions = matrixToFractions(state.matrix);
  const pivotColumns = new Set(state.analysis?.pivot_columns || []);
  let previousLeading = -1;

  $$('.matrix-row', dom.matrix).forEach((rowElement) => {
    const row = Number(rowElement.dataset.row);
    let leading = -1;
    for (let column = 0; column < coefficientCount; column += 1) {
      if (!fractions[row][column].isZero()) {
        leading = column;
        break;
      }
    }
    const shouldHighlight = leading >= 0 && leading > previousLeading && pivotColumns.has(leading);
    if (shouldHighlight) previousLeading = leading;
    $$('.matrix-cell', rowElement).forEach((cell) => {
      const column = Number(cell.dataset.col);
      cell.classList.toggle('is-leading', shouldHighlight && column === leading);
    });
  });

  $$('[data-header-col]', dom.matrix).forEach((header) => {
    const column = Number(header.dataset.headerCol);
    header.classList.toggle('is-pivot', pivotColumns.has(column));
  });
}

/* ---------- selection and controls ---------- */

function selectionIsComplete() {
  const { source, target } = state.selection;
  if (state.op === 'scale') return source !== null;
  return source !== null && target !== null;
}

function clearSelection({ silent = false } = {}) {
  state.selection = { source: null, target: null };
  updateSelectionUI();
  updateExpression();
  updatePreview();
  updateControls();
  drawFlow();
  if (!silent) sfx.click();
  schedulePersist();
}

function selectRow(row) {
  if (state.busy || state.autoplay || !state.matrix.length) return;
  const selection = state.selection;

  if (state.op === 'scale') {
    selection.source = selection.source === row ? null : row;
    selection.target = null;
  } else if (selection.source === null || selection.target !== null) {
    selection.source = row;
    selection.target = null;
  } else if (selection.source === row) {
    selection.source = null;
  } else {
    selection.target = row;
    sfx.tone(610, 0.04, { type: 'sine', volume: 0.018, slide: 730 });
  }

  sfx.click();
  updateSelectionUI();
  updateExpression();
  updatePreview();
  updateControls();
  drawFlow();
  schedulePersist();
  dom.applyBtn.focus({ preventScroll: true });
}

function updateSelectionUI() {
  const { source, target } = state.selection;
  $$('.matrix-row', dom.matrix).forEach((rowElement) => {
    const row = Number(rowElement.dataset.row);
    rowElement.classList.toggle('is-source', source === row);
    rowElement.classList.toggle('is-target', target === row);
    rowElement.classList.remove('is-hover-target');
  });

  const sourcePill = $('.legend-source', dom.selectionLegend);
  const targetPill = $('.legend-target', dom.selectionLegend);
  sourcePill?.classList.toggle('is-active', source !== null);
  targetPill?.classList.toggle('is-active', target !== null);
  dom.clearSelectionBtn.classList.toggle('is-visible', source !== null || target !== null);

  $$('.matrix-row', dom.matrix).forEach((rowElement) => {
    const row = Number(rowElement.dataset.row);
    rowElement.setAttribute('aria-pressed', String(row === source || row === target));
  });
}

function setOperation(kind) {
  if (state.busy || state.autoplay) return;
  if (!OP_META[kind] || state.op === kind) return;
  state.op = kind;
  if (kind === 'scale' && state.selection.source === null && state.selection.target !== null) {
    state.selection.source = state.selection.target;
  }
  if (kind === 'scale') state.selection.target = null;

  dom.opTabs.forEach((tab) => {
    const active = tab.dataset.op === kind;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', String(active));
  });
  dom.factorField.classList.toggle('is-hidden', kind === 'swap');
  sfx.click();
  updateSelectionUI();
  updateExpression();
  updatePreview();
  updateControls();
  drawFlow();
  schedulePersist();
}

function setGoal(goal) {
  if (state.busy || goal === state.goal) return;
  if (goal === 'inverse') {
    void enterInverseMode();
    return;
  }
  if (goal === 'equation') {
    void enterEquationMode();
    return;
  }
  if (state.goal === 'inverse' || state.goal === 'equation') {
    void exitSpecialMode(goal);
    return;
  }
  const previous = state.goal;
  state.goal = goal;
  state.hint = null;
  updateGoalButtons();
  void refreshGoalAnalysis(previous);
}

function originalLeftBlock() {
  const source = state.history[0]?.matrix || state.matrix;
  return leftBlock(source, state.augmented);
}

async function transitionBoard(options, message = null) {
  state.busy = true;
  setBusy(true);
  updateControls();
  try {
    await openBoard(options);
    if (message && !TOUCH_DEVICE) {
      toast(message.title, message.text, message.type || 'success', 3200);
    }
  } catch (error) {
    toast('Не удалось открыть доску', error.message, 'error', 4200);
  } finally {
    state.busy = false;
    setBusy(false);
    updateControls();
  }
}

async function enterInverseMode() {
  const source = state.history[0]?.matrix || state.matrix;
  const rows = source.length;
  const coefficientCount = rows ? source[0].length - state.augmented : 0;
  if (rows >= 2 && rows === coefficientCount && rows <= 8) {
    const matrixA = leftBlock(source, state.augmented);
    const size = rows;
    await transitionBoard(
      {
        matrix: boardWithIdentity(matrixA),
        augmented: size,
        goal: 'inverse',
        name: `Обратная ${size}×${size}`,
        presetId: null,
        resetStats: true,
      },
      {
        title: 'Режим обратной матрицы',
        text: 'Слева A, справа I. Приведите левую часть к единичной — справа появится A⁻¹.',
        type: 'info',
      },
    );
    return;
  }
  openNewMatrixModal({ mode: 'inverse' });
  toast(
    'Нужна квадратная A',
    'Для A⁻¹ число уравнений и неизвестных должно совпадать. Введите матрицу в открывшемся окне.',
    'info',
    4600,
  );
}

async function enterEquationMode() {
  const rows = state.matrix.length;
  const coefficientCount = rows ? state.matrix[0].length - state.augmented : 0;
  const canReuse = !isInverseMode()
    && !isEquationMode()
    && rows >= 2
    && rows === coefficientCount
    && state.augmented >= 1;
  if (canReuse) {
    const rightColumns = state.augmented;
    await transitionBoard(
      {
        matrix: cloneMatrix(state.matrix),
        augmented: rightColumns,
        goal: 'equation',
        name: `A·X = B · B ${rows}×${rightColumns}`,
        presetId: null,
        resetStats: true,
      },
      {
        title: 'Режим матричного уравнения',
        text: 'Слева A, справа B. Приведите A к I — справа появится X = A⁻¹B.',
        type: 'info',
      },
    );
    return;
  }
  openNewMatrixModal({ mode: 'equation' });
  toast(
    'Соберите A и B',
    'Для уравнения A·X = B нужна квадратная A и хотя бы один столбец B.',
    'info',
    4600,
  );
}

async function exitSpecialMode(goal) {
  const matrixA = originalLeftBlock();
  if (goal === 'inverse') {
    await transitionBoard(
      {
        matrix: boardWithIdentity(matrixA),
        augmented: matrixA.length,
        goal: 'inverse',
        name: `Обратная ${matrixA.length}×${matrixA.length}`,
        presetId: null,
        resetStats: true,
      },
      {
        title: 'Режим обратной матрицы',
        text: 'Матрица A дополнена единичной I.',
        type: 'info',
      },
    );
    return;
  }
  await transitionBoard(
    {
      matrix: matrixA,
      augmented: 0,
      goal,
      name: 'Своя матрица',
      presetId: null,
      resetStats: true,
    },
    {
      title: 'Режим системы',
      text: 'Матрица A перенесена на доску без правой части.',
      type: 'info',
    },
  );
}

async function refreshGoalAnalysis(previousGoal = null) {
  if (!state.matrix.length) return;
  state.busy = true;
  setBusy(true);
  try {
    const analysis = await analyzeBoard(state.matrix, state.augmented, state.goal);
    state.analysis = analysis;
    state.basePlan = Math.max(analysis.remaining_steps, 1);
    state.winShown = analysis.goal_met ? state.winShown : false;
    updateAnalysisUI();
    updateHighlights();
    resetHintEmpty(analysis.goal_met);
    renderAllLight();
    schedulePersist();
    if (analysis.goal_met) {
      toast('Уже готово', `Матрица уже в форме «${analysis.goal_label}».`, 'success');
    }
  } catch (error) {
    if (previousGoal) {
      state.goal = previousGoal;
      updateGoalButtons();
    }
    toast('Не удалось сменить цель', error.message, 'error');
  } finally {
    state.busy = false;
    setBusy(false);
    updateControls();
  }
}

function updateGoalButtons() {
  $$('.goal-switch button').forEach((button) => {
    const active = button.dataset.goal === state.goal;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
}

function updateFactor(raw, { fromInput = false } = {}) {
  state.factor = raw;
  const parsed = Frac.parse(raw);
  state.factorFrac = parsed;
  if (dom.factorInput.value !== raw) dom.factorInput.value = raw;
  dom.factorInput.classList.toggle('is-invalid', Boolean(raw.trim()) && !parsed);
  $$('button[data-factor]', dom.factorQuick).forEach((button) => {
    const quick = Frac.parse(button.dataset.factor);
    button.classList.toggle('active', Boolean(parsed && quick && parsed.equals(quick)));
  });
  if (!fromInput) {
    dom.factorInput.value = raw;
  }
  updateExpression();
  updatePreview();
  updateControls();
  schedulePersist();
}

function stepFactor(delta) {
  const current = state.factorFrac && !state.factorFrac.isZero() ? state.factorFrac : ONE;
  let next = current.add(Frac.of(BigInt(delta)));
  if (next.isZero()) next = ONE;
  updateFactor(next.toString());
  sfx.click();
}

function validateOperation() {
  const { source, target } = state.selection;
  const factor = state.factorFrac;

  if (!state.matrix.length) return { ok: false, error: 'Матрица ещё не загружена.' };
  if (state.op === 'scale') {
    if (source === null) return { ok: false, error: 'Выберите строку, которую нужно умножить.' };
    if (!factor) return { ok: false, error: 'Введите множитель: 2, 1/2 или −3/4.' };
    if (factor.isZero()) return { ok: false, error: 'Умножить строку на ноль нельзя.' };
    return {
      ok: true,
      op: { kind: 'scale', source, target: source, factor: factor.toString() },
    };
  }

  if (source === null) return { ok: false, error: 'Сначала выберите строку-источник.' };
  if (target === null) return { ok: false, error: 'Теперь выберите строку-цель.' };
  if (source === target) return { ok: false, error: 'Источник и цель должны быть разными строками.' };

  if (state.op === 'swap') {
    return { ok: true, op: { kind: 'swap', source, target, factor: '1' } };
  }
  if (!factor) return { ok: false, error: 'Введите множитель: 2, 1/2 или −3/4.' };
  if (factor.isZero()) return { ok: false, error: 'Множитель не может быть нулём.' };
  return {
    ok: true,
    op: { kind: state.op, source, target, factor: factor.toString() },
  };
}

function updateControls() {
  const validation = validateOperation();
  dom.applyBtn.disabled = state.busy || state.autoplay || !validation.ok;

  if (state.op === 'swap') {
    dom.applyLabel.textContent = 'Поменять строки';
  } else if (state.op === 'scale') {
    dom.applyLabel.textContent = state.selection.source !== null
      ? `Умножить R${state.selection.source + 1}`
      : 'Умножить';
  } else {
    const base = OP_META[state.op].label;
    dom.applyLabel.textContent = state.selection.target !== null
      ? `${base} из R${state.selection.target + 1}`
      : base;
  }

  dom.undoBtn.disabled = state.busy || state.historyIndex <= 0;
  dom.redoBtn.disabled = state.busy || state.historyIndex >= state.history.length - 1;
  dom.resetBtn.disabled = state.busy || state.historyIndex <= 0;
  dom.factorInput.disabled = state.busy || state.op === 'swap';
  dom.factorDown.disabled = state.busy;
  dom.factorUp.disabled = state.busy;
  dom.factorQuick.querySelectorAll('button').forEach((button) => {
    button.disabled = state.busy;
  });

  if (state.busy) {
    dom.dockHint.innerHTML = '<span class="dock-step">··</span> Считаем точный результат…';
    return;
  }

  const { source, target } = state.selection;
  if (state.op === 'scale') {
    if (source === null) {
      dom.dockHint.innerHTML = '<span class="dock-step">01</span> Нажмите на строку, которую хотите умножить.';
    } else {
      dom.dockHint.innerHTML = `<span class="dock-step">02</span> R${source + 1} × ${escapeHTML(state.factorFrac ? state.factorFrac.plain() : '?')} — можно применять.`;
    }
    return;
  }
  if (source === null) {
    dom.dockHint.innerHTML = '<span class="dock-step">01</span> Нажмите на строку-источник, затем на строку-цель.';
  } else if (target === null) {
    dom.dockHint.innerHTML = `<span class="dock-step">02</span> R${source + 1} выбрана. Теперь укажите строку-цель.`;
  } else {
    dom.dockHint.innerHTML = '<span class="dock-step">03</span> Проверьте предпросмотр и примените ход.';
  }
}

/* ---------- expression & preview ---------- */

function rowSpan(index, className = '') {
  return `<span class="${className}">R${index + 1}</span>`;
}

function factorExpressionHTML(factor) {
  if (!factor) return '<span class="expr-muted">?</span>';
  const negative = factor.n < 0n;
  const body = factor.abs().isOne() ? '' : fractionInline(factor.abs());
  if (negative) {
    return `<span class="expr-factor">(−${body}${factor.abs().isOne() ? '1' : ''})·</span>`;
  }
  if (factor.isOne()) return '';
  return `<span class="expr-factor">${body}·</span>`;
}

function expressionMarkup(op, source, target, factor) {
  const sourceMarkup = source === null ? '<span class="expr-muted">R?</span>' : rowSpan(source, 'expr-source');
  const targetMarkup = target === null ? '<span class="expr-muted">R?</span>' : rowSpan(target, 'expr-target');

  if (op === 'swap') {
    return `${sourceMarkup} <span class="expr-op">⇄</span> ${targetMarkup}`;
  }
  if (op === 'scale') {
    const factorMarkup = factor ? fractionInline(factor) : '<span class="expr-muted">?</span>';
    return `${sourceMarkup} <span class="expr-op">×</span> ${factorMarkup} <span class="expr-muted">→</span> ${sourceMarkup}`;
  }
  const operator = op === 'subtract' ? '−' : '+';
  return `${targetMarkup} <span class="expr-op">${operator}</span> ${factorExpressionHTML(factor)}${sourceMarkup} <span class="expr-muted">→</span> ${targetMarkup}`;
}

function updateExpression() {
  const { source, target } = state.selection;
  const op = state.op;
  const factor = state.factorFrac;
  dom.expression.innerHTML = expressionMarkup(op, source, target, factor);
}

function previewTargetRow() {
  const validation = validateOperation();
  if (!validation.ok) return null;
  const op = validation.op;
  const fractions = matrixToFractions(state.matrix);
  if (op.kind === 'swap') return { rows: [op.source, op.target], next: fractions[op.source], target: op.target };
  if (op.kind === 'scale') {
    const factor = Frac.parse(op.factor);
    return {
      rows: [op.target],
      next: fractions[op.target].map((value) => value.mul(factor)),
      target: op.target,
    };
  }
  const factor = Frac.parse(op.factor);
  const next = fractions[op.target].map((value, column) => {
    const change = factor.mul(fractions[op.source][column]);
    return op.kind === 'subtract' ? value.sub(change) : value.add(change);
  });
  return { rows: [op.source, op.target], next, target: op.target };
}

function updatePreview() {
  const { source, target } = state.selection;
  const validation = validateOperation();
  const hasSelection = source !== null && (state.op === 'scale' || target !== null);
  const preview = previewTargetRow();
  const fractions = matrixToFractions(state.matrix);

  dom.previewBar.classList.toggle('has-preview', Boolean(preview));
  dom.previewBar.classList.toggle('is-error', Boolean(hasSelection && !validation.ok));
  dom.previewValues.innerHTML = '';
  dom.previewCaption.textContent = 'выберите операцию';

  if (!preview) {
    if (hasSelection && !validation.ok) {
      dom.previewCaption.textContent = 'нужен корректный ход';
      dom.previewValues.innerHTML = `<span class="preview-error-text">${escapeHTML(validation.error)}</span>`;
    } else {
      dom.previewCaption.textContent = 'предпросмотр';
      dom.previewValues.innerHTML = '<span class="preview-placeholder">— результат появится здесь —</span>';
    }
    return;
  }

  dom.previewCaption.textContent = `R${preview.target + 1} станет`;
  const coefficientCount = state.matrix[0].length - state.augmented;
  const prior = fractions[preview.target];
  const chips = [];

  preview.next.forEach((value, column) => {
    if (column === coefficientCount && state.augmented > 0) {
      chips.push('<span class="preview-eq" aria-hidden="true">│</span>');
    }
    const changed = !value.equals(prior[column]);
    const classes = [
      'preview-chip',
      changed ? 'changed' : '',
      value.isZero() ? 'is-zero' : '',
      column >= coefficientCount ? 'is-rhs' : '',
    ].filter(Boolean).join(' ');
    chips.push(`<span class="${classes}">${escapeHTML(value.plain())}</span>`);
  });

  dom.previewValues.innerHTML = chips.join('');
}

/* ---------- flow overlay ---------- */

function drawFlow() {
  const { source, target } = state.selection;
  const visible = source !== null
    && target !== null
    && state.op !== 'scale'
    && !state.busy
    && state.matrix.length > 0;

  if (!visible) {
    dom.flowOverlay.classList.remove('is-visible');
    return;
  }

  const rows = $$('.matrix-row', dom.matrix);
  const sourceElement = rows[source];
  const targetElement = rows[target];
  if (!sourceElement || !targetElement) return;

  const width = dom.matrixScroll.scrollWidth;
  const height = dom.matrixScroll.scrollHeight;
  const x = Math.max(7, dom.matrix.offsetLeft - 12);
  const sourceY = dom.matrix.offsetTop + sourceElement.offsetTop + sourceElement.offsetHeight / 2;
  const targetY = dom.matrix.offsetTop + targetElement.offsetTop + targetElement.offsetHeight / 2;

  dom.flowOverlay.setAttribute('viewBox', `0 0 ${width} ${height}`);
  dom.flowOverlay.style.width = `${width}px`;
  dom.flowOverlay.style.height = `${height}px`;

  const bend = Math.max(9, Math.min(20, Math.abs(targetY - sourceY) * 0.3));
  const controlX = Math.max(3, x - bend);
  dom.flowPath.setAttribute(
    'd',
    `M ${x} ${sourceY} C ${controlX} ${sourceY + (targetY - sourceY) * 0.25}, ${controlX} ${targetY - (targetY - sourceY) * 0.25}, ${x} ${targetY}`,
  );
  dom.flowPath.setAttribute('marker-end', 'url(#flowArrow)');
  dom.flowOverlay.classList.add('is-visible');
}

/* ---------- status / analysis ---------- */

function statusClass(analysis) {
  if (analysis.goal === 'inverse') {
    if (!analysis.invertible) return 'is-danger';
    return analysis.goal_met ? '' : 'is-neutral';
  }
  if (analysis.goal === 'equation') {
    if (!analysis.consistent) return 'is-danger';
    if (analysis.goal_met) return '';
    return 'is-neutral';
  }
  if (!analysis.consistent) return 'is-danger';
  if (analysis.goal_met) return '';
  if (analysis.free_variables > 0) return 'is-neutral';
  return '';
}

function statusText(analysis) {
  if (analysis.goal === 'inverse') {
    if (analysis.goal_met) return 'A⁻¹ готова';
    return analysis.invertible ? 'обратима' : 'вырожденная';
  }
  if (analysis.goal === 'equation') {
    if (analysis.goal_met) return 'X найден';
    if (!analysis.consistent) return 'решений нет';
    if (!analysis.invertible) return '∞ решений';
    return 'единственное';
  }
  if (analysis.augmented === 0) return `rank ${analysis.rank}`;
  if (!analysis.consistent) return 'несовместна';
  if (analysis.goal_met && analysis.solution) return 'решена';
  if (analysis.free_variables > 0) return '∞ решений';
  return 'единственное';
}

function computeGoalProgress(analysis) {
  if (!analysis || !state.matrix.length) return 0;
  if (analysis.goal_met) return 100;
  if (analysis.goal === 'inverse' || analysis.goal === 'equation') {
    const size = state.matrix.length;
    const fractions = matrixToFractions(state.matrix);
    let correct = 0;
    for (let row = 0; row < size; row += 1) {
      for (let column = 0; column < size; column += 1) {
        const target = row === column ? ONE : ZERO;
        if (fractions[row][column].equals(target)) correct += 1;
      }
    }
    if (!size) return 0;
    return clamp(Math.round((correct / (size * size)) * 100), 0, 99);
  }
  const rows = state.matrix.length;
  const coefficientCount = state.matrix[0].length - state.augmented;
  const fractions = matrixToFractions(state.matrix);
  const pivots = analysis.pivot_columns || [];
  let total = 0;
  let done = 0;

  for (let index = 0; index < pivots.length; index += 1) {
    const column = pivots[index];
    total += 1;
    if (fractions[index]?.[column]?.isOne()) done += 1;

    if (analysis.goal === 'echelon') {
      for (let row = index + 1; row < rows; row += 1) {
        total += 1;
        if (fractions[row][column].isZero()) done += 1;
      }
    } else {
      for (let row = 0; row < rows; row += 1) {
        if (row === index) continue;
        total += 1;
        if (fractions[row][column].isZero()) done += 1;
      }
    }
  }

  // Rows with leading terms must have strictly increasing leading columns.
  total += 1;
  let previousLeading = -1;
  let ordered = true;
  for (let row = 0; row < rows; row += 1) {
    let leading = -1;
    for (let column = 0; column < coefficientCount; column += 1) {
      if (!fractions[row][column].isZero()) {
        leading = column;
        break;
      }
    }
    if (leading >= 0) {
      if (leading <= previousLeading) ordered = false;
      previousLeading = leading;
    }
  }
  if (ordered) done += 1;

  // Any zero rows should be at the bottom.
  for (let row = pivots.length; row < rows; row += 1) {
    total += 1;
    if (fractions[row].every((value, column) => column >= coefficientCount || value.isZero())) {
      done += 1;
    }
  }

  if (!total) return 0;
  return clamp(Math.round((done / total) * 100), 0, 99);
}

function refreshHeader() {
  const header = $('.matrix-header', dom.matrix);
  if (!header) return;
  const container = document.createElement('div');
  container.innerHTML = buildHeader();
  header.replaceWith(container.firstElementChild);
}

function updateAnalysisUI() {
  const analysis = state.analysis;
  if (!analysis) return;
  const inverse = analysis.goal === 'inverse';
  const equation = analysis.goal === 'equation';
  const special = inverse || equation;
  const coefficientCount = state.matrix[0].length - state.augmented;
  const names = special
    ? Array.from({ length: coefficientCount }, (_, index) => `a${subscript(index + 1)}`)
    : (analysis.variable_names || variableNames(coefficientCount));
  const pivotColumns = new Set(analysis.pivot_columns || []);

  dom.statusPanelTitle.textContent = inverse ? 'Матрица' : (equation ? 'Уравнение' : 'Система');
  dom.rankLabel.textContent = 'rank A';
  dom.freeLabel.textContent = special ? 'det A' : 'свободных';
  dom.zeroLabel.textContent = inverse
    ? 'обратима'
    : (equation ? (analysis.goal_met ? 'столбцов X' : 'столбцов B') : 'нулевых строк');

  const determinantValue = special
    ? (state.inverseDeterminant || analysis.determinant)
    : analysis.determinant;
  dom.statusPill.textContent = statusText(analysis);
  dom.statusPill.className = `status-pill ${statusClass(analysis)}`.trim();
  dom.statusPill.title = special
    ? `${analysis.status}: det A = ${prettyValue(determinantValue)}`
    : `${analysis.status}: ${analysis.status_detail}`;

  dom.rankValue.textContent = analysis.rank;
  if (special) {
    dom.freeValue.textContent = prettyValue(determinantValue);
    dom.freeValue.classList.toggle('is-compact', String(determinantValue).length > 5);
    dom.zeroValue.textContent = inverse
      ? (analysis.invertible ? 'да' : 'нет')
      : analysis.augmented;
    dom.freeValue.title = `det A = ${prettyValue(determinantValue)}`;
  } else {
    dom.freeValue.textContent = analysis.free_variables;
    dom.freeValue.classList.remove('is-compact');
    dom.zeroValue.textContent = analysis.zero_rows;
    dom.freeValue.removeAttribute('title');
  }

  const pivotChips = names.map((name, index) => (
    `<span class="pivot-chip${pivotColumns.has(index) ? ' is-pivot' : ''}">${escapeHTML(name)}</span>`
  ));
  if (inverse) {
    pivotChips.push(`<span class="pivot-chip${analysis.goal_met ? ' is-pivot' : ''}">I</span>`);
  } else if (equation) {
    pivotChips.push(`<span class="pivot-chip${analysis.goal_met ? ' is-pivot' : ''}">${analysis.goal_met ? 'X' : 'B'}</span>`);
  } else if (state.augmented > 0) {
    const augmentedPivot = Array.from(pivotColumns).some((column) => column >= coefficientCount);
    pivotChips.push(`<span class="pivot-chip${augmentedPivot ? ' is-pivot' : ''}">b</span>`);
  }
  dom.pivotMap.innerHTML = pivotChips.join('');

  renderSolution(analysis);
  refreshHeader();

  const percentage = computeGoalProgress(analysis);
  dom.remainingMoves.textContent = analysis.goal_met ? '✓' : `${percentage}%`;
  dom.remainingWord.textContent = analysis.goal_met ? 'цель' : 'к цели';
  dom.progressBar.style.width = `${percentage}%`;
  dom.progressTrack.setAttribute('aria-valuenow', String(percentage));
  dom.progressTrack.setAttribute('aria-valuetext', `${percentage}%`);

  if (inverse) {
    if (!analysis.invertible) {
      dom.missionHint.textContent = 'det A = 0: строки зависимы, обратной матрицы не существует. Введите другую A или вернитесь к системе.';
    } else if (analysis.goal_met) {
      dom.missionHint.textContent = 'Готово: слева I, справа A⁻¹. Матрица найдена без единого округления.';
    } else if (percentage >= 80) {
      dom.missionHint.textContent = 'Левая часть почти единичная. Осталось несколько чистых обнулений.';
    } else if (percentage >= 45) {
      dom.missionHint.textContent = 'Половина пути: собирайте I по столбцам, справа уже формируется A⁻¹.';
    } else {
      dom.missionHint.textContent = 'Приведите левую часть к единичной матрице I.';
    }
    return;
  }

  if (equation) {
    if (!analysis.consistent) {
      dom.missionHint.textContent = 'Решений нет: ранг [A | B] больше ранга A — правая часть противоречит левой.';
    } else if (!analysis.invertible) {
      dom.missionHint.textContent = 'A вырождена: уравнение совместно, но решение X не единственно. Привести A к I невозможно.';
    } else if (analysis.goal_met) {
      dom.missionHint.textContent = 'Готово: слева I, справа X = A⁻¹B. Решение получено точными дробями.';
    } else if (percentage >= 80) {
      dom.missionHint.textContent = 'Левая часть почти единичная. Скоро справа проступит X.';
    } else if (percentage >= 45) {
      dom.missionHint.textContent = 'Половина пути: собирайте I по столбцам, справа уже формируется X.';
    } else {
      dom.missionHint.textContent = 'Приведите A к единичной матрице — тогда справа будет X.';
    }
    return;
  }

  if (analysis.goal_met) {
    dom.missionHint.textContent = analysis.augmented
      ? 'Цель достигнута. Матрица в нужном виде — можно читать выводы.'
      : 'Цель достигнута. Матрица приведена к нужному виду.';
  } else if (!analysis.consistent) {
    dom.missionHint.textContent = 'В правой части появилось противоречие, но лестницу всё ещё можно собрать.';
  } else if (percentage >= 80) {
    dom.missionHint.textContent = 'Финишная прямая: осталось несколько чистых обнулений.';
  } else if (percentage >= 45) {
    dom.missionHint.textContent = 'Больше половины пути. Держите ведущие единицы и обнуляйте низ.';
  } else if (percentage > 0) {
    dom.missionHint.textContent = 'Хороший старт. Продолжайте собирать лестницу слева направо.';
  } else {
    dom.missionHint.textContent = 'Сделайте ведущие элементы единицами и обнулите всё под ними.';
  }
}

function matrixGridHTML(matrix, label = 'A⁻¹') {
  const size = matrix.length;
  const columns = matrix[0]?.length || 0;
  const rows = matrix.map((row) => {
    const cells = row.map((cell) => {
      const value = Frac.parse(cell, { emptyZero: true }) || ZERO;
      return `<span class="inverse-cell${value.isZero() ? ' is-zero' : ''}">${fractionHTML(value)}</span>`;
    }).join('');
    return `<div class="inverse-row">${cells}</div>`;
  }).join('');
  return `
    <div class="solution-inverse">
      <div class="solution-inverse-head"><span>${escapeHTML(label)}</span><span>${size}×${columns}</span></div>
      <div class="solution-inverse-grid" style="--inv-cols:${columns}">${rows}</div>
    </div>
  `;
}

function renderSolution(analysis) {
  if (analysis.goal === 'inverse') {
    if (!analysis.invertible) {
      dom.solutionSlot.innerHTML = '<p class="solution-note"><strong>det A = 0</strong> — обратной матрицы не существует.</p>';
      return;
    }
    if (analysis.goal_met && analysis.inverse) {
      dom.solutionSlot.innerHTML = matrixGridHTML(analysis.inverse, 'A⁻¹');
      return;
    }
    dom.solutionSlot.innerHTML = '<p class="solution-empty">Приведите левую часть к I — справа появится A⁻¹.</p>';
    return;
  }
  if (analysis.goal === 'equation') {
    if (!analysis.consistent) {
      dom.solutionSlot.innerHTML = '<p class="solution-note"><strong>Решений нет</strong> — ранг [A | B] больше ранга A.</p>';
      return;
    }
    if (!analysis.invertible) {
      dom.solutionSlot.innerHTML = '<p class="solution-note">A вырождена: решений бесконечно много, решение X не единственно.</p>';
      return;
    }
    if (analysis.goal_met && analysis.solution_matrix) {
      dom.solutionSlot.innerHTML = matrixGridHTML(analysis.solution_matrix, 'X');
      return;
    }
    dom.solutionSlot.innerHTML = '<p class="solution-empty">Приведите A к I — справа появится X = A⁻¹B.</p>';
    return;
  }
  if (!analysis.goal_met) {
    dom.solutionSlot.innerHTML = '<p class="solution-empty">Решите матрицу, чтобы увидеть ответ.</p>';
    return;
  }
  if (analysis.augmented === 0) {
    dom.solutionSlot.innerHTML = `<p class="solution-empty">Ранг матрицы: <strong style="color:var(--text-soft)">${analysis.rank}</strong>.</p>`;
    return;
  }
  if (!analysis.consistent) {
    dom.solutionSlot.innerHTML = '<p class="solution-note"><strong>0 = c</strong> — система несовместна: решений нет.</p>';
    return;
  }
  if (analysis.solution && analysis.solution.length) {
    const chips = analysis.solution.map((item) => (
      `<span class="solution-var">${escapeHTML(item.name)} = <b>${escapeHTML(prettyValue(item.value))}</b></span>`
    ));
    dom.solutionSlot.innerHTML = `<div class="solution-grid">${chips.join('')}</div>`;
    return;
  }
  if (analysis.free_variables > 0) {
    const word = plural(analysis.free_variables, 'свободная переменная', 'свободные переменные', 'свободных переменных');
    dom.solutionSlot.innerHTML = `<p class="solution-note">${analysis.free_variables} ${word}: решение параметрическое.</p>`;
    return;
  }
  dom.solutionSlot.innerHTML = '<p class="solution-empty">Решение готово.</p>';
}

/* ---------- history ---------- */

function pushHistory(entry) {
  state.history = state.history.slice(0, state.historyIndex + 1);
  state.history.push(entry);
  if (state.history.length > MAX_HISTORY_STORED) {
    state.history.shift();
  }
  state.historyIndex = state.history.length - 1;
}

function renderHistory() {
  if (!state.history.length) {
    dom.historyList.innerHTML = '<li class="history-empty">Пока пусто.</li>';
    return;
  }
  const items = state.history.map((entry, index) => {
    const classes = [
      'history-item',
      index === state.historyIndex ? 'is-current' : '',
      index > state.historyIndex ? 'is-future' : '',
    ].filter(Boolean).join(' ');
    const zeros = entry.zeros
      ? `<b>+${entry.zeros} ${plural(entry.zeros, 'ноль', 'нуля', 'нулей')}</b>`
      : (entry.kind === 'start' ? 'исходная матрица' : 'без новых нулей');
    const label = entry.kind === 'start' ? 'Старт' : entry.expression;
    return `
      <li>
        <button class="${classes}" type="button" data-history-index="${index}" aria-current="${index === state.historyIndex ? 'step' : 'false'}">
          <span class="history-step">${pad2(index)}</span>
          <span class="history-body">
            <span class="history-expr">${escapeHTML(label)}</span>
            <span class="history-meta">${zeros}</span>
          </span>
          <span class="history-flag" aria-hidden="true"></span>
        </button>
      </li>
    `;
  });
  dom.historyList.innerHTML = items.join('');
  dom.historyCount.textContent = String(state.historyIndex);
  const current = $('.history-item.is-current', dom.historyList);
  if (current) {
    const list = dom.historyList;
    const target = current.offsetTop - list.clientHeight / 2 + current.offsetHeight / 2;
    list.scrollTo({ top: Math.max(0, target), behavior: REDUCED_MOTION ? 'auto' : 'smooth' });
  }
}

async function jumpTo(index) {
  if (state.busy || state.autoplay) return;
  if (index < 0 || index >= state.history.length || index === state.historyIndex) return;
  const entry = state.history[index];
  const previous = state.historyIndex;
  state.busy = true;
  setBusy(true);
  try {
    const analysis = await analyzeBoard(entry.matrix, state.augmented, state.goal);
    state.matrix = cloneMatrix(entry.matrix);
    state.analysis = analysis;
    state.historyIndex = index;
    state.selection = { source: null, target: null };
    state.hint = null;
    state.winShown = false;
    if (index < previous) state.stats.undoThisBoard = true;
    updateCellValues();
    updateHighlights();
    updateSelectionUI();
    updateAnalysisUI();
    updateExpression();
    updatePreview();
    updateControls();
    renderHistory();
    resetHintEmpty(analysis.goal_met);
    drawFlow();
    schedulePersist();
    if (index < previous) sfx.undo(); else sfx.move();
  } catch (error) {
    toast('Не удалось перейти к ходу', error.message, 'error');
  } finally {
    state.busy = false;
    setBusy(false);
    updateControls();
  }
}

function undo() {
  if (state.historyIndex > 0) void jumpTo(state.historyIndex - 1);
}

function redo() {
  if (state.historyIndex < state.history.length - 1) void jumpTo(state.historyIndex + 1);
}

function resetBoard() {
  if (state.historyIndex === 0) {
    toast('Уже в начале', 'Доска стоит на исходной матрице.', 'info');
    return;
  }
  void jumpTo(0).then(() => {
    toast('Доска сброшена', 'Исходная матрица восстановлена. Ходы можно повторить.', 'info');
  });
}

/* ---------- hints ---------- */

function resetHintEmpty(done = false) {
  dom.hintBtn.disabled = false;
  dom.hintBtn.innerHTML = 'Подсказать <kbd>H</kbd>';
  if (done) {
    const inverse = state.goal === 'inverse';
    const equation = state.goal === 'equation';
    dom.hintSlot.innerHTML = `
      <div class="hint-done">
        <span class="hint-done-icon">✓</span>
        <div><strong>${inverse ? 'A⁻¹ готова' : (equation ? 'X найден' : 'Цель достигнута')}</strong><p>${inverse
          ? 'Слева стоит I, справа — обратная матрица. Можно проверить ответ или собрать новую A.'
          : (equation
            ? 'Слева стоит I, справа — X = A⁻¹B. Можно проверить ответ или составить новое уравнение.'
            : 'Матрица уже в нужной форме. Смените цель или соберите новую.')}</p></div>
      </div>
    `;
    return;
  }
  if (state.goal === 'inverse' && state.analysis && !state.analysis.invertible) {
    dom.hintSlot.innerHTML = `
      <div class="hint-done is-warning">
        <span class="hint-done-icon">×</span>
        <div><strong>Обратной не существует</strong><p>det A = 0: строки линейно зависимы. Привести левую часть к I невозможно.</p></div>
      </div>
    `;
    return;
  }
  if (state.goal === 'equation' && state.analysis && !state.analysis.invertible) {
    const consistent = state.analysis.consistent;
    dom.hintSlot.innerHTML = `
      <div class="hint-done is-warning">
        <span class="hint-done-icon">×</span>
        <div><strong>${consistent ? 'Бесконечно много решений' : 'Решений нет'}</strong><p>${consistent
          ? 'A вырождена, но уравнение совместно: решений бесконечно много. Привести A к I невозможно.'
          : 'Ранг [A | B] больше ранга A: правая часть несовместна с левой.'}</p></div>
      </div>
    `;
    return;
  }
  dom.hintSlot.innerHTML = `
    <div class="hint-empty">
      <span class="hint-spark" aria-hidden="true">✦</span>
      <p>Застряли? Gauss подскажет следующий разумный ход — без готового ответа.</p>
    </div>
  `;
}

function renderHint(result) {
  if (!result.available) {
    if (result.goal_met) {
      resetHintEmpty(true);
      return;
    }
    dom.hintSlot.innerHTML = `
      <div class="hint-done is-warning">
        <span class="hint-done-icon">×</span>
        <div><strong>${escapeHTML(result.title || 'Ход невозможен')}</strong><p>${escapeHTML(result.why || '')}</p></div>
      </div>
    `;
    return;
  }
  const op = result.op || {};
  const factor = Frac.parse(op.factor || '1') || ONE;
  const expression = expressionMarkup(op.kind, op.source, op.target ?? op.source, factor);
  dom.hintSlot.innerHTML = `
    <div class="hint-ready">
      <span class="hint-tag">следующий ход</span>
      <h4 class="hint-title">${escapeHTML(result.title)}</h4>
      <p class="hint-why">${escapeHTML(result.why)}</p>
      <div class="hint-expression">${expression}</div>
      <div class="hint-actions">
        <button class="hint-apply" type="button" data-hint-action="apply">Применить <span aria-hidden="true">→</span></button>
        <button class="hint-shuffle" type="button" data-hint-action="refresh" aria-label="Другая подсказка" title="Обновить подсказку">↻</button>
      </div>
    </div>
  `;
}

async function requestHint() {
  if (state.busy || !state.matrix.length) return;
  dom.hintBtn.disabled = true;
  dom.hintBtn.textContent = 'Думаем…';
  dom.hintSlot.innerHTML = `
    <div class="hint-loading"><span class="hint-dots"><i></i><i></i><i></i></span> ищем чистый ход</div>
  `;
  try {
    const result = await apiRequest('/hint', boardPayload());
    state.hint = result;
    state.stats.hintsUsed += 1;
    state.stats.hintThisBoard = true;
    renderHint(result);
    sfx.click();
    schedulePersist();
  } catch (error) {
    resetHintEmpty(false);
    toast('Подсказка не пришла', error.message, 'error');
  } finally {
    dom.hintBtn.disabled = false;
    dom.hintBtn.innerHTML = state.hint?.available ? 'Ещё <kbd>H</kbd>' : 'Подсказать <kbd>H</kbd>';
  }
}

async function applyHint() {
  const hint = state.hint;
  if (!hint || !hint.available || state.busy) return;
  const op = hint.op;
  state.op = op.kind;
  dom.opTabs.forEach((tab) => {
    const active = tab.dataset.op === op.kind;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', String(active));
  });
  dom.factorField.classList.toggle('is-hidden', op.kind === 'swap');
  if (op.factor) {
    state.factor = op.factor;
    dom.factorInput.value = op.factor;
    updateFactor(op.factor);
  }
  if (op.kind === 'scale') {
    state.selection = { source: op.target, target: null };
  } else {
    state.selection = { source: op.source, target: op.target };
  }
  updateSelectionUI();
  updateExpression();
  updatePreview();
  updateControls();
  drawFlow();
  sfx.click();
  await sleep(520);
  const built = validateOperation();
  if (built.ok) {
    await applyOperation(built.op, { fromHint: true });
  }
}

/* ---------- achievements ---------- */

function renderBadges() {
  dom.badgeGrid.innerHTML = ACHIEVEMENTS.map((achievement) => {
    const unlocked = state.achievements.has(achievement.id);
    return `
      <div class="badge${unlocked ? ' is-unlocked' : ''}" title="${escapeHTML(achievement.description)}">
        <span class="badge-icon" aria-hidden="true">${unlocked ? achievement.icon : '·'}</span>
        <span class="badge-copy"><strong>${escapeHTML(achievement.title)}</strong><span>${escapeHTML(achievement.description)}</span></span>
      </div>
    `;
  }).join('');
  dom.collectionCount.textContent = `${state.achievements.size} / ${ACHIEVEMENTS.length}`;
}

function unlockAchievement(id, { silent = false } = {}) {
  if (!ACHIEVEMENTS.some((achievement) => achievement.id === id)) return false;
  if (state.achievements.has(id)) return false;
  state.achievements.add(id);
  const achievement = ACHIEVEMENTS.find((item) => item.id === id);
  if (!silent) toast(achievement.title, achievement.description, 'warn', 3900);
  renderBadges();
  schedulePersist();
  return true;
}

function processAchievements(result) {
  const unlocked = [];
  const zeros = result.zeros_created;
  if (zeros > 0 && unlockAchievement('first-zero')) unlocked.push('Первый ноль');
  if (zeros >= 3 && unlockAchievement('triple')) unlocked.push('Тройной удар');
  state.stats.streak = zeros > 0 ? state.stats.streak + 1 : 0;
  if (state.stats.streak >= 3 && unlockAchievement('combo')) unlocked.push('Серия ×3');
  if (result.analysis.goal_met && unlockAchievement('finish', { silent: true })) {
    unlocked.push('Финиш');
  }
  return unlocked;
}

/* ---------- board operations ---------- */

function renderAll({ full = true } = {}) {
  if (full) {
    buildMatrixStructure();
  } else {
    // Cells have just been animated into place by animateOperation().
    // Re-rendering their contents here would cut the animation short.
    updateHighlights();
    updateRowAria();
  }
  updateSelectionUI();
  updateAnalysisUI();
  updateGoalButtons();
  updateControls();
  updateExpression();
  updatePreview();
  renderHistory();
  renderBadges();
  updateMeta();
  drawFlow();
}

function renderAllLight() {
  updateAnalysisUI();
  updateControls();
  updateExpression();
  updatePreview();
  renderHistory();
  updateMeta();
}

function updateMeta() {
  const inverse = isInverseMode();
  const equation = isEquationMode();
  dom.boardIndex.textContent = pad2(state.boardId);
  dom.presetName.textContent = state.presetName || 'Своя матрица';
  dom.matrixSize.textContent = state.matrix.length
    ? `${state.matrix.length} × ${state.matrix[0].length}`
    : '—';
  dom.matrixKind.textContent = inverse
    ? '[ A | I ] · ищем A⁻¹'
    : (equation
      ? (state.analysis?.goal_met ? '[ I | X ] · решение' : '[ A | B ] · ищем X')
      : (state.augmented > 0 ? 'расширенная матрица' : 'матрица коэффициентов'));
  dom.stageTitleLead.textContent = inverse
    ? 'Найдите'
    : (equation ? 'Решите' : 'Соберите');
  dom.stageTitleAccent.textContent = inverse
    ? 'обратную матрицу'
    : (equation
      ? 'матричное уравнение'
      : (state.goal === 'rref' ? 'приведённый вид' : 'ступенчатый вид'));
  dom.matrix.setAttribute(
    'aria-label',
    inverse
      ? 'Матрица A и единичная матрица I'
      : (equation ? 'Матрицы A и B в уравнении A·X = B' : 'Расширенная матрица'),
  );
}

async function applyOperation(opOverride = null, { fromHint = false } = {}) {
  if (state.busy || state.autoplay) return;
  const validation = opOverride
    ? { ok: true, op: opOverride }
    : validateOperation();
  if (!validation.ok) {
    toast('Пока нельзя', validation.error, 'warn');
    sfx.error();
    return;
  }
  const op = validation.op;
  state.busy = true;
  setBusy(true);
  updateControls();

  try {
    const requestOp = {
      op: op.kind,
      source: op.source,
      target: op.target,
      factor: op.factor ?? '1',
    };
    const result = await apiRequest('/operation', { ...boardPayload(), ...requestOp });
    await animateOperation(result, op);

    state.stats.totalOps += 1;
    const entry = {
      matrix: cloneMatrix(result.matrix),
      expression: result.expression,
      zeros: result.zeros_created,
      kind: 'op',
    };
    pushHistory(entry);
    state.analysis = result.analysis;
    state.hint = null;
    if (fromHint) {
      dom.hintBtn.innerHTML = 'Подсказать <kbd>H</kbd>';
    }

    if (result.analysis.goal_met) {
      state.selection = { source: null, target: null };
    } else if (op.kind === 'subtract' || op.kind === 'add') {
      state.selection = { source: op.source, target: null };
    } else {
      state.selection = { source: null, target: null };
    }

    updateSelectionUI();
    renderAll({ full: false });
    resetHintEmpty(result.analysis.goal_met);
    schedulePersist();

    const unlocked = processAchievements(result);

    if (result.zeros_created > 0) {
      const targetRow = $(`.matrix-row[data-row="${op.target}"]`, dom.matrix);
      confetti.burstAt(targetRow, Math.min(10 + result.zeros_created * 5, 38), 0.85);
      sfx.zero(result.zeros_created);
    } else {
      sfx.move();
    }

    if (result.analysis.goal_met && !state.winShown) {
      state.winShown = true;
      window.setTimeout(() => showWin(result, unlocked), 380);
    }
  } catch (error) {
    toast('Ход не принят', error.message, 'error', 4200);
    sfx.error();
    updateCellValues();
    updateHighlights();
    updateControls();
  } finally {
    state.busy = false;
    setBusy(false);
    updateControls();
  }
}

async function animateOperation(result, op) {
  const affectedRows = op.kind === 'swap'
    ? [op.source, op.target]
    : [op.target];
  const affectedCells = [];
  affectedRows.forEach((row) => {
    $$(`.matrix-row[data-row="${row}"] .cell-value`, dom.matrix).forEach((valueElement) => {
      valueElement.classList.add('is-changing');
      affectedCells.push(valueElement);
    });
  });

  await sleep(170);

  state.matrix = cloneMatrix(result.matrix);
  state.analysis = result.analysis;
  updateCellValues();
  updateHighlights();
  updateRowAria();

  affectedRows.forEach((row) => {
    const rowElement = $(`.matrix-row[data-row="${row}"]`, dom.matrix);
    if (!rowElement) return;
    rowElement.classList.add('is-flash');
    window.setTimeout(() => rowElement.classList.remove('is-flash'), 620);
    $$('.cell-value', rowElement).forEach((valueElement) => {
      valueElement.classList.add('is-entering');
      window.setTimeout(() => valueElement.classList.remove('is-entering'), 520);
    });
  });

  result.changed.forEach((change) => {
    if (!change.zeroed) return;
    const cell = $(`.matrix-cell[data-row="${change.row}"][data-col="${change.col}"] .cell-value`, dom.matrix);
    if (cell) {
      cell.classList.add('was-zeroed');
      window.setTimeout(() => cell.classList.remove('was-zeroed'), 650);
    }
  });

  await sleep(190);
}

/* ---------- win ---------- */

function showWin(result, unlocked) {
  if (!state.analysis) return;
  if (state.activeModal) closeModal();
  const analysis = result.analysis || state.analysis;
  const inverse = analysis.goal === 'inverse';
  const equation = analysis.goal === 'equation';
  const displayMatrix = inverse
    ? (analysis.inverse || [])
    : (equation ? (analysis.solution_matrix || []) : state.matrix);
  const coefficientCount = (inverse || equation)
    ? (displayMatrix[0]?.length || displayMatrix.length)
    : state.matrix[0].length - state.augmented;
  const fractions = matrixToFractions(displayMatrix);
  const solved = analysis.solution || [];
  const pivotColumns = new Set(analysis.pivot_columns || []);

  const rowsMarkup = fractions.map((row, rowIndex) => {
    let leading = -1;
    for (let column = 0; column < coefficientCount; column += 1) {
      if (!row[column].isZero()) {
        leading = column;
        break;
      }
    }
    const cells = [];
    row.forEach((value, column) => {
      if (!inverse && !equation && column === coefficientCount && state.augmented > 0) {
        cells.push('<span class="win-sep" aria-hidden="true">│</span>');
      }
      const classes = [
        !inverse && !equation && column >= coefficientCount ? 'win-rhs' : '',
        !inverse && !equation && column === leading && pivotColumns.has(column) ? 'win-pivot' : '',
      ].filter(Boolean).join(' ');
      cells.push(`<span class="${classes}">${fractionHTML(value)}</span>`);
    });
    return `<div class="win-matrix-row" data-row="${rowIndex}">${cells.join('')}</div>`;
  }).join('');
  dom.winMatrix.innerHTML = rowsMarkup;

  dom.winTitle.textContent = inverse
    ? 'Обратная найдена.'
    : (equation ? 'X найден.' : 'Красивая лестница.');
  dom.nextChallengeBtn.innerHTML = inverse
    ? 'Ещё одна матрица <span aria-hidden="true">→</span>'
    : (equation
      ? 'Ещё уравнение <span aria-hidden="true">→</span>'
      : 'Следующий вызов <span aria-hidden="true">→</span>');
  if (inverse) {
    const determinantValue = state.inverseDeterminant || analysis.determinant;
    dom.winSolution.innerHTML = `
      <span class="win-sol-chip">A⁻¹ <b>${analysis.rows}×${analysis.rows}</b></span>
      <span class="win-sol-chip">det A = <b>${escapeHTML(prettyValue(determinantValue))}</b></span>
    `;
  } else if (equation) {
    const determinantValue = state.inverseDeterminant || analysis.determinant;
    dom.winSolution.innerHTML = `
      <span class="win-sol-chip">X <b>${analysis.rows}×${analysis.augmented}</b></span>
      <span class="win-sol-chip">det A = <b>${escapeHTML(prettyValue(determinantValue))}</b></span>
    `;
  } else if (analysis.augmented === 0) {
    dom.winSolution.innerHTML = `<span class="win-sol-chip">rank = <b>${analysis.rank}</b></span>`;
  } else if (!analysis.consistent) {
    dom.winSolution.innerHTML = '<span class="win-sol-chip">система <b>несовместна</b></span>';
  } else if (solved.length) {
    dom.winSolution.innerHTML = solved.map((item) => (
      `<span class="win-sol-chip">${escapeHTML(item.name)} = <b>${escapeHTML(prettyValue(item.value))}</b></span>`
    )).join('');
  } else if (analysis.free_variables > 0) {
    dom.winSolution.innerHTML = `<span class="win-sol-chip">свободных: <b>${analysis.free_variables}</b></span>`;
  }

  const moves = state.historyIndex;
  dom.winSub.textContent = inverse
    ? `A⁻¹ · ${moves} ${plural(moves, 'ход', 'хода', 'ходов')} · точные дроби`
    : (equation
      ? `A·X = B · ${moves} ${plural(moves, 'ход', 'хода', 'ходов')} · точные дроби`
      : `${analysis.goal_label} · ${moves} ${plural(moves, 'ход', 'хода', 'ходов')} · точные дроби`);
  dom.winAchievements.innerHTML = unlocked.length
    ? unlocked.map((title) => `<span class="win-achievement">${escapeHTML(title)}</span>`).join('')
    : '';

  dom.winOverlay.hidden = false;
  syncBodyLock();
  confetti.celebrate();
  sfx.win();
  window.setTimeout(() => dom.nextChallengeBtn.focus({ preventScroll: true }), 80);
}

function closeWin() {
  dom.winOverlay.hidden = true;
  syncBodyLock();
}

function nextChallenge() {
  if (state.goal === 'inverse') {
    closeWin();
    openNewMatrixModal({ mode: 'inverse' });
    return;
  }
  if (state.goal === 'equation') {
    closeWin();
    openNewMatrixModal({ mode: 'equation' });
    return;
  }
  const presets = state.presets;
  if (!presets.length) {
    closeWin();
    return;
  }
  const current = presets.findIndex((preset) => preset.id === state.activePreset);
  const next = presets[(current + 1 + presets.length) % presets.length];
  closeWin();
  loadPreset(next, { announce: true }).catch((error) => {
    toast('Не удалось открыть вызов', error.message, 'error');
  });
}

/* ---------- board lifecycle ---------- */

async function loadPreset(preset, { announce = false } = {}) {
  if (!preset) return;
  const matrix = cloneMatrix(preset.matrix);
  const augmented = Number(preset.augmented || 0);
  const goal = ['inverse', 'equation'].includes(preset.goal)
    ? preset.goal
    : (preset.goal === 'rref' ? 'rref' : 'echelon');
  await openBoard({
    matrix,
    augmented,
    goal,
    name: preset.name,
    presetId: preset.id,
    resetStats: true,
  });
  if (announce) toast('Новый вызов', `${preset.name} · ${preset.note}`, 'info', 3000);
}

async function openBoard({ matrix, augmented, goal, name, presetId, resetStats = true }) {
  const analysis = await analyzeBoard(matrix, augmented, goal);
  state.matrix = cloneMatrix(matrix);
  state.augmented = augmented;
  state.goal = goal;
  state.inverseDeterminant = (goal === 'inverse' || goal === 'equation')
    ? determinantOf(leftBlock(matrix, augmented)).toString()
    : null;
  state.analysis = analysis;
  state.activePreset = presetId ?? null;
  state.presetName = name || 'Своя матрица';
  state.boardId = state.boardId + 1;
  state.selection = { source: null, target: null };
  state.history = [{
    matrix: cloneMatrix(matrix),
    expression: 'Старт',
    zeros: 0,
    kind: 'start',
  }];
  state.historyIndex = 0;
  state.basePlan = Math.max(analysis.remaining_steps, 1);
  state.hint = null;
  state.winShown = false;
  state.op = 'subtract';
  state.factor = '1';
  state.factorFrac = ONE;
  if (resetStats) {
    state.stats.streak = 0;
    state.stats.hintThisBoard = false;
    state.stats.undoThisBoard = false;
  }
  dom.factorInput.value = '1';
  dom.opTabs.forEach((tab) => {
    const active = tab.dataset.op === 'subtract';
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', String(active));
  });
  dom.factorField.classList.remove('is-hidden');
  renderAll({ full: true });
  resetHintEmpty(analysis.goal_met);
  dom.matrixScroll.scrollLeft = 0;
  schedulePersist();
}

/* ---------- persistence ---------- */

function schedulePersist() {
  if (!state.initialized) return;
  window.clearTimeout(state.persistTimer);
  state.persistTimer = window.setTimeout(persistBoard, 220);
}

function persistBoard() {
  if (!state.matrix.length) return;
  const snapshot = {
    version: 1,
    matrix: state.matrix,
    augmented: state.augmented,
    goal: state.goal,
    activePreset: state.activePreset,
    presetName: state.presetName,
    boardId: state.boardId,
    selection: state.selection,
    op: state.op,
    factor: state.factor,
    history: state.history,
    historyIndex: state.historyIndex,
    basePlan: state.basePlan,
    inverseDeterminant: state.inverseDeterminant,
    winShown: state.winShown,
    achievements: Array.from(state.achievements),
    stats: state.stats,
  };
  persistValue(STORAGE_KEY, JSON.stringify(snapshot));
}

function readSavedBoard() {
  const raw = storedValue(STORAGE_KEY);
  if (!raw) return null;
  try {
    const saved = JSON.parse(raw);
    if (!saved || saved.version !== 1) return null;
    if (!Array.isArray(saved.matrix) || !saved.matrix.length) return null;
    if (!Array.isArray(saved.matrix[0]) || !saved.matrix[0].length) return null;
    const width = saved.matrix[0].length;
    if (!saved.matrix.every((row) => Array.isArray(row) && row.length === width)) return null;
    if (!Number.isInteger(saved.augmented) || saved.augmented < 0 || saved.augmented >= width) return null;
    if (!['echelon', 'rref', 'inverse', 'equation'].includes(saved.goal)) return null;
    if (!Array.isArray(saved.history) || !saved.history.length) return null;
    const history = saved.history.filter((entry) => (
      entry && Array.isArray(entry.matrix)
      && entry.matrix.length === saved.matrix.length
      && entry.matrix.every((row) => Array.isArray(row) && row.length === width)
    ));
    if (!history.length) return null;
    const index = clamp(Number(saved.historyIndex) || 0, 0, history.length - 1);
    return { ...saved, history, historyIndex: index };
  } catch (error) {
    return null;
  }
}

async function restoreSavedBoard(saved) {
  const current = saved.history[saved.historyIndex]?.matrix || saved.matrix;
  const analysis = await analyzeBoard(current, saved.augmented, saved.goal);
  state.matrix = cloneMatrix(current);
  state.augmented = saved.augmented;
  state.goal = saved.goal;
  if (saved.goal === 'inverse' || saved.goal === 'equation') {
    const source = saved.history[0]?.matrix || current;
    const fromHistory = determinantOf(leftBlock(source, saved.augmented)).toString();
    const savedDeterminant = Frac.parse(saved.inverseDeterminant || '');
    state.inverseDeterminant = savedDeterminant ? savedDeterminant.toString() : fromHistory;
  } else {
    state.inverseDeterminant = null;
  }
  state.analysis = analysis;
  state.activePreset = saved.activePreset ?? null;
  state.presetName = saved.presetName || 'Своя матрица';
  state.boardId = Number(saved.boardId) || 1;
  state.history = saved.history.map((entry) => ({
    matrix: cloneMatrix(entry.matrix),
    expression: entry.expression || 'Старт',
    zeros: Number(entry.zeros) || 0,
    kind: entry.kind === 'start' ? 'start' : 'op',
  }));
  state.historyIndex = saved.historyIndex;
  state.basePlan = Math.max(Number(saved.basePlan) || analysis.remaining_steps, analysis.goal_met ? 1 : 1);
  state.winShown = Boolean(saved.winShown);
  state.achievements = new Set(Array.isArray(saved.achievements) ? saved.achievements : []);
  state.stats = {
    streak: Number(saved.stats?.streak) || 0,
    totalOps: Number(saved.stats?.totalOps) || 0,
    hintsUsed: Number(saved.stats?.hintsUsed) || 0,
    hintThisBoard: Boolean(saved.stats?.hintThisBoard),
    undoThisBoard: Boolean(saved.stats?.undoThisBoard),
  };
  state.op = OP_META[saved.op] ? saved.op : 'subtract';
  const factor = Frac.parse(saved.factor || '1');
  state.factorFrac = factor || ONE;
  state.factor = factor ? factor.toString() : '1';
  dom.factorInput.value = state.factor;
  dom.opTabs.forEach((tab) => {
    const active = tab.dataset.op === state.op;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', String(active));
  });
  dom.factorField.classList.toggle('is-hidden', state.op === 'swap');
  if (saved.selection && Number.isInteger(saved.selection.source) && saved.selection.source < current.length) {
    state.selection.source = saved.selection.source;
    state.selection.target = Number.isInteger(saved.selection.target)
      && saved.selection.target < current.length
      && saved.selection.target !== state.selection.source
      ? saved.selection.target
      : null;
  }
  renderAll({ full: true });
  resetHintEmpty(analysis.goal_met);
  state.initialized = true;
}

/* ---------- new-matrix modal ---------- */

function makeDefaultValues(rows, vars, augmented) {
  const values = [];
  for (let row = 0; row < rows; row += 1) {
    const line = [];
    for (let column = 0; column < vars; column += 1) {
      line.push(row === column ? '1' : '0');
    }
    if (augmented) line.push('0');
    values.push(line);
  }
  return values;
}

function openNewMatrixModal(options = {}) {
  const mode = options.mode
    || (isInverseMode() ? 'inverse' : (isEquationMode() ? 'equation' : 'system'));
  const coefficientCount = state.matrix.length
    ? state.matrix[0].length - state.augmented
    : 3;

  if (mode === 'inverse') {
    const currentA = state.matrix.length ? leftBlock() : null;
    const usableA = currentA
      && currentA.length >= 2
      && currentA.length <= 8
      && currentA.every((row) => row.length === currentA.length);
    const values = usableA ? currentA : makeInverseDefault();
    const size = values.length;
    state.editor = {
      mode: 'inverse',
      rows: size,
      vars: size,
      rhsCols: 0,
      aug: false,
      values,
      inverse: true,
      presetId: null,
      presetGoal: 'inverse',
    };
  } else if (mode === 'equation') {
    const source = (isEquationMode() || isInverseMode())
      ? (state.history[0]?.matrix || state.matrix)
      : state.matrix;
    const sourceAugmented = state.augmented;
    let matrixA = source.length ? leftBlock(source, sourceAugmented) : [];
    const usableA = matrixA.length >= 2
      && matrixA.length <= 8
      && matrixA.every((row) => row.length === matrixA.length);
    if (!usableA) matrixA = makeInverseDefault();
    const size = matrixA.length;
    let matrixB = !isInverseMode()
      ? rightBlock(source, sourceAugmented)
      : [];
    const validB = matrixB.length === size
      && matrixB.every((row) => row.length === (matrixB[0]?.length || 0))
      && (matrixB[0]?.length || 0) > 0;
    if (!validB) {
      matrixB = Array.from({ length: size }, (_, row) => [row === 0 ? '1' : '0']);
    }
    const maxRhs = Math.max(1, Math.min(8, 16 - size));
    matrixB = matrixB.map((row) => row.slice(0, maxRhs));
    const rhsCols = matrixB[0]?.length || 1;
    state.editor = {
      mode: 'equation',
      rows: size,
      vars: size,
      rhsCols,
      aug: true,
      values: matrixA.map((row, index) => [...row, ...(matrixB[index] || [])]),
      inverse: false,
      presetId: null,
      presetGoal: 'equation',
    };
  } else {
    const pristine = state.historyIndex === 0;
    state.editor = {
      mode: 'system',
      rows: state.matrix.length || 3,
      vars: coefficientCount || 3,
      rhsCols: state.augmented > 0 ? 1 : 0,
      aug: state.augmented > 0,
      values: state.matrix.length
        ? cloneMatrix(state.matrix)
        : makeDefaultValues(3, 3, true),
      inverse: false,
      presetId: pristine ? state.activePreset : null,
      presetGoal: pristine ? state.goal : null,
    };
  }
  syncEditorControls();
  renderEditor();
  renderPresetList();
  openModal(dom.newModal);
  window.setTimeout(() => {
    $('#matrixEditor input')?.focus({ preventScroll: true });
  }, 80);
}

function syncEditorControls() {
  if (!state.editor) return;
  const mode = state.editor.mode || 'system';
  const inverse = mode === 'inverse';
  const equation = mode === 'equation';
  dom.rowsCount.textContent = String(state.editor.rows);
  dom.varsCount.textContent = String(state.editor.vars);
  dom.rhsColsCount.textContent = String(editorRhsCols());
  dom.varsLabel.textContent = (inverse || equation) ? 'столбцов A' : 'неизвестных';
  dom.rowsLabel.textContent = (inverse || equation) ? 'строк A' : 'уравнений';
  dom.augToggle.checked = mode === 'system' ? Boolean(state.editor.aug) : false;
  dom.newModalTitle.textContent = inverse
    ? 'Соберите матрицу A'
    : (equation ? 'Соберите A и B' : 'Соберите матрицу');
  dom.inverseNote.hidden = !inverse;
  dom.equationNote.hidden = !equation;
  dom.rhsToggleControl.hidden = mode !== 'system';
  dom.rhsColsControl.hidden = !equation;
  dom.matrixEditor.classList.toggle('is-inverse', inverse);
  dom.matrixEditor.classList.toggle('is-equation', equation);
}

function resizeEditorValues(rows, vars, rhsCols) {
  const old = state.editor;
  const oldVars = old.vars;
  const oldRhs = editorRhsCols(old);
  const newCols = vars + rhsCols;
  const values = [];
  for (let row = 0; row < rows; row += 1) {
    const line = [];
    for (let column = 0; column < newCols; column += 1) {
      let value = '0';
      if (row < old.rows) {
        if (column < vars) {
          value = old.values[row]?.[column] ?? '0';
        } else {
          const oldRhsIndex = column - vars;
          if (oldRhsIndex < oldRhs) {
            value = old.values[row]?.[oldVars + oldRhsIndex] ?? '0';
          }
        }
      }
      line.push(value);
    }
    values.push(line);
  }
  old.rows = rows;
  old.vars = vars;
  old.rhsCols = rhsCols;
  old.aug = rhsCols > 0;
  old.values = values;
  old.presetId = null;
  old.presetGoal = null;
}

function editDimension(kind, delta) {
  if (!state.editor) return;
  const editor = state.editor;
  const mode = editor.mode || 'system';
  if (kind === 'rhsCols') {
    if (mode !== 'equation') return;
    const maxRhs = Math.max(1, Math.min(8, 16 - editor.vars));
    const next = clamp(editor.rhsCols + delta, 1, maxRhs);
    if (next === editor.rhsCols) return;
    resizeEditorValues(editor.rows, editor.vars, next);
  } else if (mode === 'inverse' || mode === 'equation') {
    const current = kind === 'rows' ? editor.rows : editor.vars;
    const next = clamp(current + delta, 2, 8);
    if (next === current) return;
    resizeEditorValues(next, next, mode === 'equation' ? editor.rhsCols : 0);
  } else if (kind === 'rows') {
    const next = clamp(editor.rows + delta, 2, 8);
    if (next === editor.rows) return;
    resizeEditorValues(next, editor.vars, editorRhsCols(editor));
  } else if (kind === 'vars') {
    const maxVars = editorRhsCols(editor) > 0 ? 9 : 10;
    const next = clamp(editor.vars + delta, 1, maxVars);
    if (next === editor.vars) return;
    resizeEditorValues(editor.rows, next, editorRhsCols(editor));
  }
  syncEditorControls();
  renderEditor();
  renderPresetList();
  sfx.click();
}

function renderEditor() {
  if (!state.editor) return;
  const { rows, vars, values, mode } = state.editor;
  const inverse = mode === 'inverse';
  const equation = mode === 'equation';
  const rhsCols = editorRhsCols();
  const columns = vars + rhsCols;
  dom.matrixEditor.style.setProperty('--ecols', String(columns));
  const names = (inverse || equation)
    ? Array.from({ length: vars }, (_, index) => `a${subscript(index + 1)}`)
    : variableNames(vars);
  const header = ['<div class="editor-header"><span></span>'];
  for (let column = 0; column < vars; column += 1) {
    header.push(`<span>${escapeHTML(names[column])}</span>`);
  }
  for (let rhs = 0; rhs < rhsCols; rhs += 1) {
    const label = equation ? `b${subscript(rhs + 1)}` : 'b';
    header.push(`<span class="is-rhs">${label}</span>`);
  }
  header.push('</div>');

  const body = [];
  for (let row = 0; row < rows; row += 1) {
    const cells = [`<span class="editor-tag">R${row + 1}</span>`];
    for (let column = 0; column < columns; column += 1) {
      const isRhs = column >= vars;
      const rhsIndex = column - vars;
      cells.push(`
        <input
          type="text"
          inputmode="text"
          autocomplete="off"
          spellcheck="false"
          data-editor-row="${row}"
          data-editor-col="${column}"
          value="${escapeHTML(values[row]?.[column] ?? '0')}"
          aria-label="${isRhs
            ? `${equation ? `Столбец B${rhsIndex + 1}` : 'Правая часть'}, строка ${row + 1}`
            : `Строка ${row + 1}, ${names[column] || `x${column + 1}`}`}"
          class="${isRhs ? 'is-rhs' : ''}"
        >
      `);
    }
    body.push(`<div class="editor-row">${cells.join('')}</div>`);
  }
  dom.matrixEditor.innerHTML = header.join('') + body.join('');
}

function validateEditorValue(input) {
  const value = input.value.trim();
  if (!value) {
    input.classList.remove('is-invalid');
    return true;
  }
  const parsed = Frac.parse(value, { emptyZero: true });
  const valid = Boolean(parsed);
  input.classList.toggle('is-invalid', !valid);
  return valid;
}

function collectEditorValues() {
  if (!state.editor) return null;
  const inputs = $$('input[data-editor-row]', dom.matrixEditor);
  let valid = true;
  const values = Array.from({ length: state.editor.rows }, () => (
    Array.from({ length: state.editor.vars + editorRhsCols() }, () => '0')
  ));
  for (const input of inputs) {
    const row = Number(input.dataset.editorRow);
    const column = Number(input.dataset.editorCol);
    const parsed = Frac.parse(input.value, { emptyZero: true });
    if (!parsed) {
      input.classList.add('is-invalid');
      valid = false;
      continue;
    }
    input.classList.remove('is-invalid');
    values[row][column] = parsed.toString();
    state.editor.values[row][column] = input.value;
  }
  if (!valid) {
    const firstInvalid = $('input.is-invalid', dom.matrixEditor);
    firstInvalid?.focus();
    toast('Проверьте клетки', 'Дробь вводится как 1/2 или −3/4. Пустая клетка — это ноль.', 'warn', 4200);
    return null;
  }
  return values;
}

function renderPresetList() {
  if (!dom.presetList) return;
  if (!state.presets.length) {
    dom.presetList.innerHTML = '<p class="history-empty">Загрузка вызовов…</p>';
    return;
  }
  const selected = state.editor?.presetId;
  const mode = state.editor?.mode || 'system';
  const inverse = mode === 'inverse';
  const equation = mode === 'equation';
  dom.presetList.innerHTML = state.presets.map((preset) => {
    const rows = preset.matrix.length;
    const augmented = Number(preset.augmented || 0);
    const coefficients = preset.matrix[0].length - augmented;
    const cols = inverse || equation ? coefficients : preset.matrix[0].length;
    const size = inverse
      ? `${rows}×${coefficients}`
      : (equation ? `${rows}×${coefficients} + B` : `${rows}×${cols}`);
    return `
      <button class="preset-card${selected === preset.id ? ' is-active' : ''}" type="button" data-preset-id="${escapeHTML(preset.id)}">
        <span class="preset-accent" data-accent="${escapeHTML(preset.accent || 'violet')}"></span>
        <span class="preset-info"><strong>${escapeHTML(preset.name)}</strong><small>${escapeHTML(preset.note)}</small></span>
        <span class="preset-size">${size}</span>
      </button>
    `;
  }).join('');
}

function loadPresetIntoEditor(presetId) {
  const preset = state.presets.find((item) => item.id === presetId);
  if (!preset || !state.editor) return;
  const augmented = Number(preset.augmented || 0);
  const coefficients = preset.matrix[0].length - augmented;
  const mode = state.editor.mode || 'system';
  if (mode === 'inverse') {
    if (preset.matrix.length !== coefficients) {
      toast('Не квадратная A', 'Этот пример не подходит для режима обратной матрицы.', 'warn');
      return;
    }
    state.editor.rows = coefficients;
    state.editor.vars = coefficients;
    state.editor.rhsCols = 0;
    state.editor.aug = false;
    state.editor.values = preset.matrix.map((row) => row.slice(0, coefficients));
    state.editor.presetId = preset.id;
    state.editor.presetGoal = 'inverse';
  } else if (mode === 'equation') {
    if (preset.matrix.length !== coefficients) {
      toast('Не квадратная A', 'Для A·X = B нужна квадратная матрица A.', 'warn');
      return;
    }
    const maxRhs = Math.max(1, Math.min(8, 16 - coefficients));
    const rhsCols = Math.max(1, Math.min(augmented || 1, maxRhs));
    const matrixB = preset.matrix.map((row, index) => {
      const existing = row.slice(coefficients, coefficients + rhsCols);
      if (existing.length) return existing;
      return [index === 0 ? '1' : '0'];
    });
    state.editor.rows = coefficients;
    state.editor.vars = coefficients;
    state.editor.rhsCols = rhsCols;
    state.editor.aug = true;
    state.editor.values = preset.matrix.map((row, index) => [
      ...row.slice(0, coefficients),
      ...matrixB[index],
    ]);
    state.editor.presetId = preset.id;
    state.editor.presetGoal = 'equation';
  } else {
    state.editor.rows = preset.matrix.length;
    state.editor.vars = coefficients;
    state.editor.rhsCols = augmented > 0 ? 1 : 0;
    state.editor.aug = augmented > 0;
    state.editor.values = cloneMatrix(preset.matrix);
    state.editor.presetId = preset.id;
    state.editor.presetGoal = preset.goal;
  }
  syncEditorControls();
  renderEditor();
  renderPresetList();
  sfx.click();
}

function randomEditor() {
  if (!state.editor) return;
  const mode = state.editor.mode || 'system';
  if (mode === 'inverse') {
    const size = 2 + Math.floor(Math.random() * 4);
    state.editor.rows = size;
    state.editor.vars = size;
    state.editor.rhsCols = 0;
    state.editor.aug = false;
    state.editor.values = randomInvertibleMatrix(size);
    state.editor.presetId = null;
    state.editor.presetGoal = 'inverse';
  } else if (mode === 'equation') {
    const size = 2 + Math.floor(Math.random() * 3);
    const rhsCols = 1 + Math.floor(Math.random() * Math.min(3, 16 - size));
    const matrixA = randomInvertibleMatrix(size);
    const matrixB = matrixA.map(() => (
      Array.from({ length: rhsCols }, () => String(Math.floor(Math.random() * 11) - 5))
    ));
    state.editor.rows = size;
    state.editor.vars = size;
    state.editor.rhsCols = rhsCols;
    state.editor.aug = true;
    state.editor.values = matrixA.map((row, index) => [...row, ...matrixB[index]]);
    state.editor.presetId = null;
    state.editor.presetGoal = 'equation';
  } else {
    const rows = 2 + Math.floor(Math.random() * 4);
    const vars = 2 + Math.floor(Math.random() * 3);
    const aug = Math.random() > 0.16;
    const values = [];
    for (let row = 0; row < rows; row += 1) {
      const line = [];
      for (let column = 0; column < vars; column += 1) {
        let value = Math.floor(Math.random() * 11) - 5;
        if (row === column && value === 0) value = 1;
        line.push(String(value));
      }
      if (aug) line.push(String(Math.floor(Math.random() * 13) - 6));
      values.push(line);
    }
    state.editor.rows = rows;
    state.editor.vars = vars;
    state.editor.rhsCols = aug ? 1 : 0;
    state.editor.aug = aug;
    state.editor.values = values;
    state.editor.presetId = null;
    state.editor.presetGoal = null;
  }
  syncEditorControls();
  renderEditor();
  renderPresetList();
  sfx.click();
}

async function createBoardFromEditor() {
  if (!state.editor) return;
  const values = collectEditorValues();
  if (!values) return;
  const mode = state.editor.mode || 'system';
  const inverse = mode === 'inverse';
  const equation = mode === 'equation';
  const rhsCols = editorRhsCols();
  if (state.editor.rows < 2) {
    toast('Нужно две строки', 'Для преобразований строк нужна хотя бы одна пара.', 'warn');
    return;
  }
  if ((inverse || equation) && state.editor.rows !== state.editor.vars) {
    toast('Нужна квадратная A', 'Число строк и столбцов матрицы A должно совпадать.', 'warn');
    return;
  }
  if (equation && rhsCols < 1) {
    toast('Нужна матрица B', 'Добавьте хотя бы один столбец B.', 'warn');
    return;
  }
  if (equation && state.editor.vars + rhsCols > 16) {
    toast('Слишком широко', 'Максимум 16 столбцов в доске A·X = B.', 'warn');
    return;
  }
  if (!inverse && !equation && state.editor.vars + rhsCols > 10) {
    toast('Слишком широко', 'Максимум 10 столбцов вместе с правой частью.', 'warn');
    return;
  }
  dom.createBoardBtn.disabled = true;
  const originalLabel = dom.createBoardBtn.innerHTML;
  dom.createBoardBtn.textContent = 'Проверяем…';
  try {
    const preset = state.presets.find((item) => item.id === state.editor.presetId);
    let matrix = values;
    let augmented;
    let goal;
    let name;
    let toastTitle;
    let toastText;
    if (inverse) {
      const size = values.length;
      matrix = boardWithIdentity(values);
      augmented = size;
      goal = 'inverse';
      name = `Обратная ${size}×${size}`;
      toastTitle = 'Режим A⁻¹';
      toastText = 'Слева A, справа I. Приведите левую часть к I — справа появится A⁻¹.';
    } else if (equation) {
      augmented = rhsCols;
      goal = 'equation';
      name = `A·X = B · B ${state.editor.rows}×${rhsCols}`;
      toastTitle = 'Режим A·X = B';
      toastText = 'Слева A, справа B. Приведите A к I — справа появится X.';
    } else {
      augmented = rhsCols;
      goal = preset?.goal === 'rref' ? 'rref' : (preset?.goal === 'echelon' ? 'echelon' : state.goal);
      name = preset?.name || 'Своя матрица';
      toastTitle = 'Доска готова';
      toastText = 'Выберите строку-источник — и вперёд.';
    }
    await openBoard({
      matrix,
      augmented,
      goal,
      name,
      presetId: preset?.id || null,
      resetStats: true,
    });
    closeModal(dom.newModal);
    if (!TOUCH_DEVICE) {
      toast(toastTitle, toastText, 'success', 2900);
    }
  } catch (error) {
    toast('Матрица не принята', error.message, 'error', 4200);
  } finally {
    dom.createBoardBtn.disabled = false;
    dom.createBoardBtn.innerHTML = originalLabel;
  }
}

/* ---------- stats/periodic ---------- */

function bindEvents() {
  dom.matrix.addEventListener('click', (event) => {
    const row = event.target.closest('.matrix-row');
    if (!row) return;
    selectRow(Number(row.dataset.row));
  });

  dom.matrix.addEventListener('keydown', (event) => {
    const row = event.target.closest('.matrix-row');
    if (!row) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      selectRow(Number(row.dataset.row));
    }
  });

  dom.matrix.addEventListener('mouseover', (event) => {
    const row = event.target.closest('.matrix-row');
    if (!row || state.selection.source === null || state.selection.target !== null) return;
    if (state.op === 'scale') return;
    const index = Number(row.dataset.row);
    if (index === state.selection.source) return;
    row.classList.add('is-hover-target');
  });

  dom.matrix.addEventListener('mouseout', (event) => {
    const row = event.target.closest('.matrix-row');
    row?.classList.remove('is-hover-target');
  });

  dom.clearSelectionBtn.addEventListener('click', () => clearSelection());

  dom.opTabs.forEach((tab) => {
    tab.addEventListener('click', () => setOperation(tab.dataset.op));
  });

  $$('.goal-switch button').forEach((button) => {
    button.addEventListener('click', () => setGoal(button.dataset.goal));
  });

  dom.factorInput.addEventListener('input', (event) => {
    updateFactor(event.target.value, { fromInput: true });
  });
  dom.factorDown.addEventListener('click', () => stepFactor(-1));
  dom.factorUp.addEventListener('click', () => stepFactor(1));
  dom.factorQuick.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-factor]');
    if (!button) return;
    updateFactor(button.dataset.factor);
    sfx.click();
  });

  dom.applyBtn.addEventListener('click', () => { void applyOperation(); });
  dom.undoBtn.addEventListener('click', undo);
  dom.redoBtn.addEventListener('click', redo);
  dom.resetBtn.addEventListener('click', resetBoard);

  dom.soundBtn.addEventListener('click', () => {
    state.soundEnabled = !state.soundEnabled;
    sfx.setEnabled(state.soundEnabled);
    persistValue(SOUND_KEY, state.soundEnabled ? '1' : '0');
    dom.soundBtn.classList.toggle('sound-off', !state.soundEnabled);
    dom.soundBtn.setAttribute('aria-pressed', String(state.soundEnabled));
    dom.soundBtn.title = state.soundEnabled ? 'Звук включён' : 'Звук выключен';
    if (state.soundEnabled) sfx.click();
  });

  dom.newBtn.addEventListener('click', () => openNewMatrixModal());
  dom.helpBtn.addEventListener('click', () => openModal(dom.helpModal));

  dom.hintBtn.addEventListener('click', () => { void requestHint(); });
  dom.hintSlot.addEventListener('click', (event) => {
    const action = event.target.closest('[data-hint-action]')?.dataset.hintAction;
    if (action === 'apply') void applyHint();
    if (action === 'refresh') void requestHint();
  });

  dom.historyList.addEventListener('click', (event) => {
    const button = event.target.closest('[data-history-index]');
    if (!button) return;
    void jumpTo(Number(button.dataset.historyIndex));
  });

  dom.winOverlay.addEventListener('click', (event) => {
    if (event.target.closest('.win-backdrop')) closeWin();
  });
  dom.nextChallengeBtn.addEventListener('click', nextChallenge);
  dom.stayBtn.addEventListener('click', closeWin);

  $$('[data-close-modal]').forEach((element) => {
    element.addEventListener('click', () => closeModal(element.closest('.modal-layer')));
  });

  dom.rowsCount.closest('.mini-stepper')?.querySelectorAll('[data-step]').forEach((button) => {
    button.addEventListener('click', () => editDimension(button.dataset.step, Number(button.dataset.delta)));
  });
  dom.varsCount.closest('.mini-stepper')?.querySelectorAll('[data-step]').forEach((button) => {
    button.addEventListener('click', () => editDimension(button.dataset.step, Number(button.dataset.delta)));
  });
  dom.rhsColsControl.querySelectorAll('[data-step]').forEach((button) => {
    button.addEventListener('click', () => editDimension(button.dataset.step, Number(button.dataset.delta)));
  });

  dom.augToggle.addEventListener('change', () => {
    if (!state.editor || state.editor.mode !== 'system') return;
    const augmented = dom.augToggle.checked;
    const vars = augmented ? Math.min(state.editor.vars, 9) : state.editor.vars;
    resizeEditorValues(state.editor.rows, vars, augmented ? 1 : 0);
    syncEditorControls();
    renderEditor();
    renderPresetList();
    sfx.click();
  });

  dom.matrixEditor.addEventListener('input', (event) => {
    const input = event.target.closest('input[data-editor-row]');
    if (!input || !state.editor) return;
    validateEditorValue(input);
    const row = Number(input.dataset.editorRow);
    const column = Number(input.dataset.editorCol);
    if (state.editor.values[row]) state.editor.values[row][column] = input.value;
    if (state.editor.presetId) {
      state.editor.presetId = null;
      state.editor.presetGoal = null;
      renderPresetList();
    }
  });

  dom.matrixEditor.addEventListener('keydown', (event) => {
    const input = event.target.closest('input[data-editor-row]');
    if (!input) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      void createBoardFromEditor();
    }
  });

  dom.presetList.addEventListener('click', (event) => {
    const card = event.target.closest('[data-preset-id]');
    if (!card) return;
    loadPresetIntoEditor(card.dataset.presetId);
  });

  dom.randomBtn.addEventListener('click', randomEditor);
  dom.createBoardBtn.addEventListener('click', () => { void createBoardFromEditor(); });

  document.addEventListener('keydown', handleGlobalKeydown);
  window.addEventListener('resize', () => { drawFlow(); });
  dom.matrixScroll.addEventListener('scroll', drawFlow, { passive: true });
}

function handleGlobalKeydown(event) {
  if (event.key === 'Escape') {
    if (state.activeModal) {
      event.preventDefault();
      closeModal();
      return;
    }
    if (!dom.winOverlay.hidden) {
      event.preventDefault();
      closeWin();
      return;
    }
    if (state.selection.source !== null || state.selection.target !== null) {
      event.preventDefault();
      clearSelection();
      return;
    }
  }

  if (state.activeModal) {
    if (event.key === 'Tab') {
      trapFocus(event, state.activeModal);
    }
    return;
  }

  if (!dom.winOverlay.hidden) {
    if (event.key === 'Tab') trapFocus(event, dom.winOverlay);
    return;
  }

  const target = event.target;
  const isTyping = target instanceof HTMLElement
    && (target.matches('input, textarea, select') || target.isContentEditable);
  if (isTyping) return;

  const modifier = event.ctrlKey || event.metaKey;

  if (modifier && event.key.toLowerCase() === 'z') {
    event.preventDefault();
    if (event.shiftKey) redo(); else undo();
    return;
  }
  if (modifier && event.key.toLowerCase() === 'y') {
    event.preventDefault();
    redo();
    return;
  }
  if (modifier || event.altKey) return;

  if (event.key === '?') {
    event.preventDefault();
    openModal(dom.helpModal);
    return;
  }
  if (event.key.toLowerCase() === 'h') {
    event.preventDefault();
    void requestHint();
    return;
  }
  if (event.key.toLowerCase() === 'u') {
    event.preventDefault();
    undo();
    return;
  }
  if (event.key === 'Enter') {
    if (!dom.applyBtn.disabled) {
      event.preventDefault();
      void applyOperation();
    }
    return;
  }
  if (['1', '2', '3', '4'].includes(event.key)) {
    const kinds = ['subtract', 'add', 'swap', 'scale'];
    setOperation(kinds[Number(event.key) - 1]);
    return;
  }
  if (event.key === 'Escape') {
    clearSelection();
  }
}

function trapFocus(event, layer) {
  const focusable = $$(
    'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
    layer,
  ).filter((element) => element.offsetParent !== null || element === document.activeElement);
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

/* ---------- boot ---------- */

async function boot() {
  dom.soundBtn.classList.toggle('sound-off', !state.soundEnabled);
  dom.soundBtn.setAttribute('aria-pressed', String(state.soundEnabled));
  dom.soundBtn.title = state.soundEnabled ? 'Звук включён' : 'Звук выключен';
  sfx.setEnabled(state.soundEnabled);
  bindEvents();
  dom.footerVersion.textContent = 'v0.1';
  dom.hintBtn.disabled = true;

  try {
    const data = await getPresets();
    state.presets = data.presets || [];
    renderPresetList();

    const saved = readSavedBoard();
    if (saved) {
      try {
        await restoreSavedBoard(saved);
        state.initialized = true;
        updateControls();
        dom.hintBtn.disabled = false;
        return;
      } catch (error) {
        // A saved board can belong to an older engine version — fall back gracefully.
        console.warn('Saved board could not be restored:', error);
      }
    }

    if (state.presets.length) {
      await loadPreset(state.presets[0], { announce: false });
    } else {
      throw new ApiError('На сервере нет готовых досок.', 0);
    }
    state.initialized = true;
    dom.hintBtn.disabled = false;
    updateControls();
    schedulePersist();

    if (!storedValue(SEEN_KEY)) {
      persistValue(SEEN_KEY, '1');
      if (!TOUCH_DEVICE) {
        window.setTimeout(() => {
          toast(
            'Добро пожаловать в Gauss Studio',
            'Кликните по строке-источнику, затем по строке-цели. Клавиша H подскажет ход.',
            'info',
            4600,
          );
        }, 900);
      }
    }
  } catch (error) {
    dom.hintBtn.disabled = false;
    dom.matrix.innerHTML = `
      <div class="fatal-card">
        <span class="fatal-icon">!</span>
        <strong>Python-сервер не отвечает</strong>
        <p>${escapeHTML(error.message)}</p>
        <code>uv run gauss-studio</code>
      </div>
    `;
    toast('Не удалось открыть студию', error.message, 'error', 7000);
    console.error(error);
  }
}

void boot();
