'use strict';

/* ============================================================
   PWR-9 · Nuclear Reactor Simulator — application logic
   ============================================================ */

/* ── Utilities ─────────────────────────────────────────────── */

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const pad2 = (value) => String(value).padStart(2, '0');
const num = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/* ── Configuration ─────────────────────────────────────────── */

const CFG = {
  tickMs: 500,
  maxThermal: 2400,
  electricFactor: 0.75,
  tempAmbient: 40,
  tempNominal: 300,
  tempWarn: 322,
  tempTrip: 350,
  pressNominal: 155,
  pressWarn: 168,
  pressTrip: 180,
  sgNominal: 60,
  sgWarn: 30,
  sgTrip: 5,
  xenonWarn: 70,
  demandMin: 700,
  demandMax: 1300,
  demandStart: 1000,
  scoreBand: 120,
  ticksPerDay: 480,
  minPerTick: 3,
  startMinute: 6 * 60,
  historyLength: 120,
  saveVersion: 2
};

const SAVE_KEY = 'pwr9.save';
const SETTINGS_KEY = 'pwr9.settings';

/* ── Scenarios ─────────────────────────────────────────────── */

const SCENARIOS = {
  normal: {
    id: 'normal',
    name: 'Standard Operation',
    tag: 'TRAINING',
    profile: 'normal',
    duration: 240,
    early: false,
    desc: 'Steady-state power operation. Match generation to grid demand.',
    objective: 'Hold output within ±120 MW of demand for at least 80% of the shift.',
    tips: [
      'Withdraw control rods to raise fission power, then open the steam valve to remove the extra heat.',
      'Keep core temperature near 300 °C. Above 322 °C the annunciator alerts; at 350 °C the reactor trips.',
      'Maintain steam generator level between 45% and 75% by balancing feedwater against steam flow.',
      'Xenon poison slowly builds at power. Dilute boron or withdraw rods to compensate.'
    ],
    setup: {},
    stableTarget: 0.8,
    progress: (m) => clamp(m.stableTicks / (m.duration * 0.8), 0, 1),
    success: (m) => m.stableTicks >= m.duration * 0.8 && !state.tripped
  },
  load: {
    id: 'load',
    name: 'Load Following',
    tag: 'DISPATCH',
    profile: 'volatile',
    duration: 240,
    early: false,
    desc: 'The grid is swinging hard. Track demand without overshooting.',
    objective: 'Stay within ±120 MW of demand for at least 70% of the shift.',
    tips: [
      'Demand now swings by hundreds of megawatts. Anticipate the ramp instead of chasing it.',
      'Move rods in small steps and use the steam valve to trim temperature.',
      'The co-pilot can help hold the setpoint while you manage the steam generator.',
      'Do not let the steam generator run dry during a load ramp.'
    ],
    setup: {},
    stableTarget: 0.7,
    progress: (m) => clamp(m.stableTicks / (m.duration * 0.7), 0, 1),
    success: (m) => m.stableTicks >= m.duration * 0.7 && !state.tripped
  },
  blackout: {
    id: 'blackout',
    name: 'Station Blackout',
    tag: 'EMERGENCY',
    profile: 'high',
    duration: 300,
    early: true,
    desc: 'Off-site power is lost. The primary pump has coasted to a stop.',
    objective: 'Restore primary flow and export at least 800 MW before the shift ends.',
    tips: [
      'Restart the primary pump immediately — without flow the core heats within seconds.',
      'Close the grid breaker once the generator is spinning again.',
      'Raise power with the control rods, then balance steam flow and feedwater.',
      'If the reactor trips, cool below 250 °C and 165 bar, reset the trip, then restart.'
    ],
    setup: {
      pump: false,
      breaker: false,
      rods: 50,
      valve: 72,
      feedwater: 50,
      coreTemp: 300,
      pressure: 155,
      sgLevel: 60,
      demand: 1150,
      xenon: 20,
      iodine: 55,
      boron: 420
    },
    target: 800,
    progress: () => clamp(state.output / 800, 0, 1),
    success: () => state.output >= 800 && !state.tripped
  },
  xenon: {
    id: 'xenon',
    name: 'Xenon Pit Recovery',
    tag: 'RECOVERY',
    profile: 'normal',
    duration: 300,
    early: true,
    desc: 'A xenon transient has poisoned the core. Recover useful power.',
    objective: 'Recover at least 700 MW of generation before the shift ends.',
    tips: [
      'Xenon absorbs neutrons. Dilute boron and withdraw rods to restore reactivity.',
      'Watch core temperature as power returns — open the steam valve to shed heat.',
      'Xenon slowly burns off once the core is back at power, which helps recovery.',
      'Do not trip the reactor: a trip creates a fresh xenon peak.'
    ],
    setup: {
      xenon: 85,
      iodine: 92,
      boron: 1350,
      rods: 55,
      valve: 60,
      feedwater: 50,
      coreTemp: 280,
      pressure: 150,
      demand: 1000
    },
    target: 700,
    progress: () => clamp(state.output / 700, 0, 1),
    success: () => state.output >= 700 && !state.tripped
  },
  cooldown: {
    id: 'cooldown',
    name: 'Emergency Cooldown',
    tag: 'SAFETY',
    profile: 'idle',
    duration: 360,
    early: true,
    desc: 'The reactor is tripped. Bring the plant to a safe cold state.',
    objective: 'Cool the core below 120 °C and the primary loop below 60 bar.',
    tips: [
      'Open the turbine steam valve to dump decay heat through the steam generator.',
      'Keep the primary pump running to carry decay heat to the steam generator.',
      'Use pressurizer spray to bring pressure down faster.',
      'The reactor is already tripped — do not reset the trip until the drill is complete.',
      'Feedwater keeps the steam generator inventory available as a heat sink.'
    ],
    setup: {
      tripped: true,
      tripReason: 'DRILL — EMERGENCY SHUTDOWN',
      rods: 100,
      breaker: false,
      pump: true,
      coreTemp: 335,
      pressure: 172,
      sgLevel: 60,
      valve: 0,
      feedwater: 60,
      demand: 0,
      xenon: 40,
      iodine: 55,
      decayHeat: 200
    },
    progress: (m) => {
      const tempPart = clamp((m.startTemp - state.coreTemp) / (m.startTemp - 120), 0, 1);
      const pressPart = clamp((m.startPress - state.pressure) / (m.startPress - 60), 0, 1);
      return clamp(tempPart * 0.6 + pressPart * 0.4, 0, 1);
    },
    success: () => state.coreTemp < 120 && state.pressure < 60
  },
  sandbox: {
    id: 'sandbox',
    name: 'Sandbox',
    tag: 'FREE PLAY',
    profile: 'normal',
    duration: 0,
    early: false,
    desc: 'No objective. Operate the plant freely and chase a high score.',
    objective: 'Keep generation matched to demand and keep the plant healthy.',
    tips: [
      'All controls are unlocked. Experiment with boron, rods, and steam flow.',
      'Trips are recoverable: cool the plant, reset the trip, then restart.',
      'Use SAVE to keep a snapshot of your best operating point.'
    ],
    setup: {},
    progress: () => 0,
    success: () => false
  }
};

const SCENARIO_ORDER = ['normal', 'load', 'blackout', 'xenon', 'cooldown', 'sandbox'];

/* ── Alarm definitions ─────────────────────────────────────── */

const ALARM_DEFS = {
  temp: { label: 'Core temperature high', test: (s) => s.coreTemp > CFG.tempWarn },
  press: { label: 'Pressurizer pressure high', test: (s) => s.pressure > CFG.pressWarn },
  sg: { label: 'Steam generator level low', test: (s) => s.sgLevel < CFG.sgWarn },
  pump: { label: 'Primary coolant pump stopped', test: (s) => !s.pump && !s.tripped && s.thermal > 100 },
  xenon: { label: 'Xenon poisoning rising', test: (s) => s.xenon > CFG.xenonWarn },
  grid: { label: 'Grid demand mismatch', test: (s) => !s.tripped && s.demand > 0 && Math.abs(s.demand - s.output) > 300 },
  trip: { label: 'Reactor trip active', test: (s) => s.tripped }
};

/* ── Mutable state ─────────────────────────────────────────── */

const state = {
  coreTemp: 300,
  pressure: 155,
  sgLevel: 62,
  boron: 380,
  xenon: 20,
  iodine: 60,
  rods: 8,
  pump: true,
  breaker: true,
  heater: false,
  spray: false,
  valve: 75,
  feedwater: 40,
  tripped: false,
  tripReason: '',
  output: 0,
  thermal: 0,
  decayHeat: 0,
  demand: 1000,
  score: 0,
  streak: 0,
  bestStreak: 0,
  day: 1,
  tick: 0,
  energyMWh: 0,
  uptimeTicks: 0,
  trips: 0,
  autoPilot: false,
  stableTicks: 0,
  alarms: {
    temp: { active: false, ack: false },
    press: { active: false, ack: false },
    sg: { active: false, ack: false },
    pump: { active: false, ack: false },
    xenon: { active: false, ack: false },
    grid: { active: false, ack: false },
    trip: { active: false, ack: false }
  }
};

const sim = {
  paused: false,
  speed: 1,
  dirty: false,
  lastSavedTick: -1,
  autosaveTick: 0
};

const mission = {
  id: 'normal',
  def: SCENARIOS.normal,
  duration: SCENARIOS.normal.duration,
  tick: 0,
  stableTicks: 0,
  status: 'active',
  startTemp: 300,
  startPress: 155
};

/* ── DOM references ────────────────────────────────────────── */

const ui = {
  statusPill: $('#status-pill'),
  statusText: $('#status-text'),
  dayVal: $('#day-val'),
  clockVal: $('#clock-val'),
  scoreVal: $('#score-val'),
  streakVal: $('#streak-val'),
  autopilotBtn: $('#autopilot-btn'),
  soundBtn: $('#sound-btn'),
  helpBtn: $('#help-btn'),
  scramBtn: $('#scram-btn'),

  scenarioGroup: $('#scenario-group'),
  pauseBtn: $('#pause-btn'),
  pauseLabel: $('#pause-label'),
  speedGroup: $('#speed-group'),
  saveBtn: $('#save-btn'),
  loadBtn: $('#load-btn'),
  newBtn: $('#new-btn'),

  annunciator: $('#annunciator'),
  alarms: {},
  gTemp: $('#g-temp'),
  gPress: $('#g-press'),
  gSg: $('#g-sg'),
  tempVal: $('#temp-val'),
  pressVal: $('#press-val'),
  sgVal: $('#sg-val'),
  demandVal: $('#demand-val'),
  demandBar: $('#demand-bar'),
  outputVal: $('#output-val'),
  outputBar: $('#output-bar'),
  thermalVal: $('#thermal-val'),
  thermalBar: $('#thermal-bar'),
  boronVal: $('#boron-val'),
  boronBar: $('#boron-bar'),
  xenonVal: $('#xenon-val'),
  xenonBar: $('#xenon-bar'),
  statEnergy: $('#stat-energy'),
  statUptime: $('#stat-uptime'),
  statTrips: $('#stat-trips'),
  statBest: $('#stat-best'),

  schematicCanvas: $('#schematic-canvas'),
  chartCanvas: $('#chart-canvas'),
  logList: $('#log-list'),
  logClear: $('#log-clear'),

  missionName: $('#mission-name'),
  missionDesc: $('#mission-desc'),
  missionObjective: $('#mission-objective'),
  missionTag: $('#mission-tag'),
  missionTimer: $('#mission-timer'),
  missionProgress: $('#mission-progress-bar'),
  missionBriefBtn: $('#mission-brief-btn'),
  missionRestartBtn: $('#mission-restart-btn'),

  rodSlider: $('#rod-slider'),
  rodVal: $('#rod-val'),
  rodDec: $('#rod-dec'),
  rodInc: $('#rod-inc'),
  rodAllOut: $('#rod-all-out'),
  rodAllIn: $('#rod-all-in'),
  valveSlider: $('#valve-slider'),
  valveVal: $('#valve-val'),
  feedwaterSlider: $('#feedwater-slider'),
  fwVal: $('#fw-val'),
  pumpBtn: $('#pump-btn'),
  breakerBtn: $('#breaker-btn'),
  heaterBtn: $('#heater-btn'),
  sprayBtn: $('#spray-btn'),
  boronSlider: $('#boron-slider'),
  boronCtlVal: $('#boron-ctl-val'),
  boronAdd: $('#boron-add'),
  boronSub: $('#boron-sub'),
  tripResetBtn: $('#trip-reset-btn'),
  tripNote: $('#trip-note'),
  controlTag: $('#control-tag'),

  hint: $('#hint'),
  simState: $('#sim-state'),
  speedVal: $('#speed-val'),
  fpsVal: $('#fps-val'),
  appVersion: $('#app-version'),

  toastStack: $('#toast-stack'),
  modalRoot: $('#modal-root'),
  modalTitle: $('#modal-title'),
  modalSubtitle: $('#modal-subtitle'),
  modalBody: $('#modal-body'),
  modalActions: $('#modal-actions'),
  modalClose: $('#modal-close'),
  modalBackdrop: $('#modal-backdrop'),

  winMin: $('#win-min'),
  winMax: $('#win-max'),
  winClose: $('#win-close')
};

$$('.alarm').forEach((el) => {
  ui.alarms[el.dataset.alarm] = el;
});

/* ── Audio engine ──────────────────────────────────────────── */

const audio = {
  ctx: null,
  enabled: true,
  lastAlarmAt: 0,

  ensure() {
    if (!this.enabled) return null;
    try {
      if (!this.ctx) {
        const Ctor = window.AudioContext || window.webkitAudioContext;
        if (!Ctor) return null;
        this.ctx = new Ctor();
      }
      if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
      return this.ctx;
    } catch {
      return null;
    }
  },

  tone({ freq = 440, dur = 0.08, type = 'sine', vol = 0.04, delay = 0, slide = null }) {
    const ctx = this.ensure();
    if (!ctx) return;
    try {
      const t0 = ctx.currentTime + delay;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, t0);
      if (slide) osc.frequency.exponentialRampToValueAtTime(Math.max(24, slide), t0 + dur);
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(vol, t0 + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t0);
      osc.stop(t0 + dur + 0.03);
    } catch {
      /* audio is a nicety, never fatal */
    }
  },

  click() {
    this.tone({ freq: 520, dur: 0.035, type: 'triangle', vol: 0.025 });
  },

  toggle(on) {
    this.tone({ freq: on ? 640 : 260, dur: 0.07, type: 'sine', vol: 0.04 });
  },

  alarm() {
    const stamp = nowMs();
    if (stamp - this.lastAlarmAt < 1600) return;
    this.lastAlarmAt = stamp;
    this.tone({ freq: 466, dur: 0.16, type: 'square', vol: 0.032 });
    this.tone({ freq: 349, dur: 0.16, type: 'square', vol: 0.032, delay: 0.18 });
  },

  success() {
    [523, 659, 784, 1047].forEach((freq, index) => {
      this.tone({ freq, dur: 0.16, type: 'triangle', vol: 0.04, delay: index * 0.11 });
    });
  },

  fail() {
    this.tone({ freq: 196, dur: 0.28, type: 'sawtooth', vol: 0.035, slide: 120 });
    this.tone({ freq: 147, dur: 0.4, type: 'sawtooth', vol: 0.03, delay: 0.24, slide: 90 });
  }
};

/* ── Event log ─────────────────────────────────────────────── */

const logEntries = [];

function log(level, message) {
  logEntries.push({ time: gameClockText(), level, message });
  if (logEntries.length > 160) logEntries.shift();
  renderLog();
}

function renderLog(scrollToEnd = false) {
  if (!ui.logList) return;
  const nearBottom =
    ui.logList.scrollHeight - ui.logList.scrollTop - ui.logList.clientHeight < 36;
  ui.logList.replaceChildren();
  if (!logEntries.length) {
    const empty = document.createElement('div');
    empty.className = 'log-empty';
    empty.textContent = 'No events recorded.';
    ui.logList.append(empty);
    return;
  }
  for (const entry of logEntries) {
    const row = document.createElement('div');
    row.className = `log-item ${entry.level}`;
    const time = document.createElement('span');
    time.className = 'log-time';
    time.textContent = entry.time;
    const message = document.createElement('span');
    message.className = 'log-msg';
    message.textContent = entry.message;
    row.append(time, message);
    ui.logList.append(row);
  }
  if (scrollToEnd || nearBottom) ui.logList.scrollTop = ui.logList.scrollHeight;
}

/* ── Toasts ────────────────────────────────────────────────── */

function dismissToast(node) {
  if (!node || node.classList.contains('is-leaving')) return;
  node.classList.add('is-leaving');
  setTimeout(() => node.remove(), 220);
}

function toast(level, title, message = '', ttl = 4400) {
  if (!ui.toastStack) return;
  while (ui.toastStack.children.length >= 4) {
    ui.toastStack.firstElementChild?.remove();
  }
  const node = document.createElement('div');
  node.className = `toast ${level}`;

  const dot = document.createElement('span');
  dot.className = 'toast-dot';

  const body = document.createElement('div');
  body.className = 'toast-body';
  const heading = document.createElement('strong');
  heading.textContent = title;
  body.append(heading);
  if (message) {
    const text = document.createElement('span');
    text.textContent = message;
    body.append(text);
  }

  const close = document.createElement('button');
  close.className = 'toast-close';
  close.type = 'button';
  close.setAttribute('aria-label', 'Dismiss notification');
  close.textContent = '×';
  close.addEventListener('click', () => dismissToast(node));

  node.append(dot, body, close);
  ui.toastStack.append(node);
  setTimeout(() => dismissToast(node), ttl);
}

/* ── Modal ─────────────────────────────────────────────────── */

let modalOpen = false;
let modalDismissible = true;
let lastFocused = null;

function openModal({ title, subtitle = '', body = '', actions = [], dismissible = true }) {
  if (!ui.modalRoot) return;
  lastFocused = document.activeElement;
  ui.modalTitle.textContent = title;
  ui.modalSubtitle.textContent = subtitle;
  ui.modalSubtitle.style.display = subtitle ? '' : 'none';
  ui.modalBody.innerHTML = body; // internal, trusted markup only
  ui.modalActions.replaceChildren();

  for (const action of actions) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `btn ${action.variant || 'btn-ghost'}`;
    button.textContent = action.label;
    button.addEventListener('click', () => {
      try {
        if (action.onClick) action.onClick();
      } finally {
        if (action.close !== false) closeModal();
      }
    });
    ui.modalActions.append(button);
  }

  modalDismissible = dismissible;
  ui.modalClose.style.display = dismissible ? '' : 'none';
  ui.modalRoot.classList.remove('hidden');
  modalOpen = true;
  renderHud();

  const focusTarget =
    ui.modalActions.querySelector('button') ||
    ui.modalClose ||
    ui.modalRoot;
  setTimeout(() => focusTarget?.focus?.(), 20);
}

function closeModal() {
  if (!ui.modalRoot) return;
  ui.modalRoot.classList.add('hidden');
  modalOpen = false;
  renderHud();
  if (lastFocused && typeof lastFocused.focus === 'function') {
    lastFocused.focus();
    lastFocused = null;
  }
}

ui.modalClose?.addEventListener('click', () => {
  if (modalDismissible) closeModal();
});
ui.modalBackdrop?.addEventListener('click', () => {
  if (modalDismissible) closeModal();
});

/* ── Persistence ───────────────────────────────────────────── */

const fallbackStore = {
  async save(payload) {
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify(payload));
      return { ok: true };
    } catch {
      return { ok: false };
    }
  },
  async load() {
    try {
      return JSON.parse(localStorage.getItem(SAVE_KEY) || 'null');
    } catch {
      return null;
    }
  },
  async clear() {
    try {
      localStorage.removeItem(SAVE_KEY);
      return { ok: true };
    } catch {
      return { ok: false };
    }
  }
};

const storeApi =
  window.desktop && window.desktop.store ? window.desktop.store : fallbackStore;

const STATE_KEYS = [
  'coreTemp', 'pressure', 'sgLevel', 'boron', 'xenon', 'iodine', 'rods',
  'pump', 'breaker', 'heater', 'spray', 'valve', 'feedwater',
  'tripped', 'tripReason', 'output', 'thermal', 'decayHeat', 'demand',
  'score', 'streak', 'bestStreak', 'day', 'tick', 'energyMWh',
  'uptimeTicks', 'trips', 'autoPilot', 'stableTicks'
];

function snapshot() {
  const savedState = {};
  for (const key of STATE_KEYS) savedState[key] = state[key];
  savedState.alarms = {};
  for (const id of Object.keys(state.alarms)) {
    savedState.alarms[id] = { ...state.alarms[id] };
  }
  return {
    version: CFG.saveVersion,
    savedAt: Date.now(),
    state: savedState,
    mission: {
      id: mission.id,
      tick: mission.tick,
      stableTicks: mission.stableTicks,
      status: mission.status,
      startTemp: mission.startTemp,
      startPress: mission.startPress
    },
    settings: {
      sound: audio.enabled,
      speed: sim.speed,
      paused: sim.paused
    }
  };
}

function applySnapshot(data) {
  if (!data || typeof data !== 'object') return false;
  const src = data.state;
  if (!src || typeof src !== 'object') return false;

  for (const key of STATE_KEYS) {
    if (src[key] !== undefined) state[key] = src[key];
  }

  state.coreTemp = clamp(num(state.coreTemp, 300), 20, 700);
  state.pressure = clamp(num(state.pressure, 155), 1, 220);
  state.sgLevel = clamp(num(state.sgLevel, 60), 0, 100);
  state.boron = clamp(num(state.boron, 420), 0, 2500);
  state.xenon = clamp(num(state.xenon, 28), 0, 100);
  state.iodine = clamp(num(state.iodine, 62), 0, 100);
  state.rods = clamp(num(state.rods, 12), 0, 100);
  state.valve = clamp(num(state.valve, 66), 0, 100);
  state.feedwater = clamp(num(state.feedwater, 40), 0, 100);
  state.demand = clamp(num(state.demand, 1000), 0, CFG.demandMax);
  state.thermal = clamp(num(state.thermal, 0), 0, CFG.maxThermal);
  state.decayHeat = clamp(num(state.decayHeat, 0), 0, CFG.maxThermal);
  state.score = Math.max(0, Math.round(num(state.score, 0)));
  state.streak = Math.max(0, Math.round(num(state.streak, 0)));
  state.bestStreak = Math.max(0, Math.round(num(state.bestStreak, 0)));
  state.day = Math.max(1, Math.round(num(state.day, 1)));
  state.tick = Math.max(0, Math.round(num(state.tick, 0)));
  state.energyMWh = Math.max(0, num(state.energyMWh, 0));
  state.uptimeTicks = Math.max(0, Math.round(num(state.uptimeTicks, 0)));
  state.trips = Math.max(0, Math.round(num(state.trips, 0)));
  state.stableTicks = Math.max(0, Math.round(num(state.stableTicks, 0)));
  state.pump = Boolean(state.pump);
  state.breaker = Boolean(state.breaker);
  state.heater = Boolean(state.heater);
  state.spray = Boolean(state.spray);
  state.tripped = Boolean(state.tripped);
  state.autoPilot = Boolean(state.autoPilot);
  state.tripReason = typeof state.tripReason === 'string' ? state.tripReason : '';

  for (const id of Object.keys(state.alarms)) {
    const saved = src.alarms && src.alarms[id];
    state.alarms[id] = {
      active: Boolean(saved && saved.active),
      ack: Boolean(saved && saved.ack)
    };
  }

  const savedMission = data.mission || {};
  if (SCENARIOS[savedMission.id]) {
    mission.id = savedMission.id;
    mission.def = SCENARIOS[mission.id];
    mission.duration = mission.def.duration;
    mission.tick = Math.max(0, Math.round(num(savedMission.tick, 0)));
    mission.stableTicks = Math.max(0, Math.round(num(savedMission.stableTicks, 0)));
    mission.status = ['active', 'complete', 'failed'].includes(savedMission.status)
      ? savedMission.status
      : 'active';
    mission.startTemp = num(savedMission.startTemp, state.coreTemp);
    mission.startPress = num(savedMission.startPress, state.pressure);
  }

  if (data.settings) {
    audio.enabled = data.settings.sound !== false;
    sim.speed = [1, 2, 4].includes(num(data.settings.speed, 1)) ? num(data.settings.speed, 1) : 1;
    sim.paused = Boolean(data.settings.paused);
  }

  resetHistory();
  updateScenarioButtons();
  updateSpeedButtons();
  renderAll();
  return true;
}

async function saveGame(manual = true) {
  try {
    const result = await storeApi.save(snapshot());
    if (result && result.ok === false) {
      throw new Error(result.error || 'The save file could not be written.');
    }
    sim.dirty = false;
    sim.lastSavedTick = state.tick;
    if (manual) {
      log('success', 'Shift saved to disk');
      toast('success', 'Shift saved', 'Your operating state is stored locally.');
    } else {
      log('info', 'Autosave complete');
    }
    return true;
  } catch (error) {
    if (manual) toast('danger', 'Save failed', String(error.message || error));
    return false;
  }
}

async function loadGame(manual = true) {
  try {
    const data = await storeApi.load();
    if (!data) {
      if (manual) toast('warn', 'No save found', 'Save a shift first, then load it here.');
      return false;
    }
    if (!applySnapshot(data)) {
      if (manual) toast('danger', 'Save unreadable', 'The saved file is not valid.');
      return false;
    }
    sim.dirty = false;
    if (manual) {
      log('success', 'Saved shift loaded');
      toast('success', 'Shift loaded', 'Plant state restored from disk.');
    }
    return true;
  } catch (error) {
    if (manual) toast('danger', 'Load failed', String(error.message || error));
    return false;
  }
}

async function clearSave() {
  try {
    await storeApi.clear();
  } catch {
    /* ignore */
  }
}

function loadSettings() {
  try {
    const raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    audio.enabled = raw.sound !== false;
    sim.speed = [1, 2, 4].includes(num(raw.speed, 1)) ? num(raw.speed, 1) : 1;
  } catch {
    /* defaults */
  }
}

function saveSettings() {
  try {
    localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({ sound: audio.enabled, speed: sim.speed })
    );
  } catch {
    /* ignore */
  }
}

/* ── History buffers ───────────────────────────────────────── */

const history = [];

function resetHistory() {
  history.length = 0;
  for (let i = 0; i < CFG.historyLength; i++) {
    history.push({ demand: state.demand, output: state.output, temp: state.coreTemp });
  }
}

/**
 * Recomputes the instantaneous operating point after a scenario reset so the
 * first rendered frame shows the real plant state instead of zeros.
 */
function primePlant() {
  const s = state;
  const reactivity =
    ((100 - s.rods) / 100) *
    clamp(1 - s.boron / 3000, 0, 1) *
    clamp(1 - s.xenon / 500, 0, 1);

  if (s.tripped) {
    s.thermal = Math.max(num(s.decayHeat, 0), 0);
  } else {
    s.thermal = reactivity * CFG.maxThermal;
    s.decayHeat = s.thermal * 0.06;
  }

  const steamFlow = (s.valve / 100) * (s.sgLevel < 25 ? s.sgLevel / 25 : 1);
  const tempEff = clamp((s.coreTemp - 120) / 180, 0, 1);
  const canGenerate =
    s.breaker && s.pump && s.sgLevel > 8 && s.coreTemp > 160 && !s.tripped;
  s.output = canGenerate
    ? Math.round(s.thermal * CFG.electricFactor * steamFlow * tempEff)
    : 0;
}

function pushHistory() {
  history.push({ demand: state.demand, output: state.output, temp: state.coreTemp });
  if (history.length > CFG.historyLength) history.shift();
}

/* ── Time formatting ───────────────────────────────────────── */

function gameClockText() {
  const minutes = (CFG.startMinute + (state.tick % CFG.ticksPerDay) * CFG.minPerTick) % 1440;
  return `${pad2(Math.floor(minutes / 60))}:${pad2(minutes % 60)}`;
}

function formatShift(ticks) {
  const total = Math.max(0, Math.round(ticks)) * CFG.minPerTick;
  return `${pad2(Math.floor(total / 60))}:${pad2(total % 60)}`;
}

function formatUptime(ticks) {
  const seconds = Math.max(0, Math.round(ticks)) * (CFG.tickMs / 1000);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return h > 0 ? `${h}h ${pad2(m)}m` : `${pad2(m)}:${pad2(s)}`;
}

/* ── Scenario lifecycle ────────────────────────────────────── */

function resetPlant(overrides = {}) {
  Object.assign(
    state,
    {
      coreTemp: 300,
      pressure: 155,
      sgLevel: 62,
      boron: 380,
      xenon: 20,
      iodine: 60,
      rods: 8,
      pump: true,
      breaker: true,
      heater: false,
      spray: false,
      valve: 75,
      feedwater: 40,
      tripped: false,
      tripReason: '',
      output: 0,
      thermal: 0,
      decayHeat: 0,
      demand: CFG.demandStart,
      autoPilot: false
    },
    overrides
  );

  state.coreTemp = clamp(num(state.coreTemp, 300), 20, 700);
  state.pressure = clamp(num(state.pressure, 155), 1, 220);
  state.sgLevel = clamp(num(state.sgLevel, 62), 0, 100);
  state.boron = clamp(num(state.boron, 380), 0, 2500);
  state.xenon = clamp(num(state.xenon, 20), 0, 100);
  state.iodine = clamp(num(state.iodine, 60), 0, 100);
  state.rods = clamp(num(state.rods, 8), 0, 100);
  state.valve = clamp(num(state.valve, 75), 0, 100);
  state.feedwater = clamp(num(state.feedwater, 40), 0, 100);
  state.demand = clamp(num(state.demand, CFG.demandStart), 0, CFG.demandMax);
  state.pump = Boolean(state.pump);
  state.breaker = Boolean(state.breaker);
  state.heater = Boolean(state.heater);
  state.spray = Boolean(state.spray);
  state.tripped = Boolean(state.tripped);
  state.autoPilot = Boolean(state.autoPilot);
  state.streak = 0;
  state.stableTicks = 0;
  if (state.tripped) {
    // A scenario that begins shut down still carries fission-product decay heat.
    state.decayHeat = Math.max(num(state.decayHeat, 0), 80);
    state.thermal = state.decayHeat;
  } else {
    state.decayHeat = 0;
  }
}

function loadScenario(id, { silent = false } = {}) {
  const def = SCENARIOS[id] || SCENARIOS.normal;
  mission.id = def.id;
  mission.def = def;
  mission.duration = def.duration;
  mission.tick = 0;
  mission.stableTicks = 0;
  mission.status = 'active';

  resetPlant(def.setup || {});
  if (def.profile === 'idle') state.demand = 0;
  mission.startTemp = state.coreTemp;
  mission.startPress = state.pressure;

  for (const alarmId of Object.keys(state.alarms)) {
    state.alarms[alarmId] = { active: false, ack: false };
  }

  primePlant();
  resetHistory();
  sim.dirty = true;
  updateScenarioButtons();
  renderAll();

  if (!silent) {
    log('info', `Drill loaded — ${def.name}`);
    toast('info', def.name, def.desc);
  }
}

function restartDrill() {
  const id = mission.id;
  loadScenario(id, { silent: true });
  log('info', `Drill restarted — ${mission.def.name}`);
  toast('info', 'Drill restarted', mission.def.name);
}

function updateScenarioButtons() {
  $$('.seg-btn', ui.scenarioGroup).forEach((button) => {
    button.classList.toggle('is-active', button.dataset.scenario === mission.id);
  });
}

function updateSpeedButtons() {
  $$('.speed-btn', ui.speedGroup).forEach((button) => {
    button.classList.toggle('is-active', Number(button.dataset.speed) === sim.speed);
  });
}

function nextScenarioId() {
  const index = SCENARIO_ORDER.indexOf(mission.id);
  return SCENARIO_ORDER[(index + 1) % SCENARIO_ORDER.length];
}

function resetProgress() {
  state.score = 0;
  state.streak = 0;
  state.bestStreak = 0;
  state.day = 1;
  state.tick = 0;
  state.energyMWh = 0;
  state.uptimeTicks = 0;
  state.trips = 0;
  state.stableTicks = 0;
  sim.lastSavedTick = -1;
  sim.dirty = true;
  logEntries.length = 0;
  renderLog(true);
}

/* ── Core simulation ───────────────────────────────────────── */

function physicsStep() {
  const s = state;
  s.tick += 1;
  s.uptimeTicks += 1;

  if (mission.status === 'active' && mission.duration > 0) mission.tick += 1;

  if (s.tick % CFG.ticksPerDay === 0) {
    s.day += 1;
    log('info', `Day ${s.day} begins — shift clock reset to 06:00`);
  }

  if (s.autoPilot && !s.tripped) autopilotStep();

  // Reactivity: rods, soluble boron, and xenon all absorb neutrons.
  const rodFactor = (100 - s.rods) / 100;
  const boronFactor = clamp(1 - s.boron / 3000, 0, 1);
  const xenonFactor = clamp(1 - s.xenon / 500, 0, 1);
  const reactivity = rodFactor * boronFactor * xenonFactor;

  if (s.tripped) {
    // Decay heat from fission products keeps the core warm after shutdown.
    // It fades slowly, so a cooldown still needs real heat removal.
    s.decayHeat = Math.max(0, num(s.decayHeat, 0) * 0.995);
    s.thermal = s.decayHeat;
  } else {
    s.thermal = reactivity * CFG.maxThermal;
    s.decayHeat = s.thermal * 0.06;
  }

  // Thermal inertia: temperature relaxes toward the power/flow equilibrium.
  const flowFactor = (s.pump ? 1 : 0.42) * (0.22 + 0.78 * (s.valve / 100));
  const tempEq = CFG.tempAmbient + s.thermal / (9.23 * Math.max(0.02, flowFactor));
  s.coreTemp += (tempEq - s.coreTemp) * 0.035;
  s.coreTemp = clamp(s.coreTemp, CFG.tempAmbient, 700);

  // Iodine / xenon dynamics. A power reduction creates a xenon peak.
  const powerFrac = s.thermal / CFG.maxThermal;
  s.iodine += (powerFrac * 100 - s.iodine) * 0.012;
  const xenonTarget = s.iodine * 0.85 * (1 - 0.25 * powerFrac);
  s.xenon = clamp(s.xenon + (xenonTarget - s.xenon) * 0.01, 0, 100);

  // Pressurizer: temperature-driven pressure with heater / spray authority.
  const pressureTarget =
    CFG.pressNominal +
    (s.coreTemp - CFG.tempNominal) * 0.55 +
    (s.heater ? 12 : 0) -
    (s.spray ? 14 : 0);
  s.pressure += (pressureTarget - s.pressure) * 0.22;
  s.pressure = clamp(s.pressure, 1, 220);

  // Steam generator inventory.
  const boilOff = (s.valve / 100) * powerFrac * (s.pump ? 0.9 : 0.06);
  const feedIn = (s.feedwater / 100) * 1.1;
  s.sgLevel = clamp(s.sgLevel + feedIn - boilOff, 0, 100);

  // Generator output.
  const steamFlow = (s.valve / 100) * (s.sgLevel < 25 ? s.sgLevel / 25 : 1);
  const tempEff = clamp((s.coreTemp - 120) / 180, 0, 1);
  const canGenerate =
    s.breaker && s.pump && s.sgLevel > 8 && s.coreTemp > 160 && !s.tripped;
  s.output = canGenerate
    ? Math.round(s.thermal * CFG.electricFactor * steamFlow * tempEff)
    : 0;

  updateDemand();

  // Scoring and statistics.
  if (!s.tripped) {
    const mismatch = Math.abs(s.demand - s.output);
    if (s.demand > 0 && mismatch <= CFG.scoreBand) {
      s.score += 10;
      s.streak += 1;
      if (s.streak > s.bestStreak) s.bestStreak = s.streak;
      if (mission.status === 'active') mission.stableTicks += 1;
    } else {
      s.score = Math.max(0, s.score - 5);
      s.streak = 0;
    }
    s.energyMWh += (s.output * (CFG.tickMs / 1000)) / 3600;
  }

  updateAlarms();
  checkTrips();
  checkMission();
  pushHistory();
  sim.dirty = true;
}

function updateDemand() {
  const profile = mission.def.profile;
  if (profile === 'idle') {
    state.demand = 0;
    return;
  }

  let center = 1000;
  let swing = 20;
  let waveAmp = 45;
  let wavePeriod = 26;
  if (profile === 'volatile') {
    center = 1040;
    swing = 55;
    waveAmp = 170;
    wavePeriod = 9;
  } else if (profile === 'high') {
    center = 1180;
    swing = 14;
    waveAmp = 30;
    wavePeriod = 30;
  }

  const target = center + Math.sin(state.tick / wavePeriod) * waveAmp;
  state.demand += (target - state.demand) * 0.09 + (Math.random() * 2 - 1) * swing * 0.45;
  state.demand = Math.round(clamp(state.demand, CFG.demandMin, CFG.demandMax));
}

function autopilotStep() {
  const s = state;
  const error = s.demand - s.output;
  if (Math.abs(error) > 50) {
    s.rods = clamp(s.rods + (error > 0 ? -0.9 : 0.9), 0, 100);
  }

  if (s.coreTemp > 307) s.valve = clamp(s.valve + 0.7, 0, 100);
  else if (s.coreTemp < 293) s.valve = clamp(s.valve - 0.7, 0, 100);

  if (s.sgLevel < 56) s.feedwater = clamp(s.feedwater + 0.7, 0, 100);
  else if (s.sgLevel > 66) s.feedwater = clamp(s.feedwater - 0.7, 0, 100);

  if (s.pressure > 162) {
    s.spray = true;
    s.heater = false;
  } else if (s.pressure < 147) {
    s.heater = true;
    s.spray = false;
  } else if (s.pressure > 150 && s.pressure < 160) {
    s.spray = false;
    s.heater = false;
  }
}

function updateAlarms() {
  for (const [id, def] of Object.entries(ALARM_DEFS)) {
    const active = Boolean(def.test(state));
    const alarm = state.alarms[id];
    if (active && !alarm.active) {
      alarm.active = true;
      alarm.ack = false;
      log(id === 'trip' ? 'danger' : 'warn', `ALARM — ${def.label}`);
      if (id !== 'trip') audio.alarm();
    } else if (!active && alarm.active) {
      alarm.active = false;
      alarm.ack = false;
    }
  }
}

function checkTrips() {
  const s = state;
  if (s.tripped) return;
  if (s.coreTemp >= CFG.tempTrip) return tripPlant('CORE OVER-TEMPERATURE');
  if (s.pressure >= CFG.pressTrip) return tripPlant('PRIMARY OVER-PRESSURE');
  if (s.sgLevel <= CFG.sgTrip && s.thermal > 120) return tripPlant('STEAM GENERATOR DRYOUT');
  return undefined;
}

function tripPlant(reason) {
  if (state.tripped) return;
  state.tripped = true;
  state.tripReason = reason;
  state.rods = 100;
  state.breaker = false;
  state.autoPilot = false;
  state.output = 0;
  state.decayHeat = Math.max(num(state.decayHeat, 0), state.thermal * 0.06);
  state.thermal = state.decayHeat;
  state.trips += 1;
  state.streak = 0;
  sim.dirty = true;

  updateAlarms();
  log('danger', `REACTOR TRIP — ${reason}`);
  toast('danger', 'Reactor trip', reason);
  audio.alarm();
  renderAll();
}

function resetTrip() {
  if (!state.tripped) return;
  if (state.coreTemp > 250 || state.pressure > 165) {
    toast('warn', 'Trip reset blocked', 'Cool below 250 °C and 165 bar before resetting.');
    return;
  }
  state.tripped = false;
  state.tripReason = '';
  sim.dirty = true;
  updateAlarms();
  log('success', 'Trip reset — reactor ready for restart');
  toast('success', 'Trip reset', 'Withdraw control rods to restart the reactor.');
  audio.toggle(true);
  renderAll();
}

/* ── Mission evaluation ────────────────────────────────────── */

function checkMission() {
  const def = mission.def;
  if (mission.status !== 'active') return;

  if (mission.duration > 0 && mission.tick >= mission.duration) {
    if (def.success(mission)) completeMission();
    else failMission();
    return;
  }

  if (def.early && mission.tick > 12 && def.success(mission)) {
    completeMission();
  }
}

function missionProgressValue() {
  if (mission.status === 'complete') return 1;
  if (mission.status === 'failed') return 0;
  if (!mission.def || typeof mission.def.progress !== 'function') return 0;
  return clamp(num(mission.def.progress(mission), 0), 0, 1);
}

function completeMission() {
  if (mission.status !== 'active') return;
  mission.status = 'complete';
  const bonus = 1000;
  state.score += bonus;
  sim.dirty = true;
  log('success', `Objective complete — ${mission.def.name} (+${bonus})`);
  toast('success', 'Objective complete', mission.def.name);
  audio.success();
  renderAll();
  showMissionResult(true);
}

function failMission() {
  if (mission.status !== 'active') return;
  mission.status = 'failed';
  sim.dirty = true;
  log('warn', `Shift ended — objective not met (${mission.def.name})`);
  toast('warn', 'Objective not met', mission.def.name);
  audio.fail();
  renderAll();
  showMissionResult(false);
}

/* ── UI rendering ──────────────────────────────────────────── */

const GAUGE_CIRCUMFERENCE = 2 * Math.PI * 42;

function setGauge(element, ratio, tone = null) {
  if (!element) return;
  const arc = element.querySelector('.gauge-arc');
  const value = clamp(num(ratio, 0), 0, 1);
  if (arc) {
    arc.style.strokeDasharray = String(GAUGE_CIRCUMFERENCE);
    arc.style.strokeDashoffset = String(GAUGE_CIRCUMFERENCE * (1 - value));
  }
  element.classList.toggle('is-warn', tone === 'warn');
  element.classList.toggle('is-danger', tone === 'danger');
}

function setBar(element, ratio) {
  if (!element) return;
  element.style.width = `${clamp(num(ratio, 0), 0, 1) * 100}%`;
}

function renderHud() {
  const s = state;
  ui.dayVal.textContent = String(s.day);
  ui.clockVal.textContent = gameClockText();
  ui.scoreVal.textContent = s.score.toLocaleString('en-US');
  ui.streakVal.textContent = String(s.streak);

  const anyAlarm = Object.values(s.alarms).some((alarm) => alarm.active);
  let statusState = 'nominal';
  let statusLabel = 'NOMINAL';
  if (s.tripped) {
    statusState = 'trip';
    statusLabel = 'TRIPPED';
  } else if (sim.paused || modalOpen) {
    statusState = 'paused';
    statusLabel = 'PAUSED';
  } else if (mission.status === 'complete') {
    statusState = 'complete';
    statusLabel = 'OBJECTIVE MET';
  } else if (anyAlarm) {
    statusState = 'warning';
    statusLabel = 'WARNING';
  }
  ui.statusPill.dataset.state = statusState;
  ui.statusText.textContent = statusLabel;
  ui.statusPill.title = s.tripped ? `Tripped: ${s.tripReason}` : '';

  ui.autopilotBtn.setAttribute('aria-pressed', String(s.autoPilot));
  ui.soundBtn.setAttribute('aria-pressed', String(audio.enabled));
  ui.pauseBtn.classList.toggle('is-paused', sim.paused);
  ui.pauseBtn.setAttribute('aria-pressed', String(sim.paused));
  ui.pauseLabel.textContent = sim.paused ? 'RESUME' : 'PAUSE';

  ui.simState.textContent = sim.paused ? 'PAUSED' : modalOpen ? 'DIALOG' : 'RUNNING';
  ui.simState.classList.toggle('is-paused', sim.paused || modalOpen);
  ui.speedVal.textContent = `${sim.speed}×`;
  ui.hint.textContent = getHint();

  ui.controlTag.textContent = s.tripped ? 'TRIPPED' : s.autoPilot ? 'CO-PILOT' : 'MANUAL';
  ui.controlTag.className =
    'panel-tag' + (s.tripped ? ' danger' : s.autoPilot ? ' success' : '');
}

function renderTelemetry() {
  const s = state;

  ui.tempVal.textContent = s.coreTemp.toFixed(0);
  ui.pressVal.textContent = s.pressure.toFixed(0);
  ui.sgVal.textContent = s.sgLevel.toFixed(0);

  setGauge(
    ui.gTemp,
    s.coreTemp / 400,
    s.coreTemp >= CFG.tempTrip ? 'danger' : s.coreTemp >= CFG.tempWarn ? 'warn' : null
  );
  setGauge(
    ui.gPress,
    s.pressure / 200,
    s.pressure >= CFG.pressTrip ? 'danger' : s.pressure >= CFG.pressWarn ? 'warn' : null
  );
  setGauge(
    ui.gSg,
    s.sgLevel / 100,
    s.sgLevel <= CFG.sgTrip ? 'danger' : s.sgLevel <= CFG.sgWarn ? 'warn' : null
  );

  ui.demandVal.textContent = s.demand > 0 ? `${s.demand} MW` : 'OFFLINE';
  ui.outputVal.textContent = `${s.output} MW`;
  ui.thermalVal.textContent = `${Math.round(s.thermal)} MWt`;
  ui.boronVal.textContent = `${Math.round(s.boron)} ppm`;
  ui.xenonVal.textContent = `${s.xenon.toFixed(0)}%`;

  setBar(ui.demandBar, s.demand / CFG.demandMax);
  setBar(ui.outputBar, s.output / CFG.demandMax);
  setBar(ui.thermalBar, s.thermal / CFG.maxThermal);
  setBar(ui.boronBar, s.boron / 2500);
  setBar(ui.xenonBar, s.xenon / 100);

  ui.statEnergy.textContent = `${s.energyMWh.toFixed(1)} MWh`;
  ui.statUptime.textContent = formatUptime(s.uptimeTicks);
  ui.statTrips.textContent = String(s.trips);
  ui.statBest.textContent = String(s.bestStreak);
}

const draggingSliders = new Set();

function setSliderFill(element) {
  if (!element) return;
  const min = num(element.min, 0);
  const max = num(element.max, 100);
  const value = num(element.value, min);
  const pct = max > min ? ((value - min) / (max - min)) * 100 : 0;
  element.style.setProperty('--pct', `${clamp(pct, 0, 100)}%`);
}

function setToggle(button, on, onText, offText) {
  if (!button) return;
  button.setAttribute('aria-pressed', String(on));
  const stateLabel = button.querySelector('.toggle-state');
  if (stateLabel) stateLabel.textContent = on ? onText : offText;
}

function renderControls() {
  const s = state;

  if (!draggingSliders.has('rod-slider')) ui.rodSlider.value = String(Math.round(s.rods));
  if (!draggingSliders.has('valve-slider')) ui.valveSlider.value = String(Math.round(s.valve));
  if (!draggingSliders.has('feedwater-slider')) ui.feedwaterSlider.value = String(Math.round(s.feedwater));
  if (!draggingSliders.has('boron-slider')) ui.boronSlider.value = String(Math.round(s.boron));
  [ui.rodSlider, ui.valveSlider, ui.feedwaterSlider, ui.boronSlider].forEach(setSliderFill);

  ui.rodVal.textContent = `${Math.round(s.rods)}%`;
  ui.valveVal.textContent = `${Math.round(s.valve)}%`;
  ui.fwVal.textContent = `${Math.round(s.feedwater)}%`;
  ui.boronCtlVal.textContent = `${Math.round(s.boron)} ppm`;

  ui.rodSlider.disabled = s.tripped;
  ui.rodDec.disabled = s.tripped;
  ui.rodInc.disabled = s.tripped;
  ui.rodAllOut.disabled = s.tripped;
  ui.rodAllIn.disabled = s.tripped;

  setToggle(ui.pumpBtn, s.pump, 'ON', 'OFF');
  setToggle(ui.breakerBtn, s.breaker, 'CLOSED', 'OPEN');
  setToggle(ui.heaterBtn, s.heater, 'ON', 'OFF');
  setToggle(ui.sprayBtn, s.spray, 'ON', 'OFF');

  const canReset = s.tripped && s.coreTemp <= 250 && s.pressure <= 165;
  ui.tripResetBtn.disabled = !canReset;
  if (s.tripped) {
    ui.tripNote.textContent = canReset
      ? 'Trip reset available — press R or use the button above.'
      : `Trip active: ${s.tripReason}. Cool below 250 °C and 165 bar.`;
    ui.tripNote.classList.toggle('is-ready', canReset);
  } else {
    ui.tripNote.textContent = 'Trip reset unlocks below 250 °C and 165 bar.';
    ui.tripNote.classList.remove('is-ready');
  }
}

function renderAlarms() {
  for (const [id, alarm] of Object.entries(state.alarms)) {
    const element = ui.alarms[id];
    if (!element) continue;
    element.classList.toggle('is-active', alarm.active);
    element.classList.toggle('is-ack', alarm.active && alarm.ack);
    const label = ALARM_DEFS[id] ? ALARM_DEFS[id].label : id;
    element.title = alarm.active
      ? `${label}${alarm.ack ? ' (acknowledged)' : ' — click to acknowledge'}`
      : label;
  }
}

function renderMission() {
  const def = mission.def;
  ui.missionName.textContent = def.name;
  ui.missionDesc.textContent = def.desc;
  ui.missionObjective.textContent = def.objective;

  let tag = def.tag;
  let tagClass = '';
  if (mission.status === 'complete') {
    tag = 'COMPLETE';
    tagClass = ' success';
  } else if (mission.status === 'failed') {
    tag = 'FAILED';
    tagClass = ' danger';
  }
  ui.missionTag.textContent = tag;
  ui.missionTag.className = `panel-tag${tagClass}`;

  ui.missionTimer.textContent =
    mission.duration > 0 ? formatShift(Math.max(0, mission.duration - mission.tick)) : '∞';

  const progress = missionProgressValue();
  ui.missionProgress.style.width = `${Math.round(progress * 100)}%`;
  ui.missionProgress.className =
    'progress-fill' +
    (mission.status === 'complete' ? ' is-complete' : mission.status === 'failed' ? ' is-failed' : '');
}

function renderAll() {
  renderHud();
  renderTelemetry();
  renderControls();
  renderAlarms();
  renderMission();
}

function getHint() {
  const s = state;
  if (s.tripped) {
    if (s.coreTemp > 250 || s.pressure > 165) {
      return 'Trip active — keep the primary pump running and cool below 250 °C / 165 bar to unlock reset.';
    }
    return 'Trip reset available. Press R, then withdraw control rods to restart the reactor.';
  }
  if (!s.pump) return 'Primary pump is OFF — restart it now (P) or the core will overheat within seconds.';
  if (!s.breaker) return 'Grid breaker is OPEN — close it (G) to export power.';
  if (s.coreTemp > 335) return 'Core temperature critical — open the steam valve or insert control rods.';
  if (s.coreTemp < 240) return 'Core is running cold — withdraw rods or close the steam valve slightly.';
  if (s.sgLevel < 35) return 'Steam generator level low — increase feedwater pump speed.';
  if (s.sgLevel > 85) return 'Steam generator level high — reduce feedwater pump speed.';
  if (s.pressure > 165) return 'Primary pressure high — enable pressurizer spray.';
  if (s.demand > 0 && Math.abs(s.demand - s.output) > 200) {
    return s.output < s.demand
      ? 'Generation below demand — withdraw rods or dilute boron to raise power.'
      : 'Generation above demand — insert rods or inject boron to lower power.';
  }
  return 'Hover the schematic for component telemetry. Press H for help.';
}

/* ── Modal content builders ────────────────────────────────── */

function showMissionResult(success) {
  const def = mission.def;
  const body = `
    <p>${success ? 'The shift objective was achieved.' : 'The shift ended before the objective was met.'}</p>
    <div class="brief-grid">
      <div class="brief-stat"><span>Drill</span><strong>${def.name}</strong></div>
      <div class="brief-stat"><span>Result</span><strong>${success ? 'COMPLETE' : 'FAILED'}</strong></div>
      <div class="brief-stat"><span>Output</span><strong>${state.output} MW</strong></div>
      <div class="brief-stat"><span>Score</span><strong>${state.score.toLocaleString('en-US')}</strong></div>
      <div class="brief-stat"><span>Energy</span><strong>${state.energyMWh.toFixed(1)} MWh</strong></div>
      <div class="brief-stat"><span>Trips</span><strong>${state.trips}</strong></div>
    </div>
    <p class="muted">${success
      ? 'Keep operating in free play, or move on to the next drill.'
      : 'Review the event log, then retry the drill or pick another one.'}</p>`;

  openModal({
    title: success ? 'Objective complete' : 'Objective failed',
    subtitle: def.name,
    body,
    dismissible: true,
    actions: [
      { label: success ? 'Continue operating' : 'Keep operating', variant: 'btn-ghost' },
      { label: 'Retry drill', variant: 'btn-ghost', onClick: () => restartDrill() },
      {
        label: 'Next drill',
        variant: 'btn-success',
        onClick: () => loadScenario(nextScenarioId())
      }
    ]
  });
}

function openMissionBrief() {
  const def = mission.def;
  const body = `
    <p>${def.desc}</p>
    <p><strong>Objective:</strong> ${def.objective}</p>
    <div class="brief-grid">
      <div class="brief-stat"><span>Shift length</span><strong>${def.duration ? formatShift(def.duration) : '∞'}</strong></div>
      <div class="brief-stat"><span>Grid profile</span><strong>${def.profile.toUpperCase()}</strong></div>
      <div class="brief-stat"><span>Day</span><strong>${state.day}</strong></div>
      <div class="brief-stat"><span>Score</span><strong>${state.score.toLocaleString('en-US')}</strong></div>
    </div>
    <h3>Operating notes</h3>
    <ul>${def.tips.map((tip) => `<li>${tip}</li>`).join('')}</ul>`;

  openModal({
    title: def.name,
    subtitle: def.tag,
    body,
    dismissible: true,
    actions: [
      { label: 'Close', variant: 'btn-ghost' },
      { label: 'Restart drill', variant: 'btn-ghost', onClick: () => restartDrill() }
    ]
  });
}

function openHelp() {
  const rows = [
    ['Space', 'Pause / resume'],
    ['S', 'SCRAM'],
    ['P', 'Toggle primary pump'],
    ['G', 'Toggle grid breaker'],
    ['R', 'Reset trip'],
    ['M', 'Mute / unmute sound'],
    ['H', 'Open this manual'],
    ['F', 'Toggle fullscreen'],
    ['1 – 6', 'Select drill']
  ];
  const body = `
    <p>PWR-9 is a pressurized water reactor simulator. Your job is to match grid demand with stable, safe generation.</p>
    <h3>Quick start</h3>
    <ul>
      <li><strong>Raise power</strong> by withdrawing control rods or diluting boron.</li>
      <li><strong>Shed heat</strong> by opening the turbine steam valve. More valve means cooler core.</li>
      <li><strong>Hold steam generator level</strong> near 60% by matching feedwater to steam flow.</li>
      <li><strong>Keep pressure</strong> near 155 bar using the pressurizer heater and spray.</li>
      <li><strong>Stay in the band:</strong> output within ±120 MW of demand scores points every tick.</li>
    </ul>
    <h3>Safety limits</h3>
    <ul>
      <li>Core temperature: warning above 322 °C, automatic trip at 350 °C.</li>
      <li>Primary pressure: warning above 168 bar, trip at 180 bar.</li>
      <li>Steam generator level: warning below 30%, trip at 5% with the core at power.</li>
      <li>Xenon builds at power and peaks after a trip, suppressing reactivity for a while.</li>
    </ul>
    <h3>Keyboard shortcuts</h3>
    <div class="kbd-grid">
      ${rows
        .map(
          ([key, action]) =>
            `<div class="kbd-row"><span>${action}</span><span class="kbd">${key}</span></div>`
        )
        .join('')}
    </div>
    <h3>Alarms</h3>
    <p class="muted">Annunciator tiles blink when a new alarm appears. Click a tile to acknowledge it. The trip alarm clears only when the trip is reset.</p>`;
  openModal({
    title: 'Operations manual',
    subtitle: 'Help & keyboard shortcuts',
    body,
    dismissible: true,
    actions: [{ label: 'Close', variant: 'btn-ghost' }]
  });
}

function showWelcome(saved) {
  let savedInfo = '';
  if (saved && saved.state) {
    const when = saved.savedAt ? new Date(saved.savedAt).toLocaleString() : 'unknown time';
    savedInfo = `
      <h3>Saved shift found</h3>
      <div class="brief-grid">
        <div class="brief-stat"><span>Drill</span><strong>${SCENARIOS[saved.mission?.id]?.name || 'Unknown'}</strong></div>
        <div class="brief-stat"><span>Score</span><strong>${num(saved.state.score, 0).toLocaleString('en-US')}</strong></div>
        <div class="brief-stat"><span>Day</span><strong>${num(saved.state.day, 1)}</strong></div>
        <div class="brief-stat"><span>Saved</span><strong>${when}</strong></div>
      </div>`;
  }

  const body = `
    <p>You are the shift supervisor of <strong>PWR-9</strong>, a pressurized water reactor connected to the grid. Balance power, heat, pressure, and water inventory to keep the plant online.</p>
    <h3>Your first shift</h3>
    <ul>
      <li>Watch <strong>grid demand</strong> and keep generator output inside the ±120 MW scoring band.</li>
      <li>Pull control rods to raise power; open the steam valve to remove heat.</li>
      <li>Balance feedwater so the steam generator stays near 60%.</li>
      <li>Keep core temperature near 300 °C. Above 350 °C the reactor trips.</li>
    </ul>
    <p class="muted">Tip: press <span class="kbd">H</span> at any time for the full operations manual.</p>
    ${savedInfo}`;

  const actions = [];
  if (saved) {
    actions.push({
      label: 'Resume saved shift',
      variant: 'btn-success',
      onClick: () => {
        loadGame(false);
      }
    });
  }
  actions.push({
    label: 'Begin standard shift',
    variant: 'btn-ghost',
    onClick: () => {
      loadScenario('normal', { silent: true });
      toast('info', 'Shift started', 'Standard operation drill loaded.');
    }
  });
  actions.push({
    label: 'How to play',
    variant: 'btn-ghost',
    close: false,
    onClick: () => openHelp()
  });

  openModal({
    title: 'Reactor control room online',
    subtitle: 'PWR-9 · Simulation v2.0',
    body,
    actions,
    dismissible: true
  });
}

/* ── Control actions ───────────────────────────────────────── */

function togglePump() {
  state.pump = !state.pump;
  audio.toggle(state.pump);
  log('info', `Primary pump ${state.pump ? 'started' : 'stopped'}`);
  if (!state.pump && state.thermal > 100) {
    toast('warn', 'Primary pump stopped', 'Core heat-up will begin within seconds.');
  }
  sim.dirty = true;
  renderAll();
}

function toggleBreaker() {
  state.breaker = !state.breaker;
  audio.toggle(state.breaker);
  log('info', `Grid breaker ${state.breaker ? 'closed' : 'opened'}`);
  sim.dirty = true;
  renderAll();
}

function toggleHeater() {
  state.heater = !state.heater;
  if (state.heater) state.spray = false;
  audio.toggle(state.heater);
  log('info', `Pressurizer heater ${state.heater ? 'enabled' : 'disabled'}`);
  sim.dirty = true;
  renderAll();
}

function toggleSpray() {
  state.spray = !state.spray;
  if (state.spray) state.heater = false;
  audio.toggle(state.spray);
  log('info', `Pressurizer spray ${state.spray ? 'enabled' : 'disabled'}`);
  sim.dirty = true;
  renderAll();
}

function toggleAutopilot() {
  if (state.tripped) {
    toast('warn', 'Co-pilot unavailable', 'Reset the trip before engaging automatic control.');
    return;
  }
  state.autoPilot = !state.autoPilot;
  audio.toggle(state.autoPilot);
  log('info', `Co-pilot ${state.autoPilot ? 'engaged' : 'disengaged'}`);
  if (state.autoPilot) {
    toast('info', 'Co-pilot engaged', 'Automatic rod, valve, feedwater and pressure control.');
  }
  sim.dirty = true;
  renderAll();
}

function toggleSound() {
  audio.enabled = !audio.enabled;
  audio.ensure();
  audio.toggle(audio.enabled);
  saveSettings();
  renderHud();
  log('info', `Sound ${audio.enabled ? 'enabled' : 'muted'}`);
}

function togglePause() {
  sim.paused = !sim.paused;
  audio.click();
  log('info', sim.paused ? 'Simulation paused' : 'Simulation resumed');
  renderAll();
}

function setSpeed(speed) {
  if (![1, 2, 4].includes(speed)) return;
  sim.speed = speed;
  saveSettings();
  audio.click();
  updateSpeedButtons();
  renderAll();
}

function setRods(value) {
  if (state.tripped) return;
  state.rods = clamp(Math.round(value), 0, 100);
  sim.dirty = true;
  renderAll();
}

function adjustRods(delta) {
  setRods(state.rods + delta);
}

function adjustBoron(delta) {
  state.boron = clamp(Math.round(state.boron + delta), 0, 2500);
  sim.dirty = true;
  audio.click();
  renderAll();
}

function requestScram() {
  if (state.tripped) {
    toast('warn', 'Reactor already tripped', state.tripReason || 'The plant is shut down.');
    return;
  }
  openModal({
    title: 'Emergency shutdown',
    subtitle: 'Manual SCRAM',
    body: '<p>Insert all control rods and open the grid breaker immediately?</p><p class="muted">The reactor will trip and require cooldown before it can be restarted.</p>',
    dismissible: true,
    actions: [
      { label: 'Cancel', variant: 'btn-ghost' },
      { label: 'SCRAM', variant: 'btn-danger', onClick: () => tripPlant('MANUAL SCRAM') }
    ]
  });
}

function toggleFullscreen() {
  try {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen();
  } catch {
    toast('warn', 'Fullscreen unavailable', 'The window manager rejected the request.');
  }
}

/* ── Canvas surfaces ───────────────────────────────────────── */

const surfaces = {
  schematic: {
    canvas: ui.schematicCanvas,
    ctx: ui.schematicCanvas.getContext('2d'),
    w: 1,
    h: 1,
    dpr: 1,
    scale: 1,
    ox: 0,
    oy: 0,
    mouse: { x: 0, y: 0 }
  },
  chart: {
    canvas: ui.chartCanvas,
    ctx: ui.chartCanvas.getContext('2d'),
    w: 1,
    h: 1,
    dpr: 1
  }
};

const VW = 760;
const VH = 400;
// Bounds actually used by the drawing; fitting to these avoids double letterboxing.
const VB = { x: 24, y: 8, w: 648, h: 358 };

function measureSurface(surface) {
  const host = surface.canvas.parentElement;
  if (!host) return;
  const rect = host.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.max(1, rect.width);
  const height = Math.max(1, rect.height);
  const pixelWidth = Math.max(1, Math.round(width * dpr));
  const pixelHeight = Math.max(1, Math.round(height * dpr));
  if (surface.canvas.width !== pixelWidth || surface.canvas.height !== pixelHeight) {
    surface.canvas.width = pixelWidth;
    surface.canvas.height = pixelHeight;
  }
  surface.w = width;
  surface.h = height;
  surface.dpr = dpr;
}

function initSurfaces() {
  const observer = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const surface = entry.target.__surface;
      if (surface) measureSurface(surface);
    }
  });
  for (const surface of Object.values(surfaces)) {
    const host = surface.canvas.parentElement;
    if (!host) continue;
    host.__surface = surface;
    observer.observe(host);
    measureSurface(surface);
  }
}

/* ── Schematic ─────────────────────────────────────────────── */

const COMPONENTS = [
  {
    id: 'core',
    name: 'Reactor Core',
    x: 34,
    y: 96,
    w: 96,
    h: 210,
    hint: 'Click to focus control rods',
    lines: (s) => [
      `${s.coreTemp.toFixed(0)} °C core`,
      `${Math.round(s.thermal)} MW thermal`,
      `Rods ${Math.round(s.rods)}% inserted`
    ]
  },
  {
    id: 'pressurizer',
    name: 'Pressurizer',
    x: 156,
    y: 22,
    w: 52,
    h: 100,
    hint: 'Click to toggle heater',
    lines: (s) => [
      `${s.pressure.toFixed(1)} bar`,
      `Heater ${s.heater ? 'ON' : 'OFF'}`,
      `Spray ${s.spray ? 'ON' : 'OFF'}`
    ]
  },
  {
    id: 'sg',
    name: 'Steam Generator',
    x: 250,
    y: 52,
    w: 86,
    h: 250,
    hint: 'Click to focus feedwater',
    lines: (s) => [
      `${s.sgLevel.toFixed(0)}% level`,
      `Feedwater ${Math.round(s.feedwater)}%`,
      `Steam valve ${Math.round(s.valve)}%`
    ]
  },
  {
    id: 'pump',
    name: 'Primary Pump',
    x: 180,
    y: 248,
    w: 44,
    h: 44,
    hint: 'Click to toggle pump',
    lines: (s) => [`Status ${s.pump ? 'RUNNING' : 'STOPPED'}`, `Flow ${s.pump ? 'nominal' : 'lost'}`]
  },
  {
    id: 'turbine',
    name: 'Steam Turbine',
    x: 470,
    y: 86,
    w: 104,
    h: 86,
    hint: 'Click to toggle breaker',
    lines: (s) => [
      `${s.output} MW output`,
      `Breaker ${s.breaker ? 'CLOSED' : 'OPEN'}`,
      `Steam ${Math.round(s.valve)}%`
    ]
  },
  {
    id: 'generator',
    name: 'Generator',
    x: 600,
    y: 100,
    w: 64,
    h: 58,
    hint: 'Click to toggle breaker',
    lines: (s) => [`${s.output} MW`, `Grid ${s.breaker ? 'SYNCED' : 'OFFLINE'}`]
  },
  {
    id: 'condenser',
    name: 'Condenser',
    x: 470,
    y: 286,
    w: 104,
    h: 64,
    hint: 'Click to focus steam valve',
    lines: (s) => [`Steam valve ${Math.round(s.valve)}%`, `Feedwater ${Math.round(s.feedwater)}%`]
  }
];

let hoveredComponent = null;
let flowPhase = 0;

function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

function drawPipe(ctx, points, width, color) {
  ctx.save();
  ctx.beginPath();
  points.forEach(([x, y], index) => (index ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.lineWidth = width;
  ctx.strokeStyle = color;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.stroke();
  ctx.restore();
}

function drawFlow(ctx, points, width, color, dashOffset) {
  ctx.save();
  ctx.beginPath();
  points.forEach(([x, y], index) => (index ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.lineWidth = Math.max(2, width * 0.34);
  ctx.strokeStyle = color;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.setLineDash([6, 15]);
  ctx.lineDashOffset = dashOffset;
  ctx.stroke();
  ctx.restore();
}

function drawSchematicGrid(ctx) {
  ctx.save();
  ctx.strokeStyle = 'rgba(148, 163, 184, 0.055)';
  ctx.lineWidth = 1;
  for (let x = 40; x < VW; x += 40) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, VH);
    ctx.stroke();
  }
  for (let y = 40; y < VH; y += 40) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(VW, y);
    ctx.stroke();
  }
  ctx.restore();
}

function drawCore(ctx, s) {
  const glow = clamp((s.coreTemp - 120) / 260, 0, 1);

  ctx.save();
  ctx.shadowColor = `rgba(248, 113, 113, ${0.12 + glow * 0.45})`;
  ctx.shadowBlur = 14 + glow * 26;
  roundRectPath(ctx, 34, 96, 96, 210, 16);
  ctx.fillStyle = '#040a14';
  ctx.fill();
  ctx.strokeStyle = glow > 0.35 ? `rgba(248, 113, 113, ${0.5 + glow * 0.5})` : '#475569';
  ctx.lineWidth = 2.5;
  ctx.stroke();
  ctx.restore();

  for (let i = 0; i < 3; i += 1) {
    const gradient = ctx.createLinearGradient(0, 150, 0, 268);
    gradient.addColorStop(0, `rgba(251, 191, 36, ${0.45 + glow * 0.55})`);
    gradient.addColorStop(1, `rgba(239, 68, 68, ${0.4 + glow * 0.55})`);
    ctx.fillStyle = gradient;
    roundRectPath(ctx, 50 + i * 26, 150, 14, 118, 3);
    ctx.fill();
  }

  ctx.fillStyle = '#94a3b8';
  const rodDepth = (s.rods / 100) * 120;
  for (let i = 0; i < 3; i += 1) {
    roundRectPath(ctx, 56 + i * 26, 110 + rodDepth, 5, 80, 2.5);
    ctx.fill();
  }

  ctx.strokeStyle = 'rgba(148, 163, 184, 0.18)';
  ctx.lineWidth = 1;
  roundRectPath(ctx, 42, 104, 80, 194, 12);
  ctx.stroke();

  ctx.strokeStyle = '#475569';
  ctx.lineWidth = 2;
  for (let i = 0; i < 3; i += 1) {
    ctx.beginPath();
    ctx.moveTo(57 + i * 26, 96);
    ctx.lineTo(57 + i * 26, 112);
    ctx.stroke();
  }
}

function drawPressurizer(ctx, s) {
  roundRectPath(ctx, 156, 22, 52, 100, 10);
  ctx.fillStyle = '#050c18';
  ctx.fill();
  ctx.strokeStyle = s.heater ? '#fbbf24' : '#64748b';
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.fillStyle = 'rgba(56, 189, 248, 0.22)';
  ctx.fillRect(158, 70, 48, 50);
  ctx.strokeStyle = 'rgba(125, 211, 252, 0.5)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(158, 70);
  ctx.lineTo(206, 70);
  ctx.stroke();

  if (s.heater) {
    ctx.save();
    ctx.strokeStyle = '#fbbf24';
    ctx.shadowColor = 'rgba(251, 191, 36, 0.7)';
    ctx.shadowBlur = 8;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(162, 114);
    ctx.lineTo(170, 108);
    ctx.lineTo(178, 114);
    ctx.lineTo(186, 108);
    ctx.lineTo(194, 114);
    ctx.stroke();
    ctx.restore();
  }

  if (s.spray) {
    ctx.fillStyle = 'rgba(125, 211, 252, 0.85)';
    for (let i = 0; i < 4; i += 1) {
      const y = 30 + ((flowPhase * 0.8 + i * 7) % 30);
      ctx.fillRect(164 + i * 9, y, 2, 5);
    }
  }
}

function drawSteamGenerator(ctx, s) {
  roundRectPath(ctx, 250, 52, 86, 250, 14);
  ctx.fillStyle = '#050c18';
  ctx.fill();
  ctx.strokeStyle = '#38bdf8';
  ctx.lineWidth = 2;
  ctx.stroke();

  const levelHeight = (s.sgLevel / 100) * 210;
  ctx.fillStyle = 'rgba(56, 189, 248, 0.17)';
  ctx.fillRect(252, 300 - levelHeight, 82, levelHeight);
  ctx.strokeStyle = 'rgba(125, 211, 252, 0.45)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(252, 300 - levelHeight);
  ctx.lineTo(334, 300 - levelHeight);
  ctx.stroke();

  ctx.strokeStyle = s.coreTemp > 150 ? '#f87171' : '#60a5fa';
  ctx.lineWidth = 3.5;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(270, 288);
  ctx.lineTo(270, 120);
  ctx.arc(293, 120, 23, Math.PI, 0, false);
  ctx.lineTo(316, 288);
  ctx.stroke();

  ctx.strokeStyle = '#475569';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(258, 292);
  ctx.lineTo(328, 292);
  ctx.stroke();
}

function drawPump(ctx, s) {
  const cx = 202;
  const cy = 270;

  ctx.save();
  if (s.pump) {
    ctx.shadowColor = 'rgba(52, 211, 153, 0.55)';
    ctx.shadowBlur = 14;
  }
  ctx.beginPath();
  ctx.arc(cx, cy, 21, 0, Math.PI * 2);
  ctx.fillStyle = s.pump ? '#065f46' : '#1e293b';
  ctx.fill();
  ctx.strokeStyle = s.pump ? '#34d399' : '#475569';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.restore();

  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(s.pump ? flowPhase * 0.06 : 0);
  ctx.strokeStyle = s.pump ? '#a7f3d0' : '#64748b';
  ctx.lineWidth = 2.5;
  ctx.lineCap = 'round';
  for (let i = 0; i < 3; i += 1) {
    ctx.rotate((Math.PI * 2) / 3);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(0, -13);
    ctx.stroke();
  }
  ctx.restore();
}

function drawTurbine(ctx, s) {
  roundRectPath(ctx, 470, 86, 104, 86, 10);
  ctx.fillStyle = '#050c18';
  ctx.fill();
  ctx.strokeStyle = s.breaker ? '#34d399' : '#475569';
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.save();
  ctx.translate(522, 129);
  ctx.rotate(s.output > 0 ? flowPhase * 0.05 : 0);
  ctx.strokeStyle = s.output > 0 ? '#38bdf8' : '#475569';
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  for (let i = 0; i < 6; i += 1) {
    ctx.rotate(Math.PI / 3);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(0, -24);
    ctx.stroke();
  }
  ctx.fillStyle = '#0ea5e9';
  ctx.beginPath();
  ctx.arc(0, 0, 3, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  ctx.strokeStyle = '#475569';
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.moveTo(574, 129);
  ctx.lineTo(600, 129);
  ctx.stroke();
}

function drawGenerator(ctx, s) {
  roundRectPath(ctx, 600, 100, 64, 58, 8);
  ctx.fillStyle = '#050c18';
  ctx.fill();
  ctx.strokeStyle = s.breaker ? '#34d399' : '#475569';
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.strokeStyle = 'rgba(167, 139, 250, 0.6)';
  ctx.lineWidth = 1.5;
  for (let i = 0; i < 4; i += 1) {
    ctx.beginPath();
    ctx.moveTo(612 + i * 13, 110);
    ctx.lineTo(612 + i * 13, 148);
    ctx.stroke();
  }
  ctx.fillStyle = s.breaker ? 'rgba(52, 211, 153, 0.9)' : 'rgba(148, 163, 184, 0.5)';
  ctx.beginPath();
  ctx.arc(632, 129, 4, 0, Math.PI * 2);
  ctx.fill();
}

function drawCondenser(ctx) {
  roundRectPath(ctx, 470, 286, 104, 64, 10);
  ctx.fillStyle = '#050c18';
  ctx.fill();
  ctx.strokeStyle = '#475569';
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.fillStyle = 'rgba(56, 189, 248, 0.13)';
  ctx.fillRect(472, 320, 100, 28);
  ctx.strokeStyle = 'rgba(125, 211, 252, 0.35)';
  ctx.lineWidth = 1;
  for (let row = 0; row < 2; row += 1) {
    ctx.beginPath();
    const y = 326 + row * 9;
    for (let x = 474; x <= 568; x += 8) {
      const wy = y + Math.sin((x + flowPhase * 0.6) / 9) * 2;
      if (x === 474) ctx.moveTo(x, wy);
      else ctx.lineTo(x, wy);
    }
    ctx.stroke();
  }
}

function drawLabels(ctx) {
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.font = '700 8px "Segoe UI", sans-serif';
  ctx.fillStyle = '#8b9bb3';
  ctx.fillText('REACTOR CORE', 82, 322);
  ctx.fillText('PRESSURIZER', 182, 16);
  ctx.fillText('STEAM GENERATOR', 293, 320);
  ctx.fillText('PRIMARY PUMP', 202, 304);
  ctx.fillText('TURBINE', 522, 188);
  ctx.fillText('GENERATOR', 632, 174);
  ctx.fillText('CONDENSER', 522, 282);

  ctx.font = '600 7px "Segoe UI", sans-serif';
  ctx.fillStyle = 'rgba(148, 163, 184, 0.55)';
  ctx.fillText('HOT LEG', 190, 133);
  ctx.fillText('COLD LEG', 190, 263);
  ctx.fillText('STEAM', 400, 19);
  ctx.fillText('FEEDWATER', 404, 313);
  ctx.restore();
}

function drawTooltip(ctx, comp, mouse) {
  const lines = comp.lines(state);
  const padding = 9;

  ctx.font = '700 10px "Segoe UI", sans-serif';
  let width = ctx.measureText(comp.name).width;
  ctx.font = '9px "Cascadia Code", monospace';
  for (const line of lines) width = Math.max(width, ctx.measureText(line).width);
  ctx.font = '8px "Segoe UI", sans-serif';
  width = Math.max(width, ctx.measureText(comp.hint).width);
  width += padding * 2;

  const height = 30 + (lines.length + 1) * 12 + padding;
  let x = mouse.x + 16;
  let y = mouse.y + 14;
  if (x + width > VW) x = mouse.x - width - 16;
  if (y + height > VH) y = mouse.y - height - 14;
  x = clamp(x, 4, VW - width - 4);
  y = clamp(y, 4, VH - height - 4);

  ctx.save();
  ctx.shadowColor = 'rgba(0, 0, 0, 0.55)';
  ctx.shadowBlur = 14;
  roundRectPath(ctx, x, y, width, height, 7);
  ctx.fillStyle = 'rgba(3, 8, 17, 0.96)';
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = 'rgba(251, 191, 36, 0.5)';
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#fbbf24';
  ctx.font = '700 10px "Segoe UI", sans-serif';
  ctx.fillText(comp.name, x + padding, y + 16);

  ctx.fillStyle = '#cbd5e1';
  ctx.font = '9px "Cascadia Code", monospace';
  lines.forEach((line, index) => ctx.fillText(line, x + padding, y + 30 + index * 12));

  ctx.fillStyle = 'rgba(148, 163, 184, 0.85)';
  ctx.font = '8px "Segoe UI", sans-serif';
  ctx.fillText(comp.hint, x + padding, y + 30 + lines.length * 12 + 2);
  ctx.restore();
}

function drawSchematic() {
  const surface = surfaces.schematic;
  const ctx = surface.ctx;
  const { w, h, dpr } = surface;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const scale = Math.max(0.01, Math.min(w / VB.w, h / VB.h));
  const ox = (w - VB.w * scale) / 2 - VB.x * scale;
  const oy = (h - VB.h * scale) / 2 - VB.y * scale;
  surface.scale = scale;
  surface.ox = ox;
  surface.oy = oy;

  ctx.save();
  ctx.translate(ox, oy);
  ctx.scale(scale, scale);

  drawSchematicGrid(ctx);

  const s = state;
  const hotColor = s.coreTemp > 300 ? '#f87171' : s.coreTemp > 180 ? '#fb923c' : '#60a5fa';
  const steamActive = s.valve > 1 && s.thermal > 80 && s.pump;
  const feedActive = s.feedwater > 1 && s.pump;

  drawPipe(ctx, [[130, 140], [250, 140]], 12, hotColor);
  drawPipe(ctx, [[250, 270], [130, 270]], 12, '#3b82f6');
  drawPipe(ctx, [[182, 122], [182, 140]], 7, hotColor);
  drawPipe(
    ctx,
    [[293, 52], [293, 26], [522, 26], [522, 86]],
    9,
    steamActive ? '#cbd5e1' : '#334155'
  );
  drawPipe(
    ctx,
    [[470, 320], [336, 320], [336, 302]],
    7,
    feedActive ? '#22d3ee' : '#1e3a4a'
  );
  drawPipe(ctx, [[574, 320], [664, 320], [664, 364]], 5, '#1e3a4a');

  if (s.pump) {
    drawFlow(ctx, [[130, 140], [250, 140]], 12, '#fef2f2', -flowPhase);
    drawFlow(ctx, [[250, 270], [130, 270]], 12, '#dbeafe', flowPhase);
  }
  if (steamActive) {
    drawFlow(ctx, [[293, 52], [293, 26], [522, 26], [522, 86]], 9, '#f8fafc', -flowPhase * 1.2);
  }
  if (feedActive) {
    drawFlow(ctx, [[470, 320], [336, 320], [336, 302]], 7, '#a5f3fc', flowPhase * 1.1);
  }

  drawCore(ctx, s);
  drawPressurizer(ctx, s);
  drawSteamGenerator(ctx, s);
  drawPump(ctx, s);
  drawTurbine(ctx, s);
  drawGenerator(ctx, s);
  drawCondenser(ctx);
  drawLabels(ctx);

  if (hoveredComponent) {
    const comp = hoveredComponent;
    ctx.save();
    ctx.strokeStyle = 'rgba(251, 191, 36, 0.9)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 4]);
    ctx.strokeRect(comp.x - 3, comp.y - 3, comp.w + 6, comp.h + 6);
    ctx.restore();
    drawTooltip(ctx, comp, surface.mouse);
  }

  ctx.restore();
}

/* ── Chart ─────────────────────────────────────────────────── */

function drawChart() {
  const surface = surfaces.chart;
  const ctx = surface.ctx;
  const { w, h, dpr } = surface;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const padL = 36;
  const padR = 36;
  const padT = 10;
  const padB = 16;
  const plotW = Math.max(10, w - padL - padR);
  const plotH = Math.max(10, h - padT - padB);
  const maxMW = 1600;
  const maxTemp = 400;

  ctx.font = '8px "Cascadia Code", monospace';
  ctx.textBaseline = 'middle';

  for (let mw = 0; mw <= maxMW; mw += 400) {
    const y = padT + plotH * (1 - mw / maxMW);
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.08)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(padL + plotW, y);
    ctx.stroke();
    ctx.fillStyle = '#4b5a70';
    ctx.textAlign = 'right';
    ctx.fillText(String(mw), padL - 5, y);
  }

  for (let temp = 0; temp <= maxTemp; temp += 200) {
    const y = padT + plotH * (1 - temp / maxTemp);
    ctx.fillStyle = '#4b5a70';
    ctx.textAlign = 'left';
    ctx.fillText(String(temp), padL + plotW + 5, y);
  }

  for (let i = 0; i <= 6; i += 1) {
    const x = padL + plotW * (i / 6);
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.05)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, padT);
    ctx.lineTo(x, padT + plotH);
    ctx.stroke();
  }

  const n = history.length;
  const xAt = (index) => padL + (index / (n - 1)) * plotW;
  const yMW = (value) => padT + plotH * (1 - clamp(value, 0, maxMW) / maxMW);
  const yTemp = (value) => padT + plotH * (1 - clamp(value, 0, maxTemp) / maxTemp);

  if (n > 1) {
    ctx.beginPath();
    history.forEach((sample, index) => {
      const x = xAt(index);
      const y = yMW(sample.demand + CFG.scoreBand);
      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    for (let index = n - 1; index >= 0; index -= 1) {
      ctx.lineTo(xAt(index), yMW(history[index].demand - CFG.scoreBand));
    }
    ctx.closePath();
    ctx.fillStyle = 'rgba(251, 191, 36, 0.09)';
    ctx.fill();

    ctx.beginPath();
    history.forEach((sample, index) => {
      const x = xAt(index);
      const y = yMW(sample.demand);
      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.setLineDash([5, 4]);
    ctx.strokeStyle = '#fbbf24';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.beginPath();
    history.forEach((sample, index) => {
      const x = xAt(index);
      const y = yMW(sample.output);
      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.shadowColor = 'rgba(56, 189, 248, 0.5)';
    ctx.shadowBlur = 6;
    ctx.stroke();
    ctx.shadowBlur = 0;

    ctx.beginPath();
    history.forEach((sample, index) => {
      const x = xAt(index);
      const y = yTemp(sample.temp);
      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = 'rgba(167, 139, 250, 0.85)';
    ctx.lineWidth = 1.4;
    ctx.stroke();

    const last = history[n - 1];
    ctx.fillStyle = '#38bdf8';
    ctx.beginPath();
    ctx.arc(xAt(n - 1), yMW(last.output), 2.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#fbbf24';
    ctx.beginPath();
    ctx.arc(xAt(n - 1), yMW(last.demand), 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#a78bfa';
    ctx.beginPath();
    ctx.arc(xAt(n - 1), yTemp(last.temp), 2, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.fillStyle = '#3c4a5e';
  ctx.font = '8px "Cascadia Code", monospace';
  ctx.textAlign = 'left';
  ctx.fillText('MW', 4, padT + 4);
  ctx.textAlign = 'right';
  ctx.fillText('°C', w - 4, padT + 4);
}

/* ── Schematic interaction ─────────────────────────────────── */

function virtualPoint(event) {
  const surface = surfaces.schematic;
  const rect = surface.canvas.getBoundingClientRect();
  const scale = surface.scale || 1;
  return {
    x: (event.clientX - rect.left - surface.ox) / scale,
    y: (event.clientY - rect.top - surface.oy) / scale
  };
}

function componentAt(point) {
  for (const comp of COMPONENTS) {
    if (
      point.x >= comp.x &&
      point.x <= comp.x + comp.w &&
      point.y >= comp.y &&
      point.y <= comp.y + comp.h
    ) {
      return comp;
    }
  }
  return null;
}

function componentAction(id) {
  audio.click();
  switch (id) {
    case 'core':
      ui.rodSlider.focus();
      break;
    case 'pressurizer':
      toggleHeater();
      break;
    case 'sg':
      ui.feedwaterSlider.focus();
      break;
    case 'pump':
      togglePump();
      break;
    case 'turbine':
    case 'generator':
      toggleBreaker();
      break;
    case 'condenser':
      ui.valveSlider.focus();
      break;
    default:
      break;
  }
}

function wireSchematic() {
  const canvas = surfaces.schematic.canvas;

  canvas.addEventListener('mousemove', (event) => {
    const point = virtualPoint(event);
    surfaces.schematic.mouse = point;
    const found = componentAt(point);
    hoveredComponent = found;
    canvas.style.cursor = found ? 'pointer' : 'default';
  });

  canvas.addEventListener('mouseleave', () => {
    hoveredComponent = null;
    canvas.style.cursor = 'default';
  });

  canvas.addEventListener('click', (event) => {
    const found = componentAt(virtualPoint(event));
    if (found) componentAction(found.id);
  });
}

/* ── Event wiring ──────────────────────────────────────────── */

function bindSliders() {
  const sliders = [
    { el: ui.rodSlider, key: 'rods', apply: (value) => setRods(value) },
    { el: ui.valveSlider, key: 'valve', apply: (value) => { state.valve = value; } },
    { el: ui.feedwaterSlider, key: 'feedwater', apply: (value) => { state.feedwater = value; } },
    { el: ui.boronSlider, key: 'boron', apply: (value) => { state.boron = value; } }
  ];

  for (const slider of sliders) {
    const element = slider.el;
    if (!element) continue;

    const onInput = () => {
      const value = clamp(num(element.value, 0), num(element.min, 0), num(element.max, 100));
      slider.apply(value);
      setSliderFill(element);
      if (slider.key === 'rods') ui.rodVal.textContent = `${Math.round(state.rods)}%`;
      if (slider.key === 'valve') ui.valveVal.textContent = `${Math.round(state.valve)}%`;
      if (slider.key === 'feedwater') ui.fwVal.textContent = `${Math.round(state.feedwater)}%`;
      if (slider.key === 'boron') ui.boronCtlVal.textContent = `${Math.round(state.boron)} ppm`;
      sim.dirty = true;
    };

    element.addEventListener('pointerdown', () => draggingSliders.add(element.id));
    element.addEventListener('pointerup', () => draggingSliders.delete(element.id));
    element.addEventListener('pointercancel', () => draggingSliders.delete(element.id));
    element.addEventListener('input', onInput);
    element.addEventListener('change', () => {
      draggingSliders.delete(element.id);
      onInput();
      audio.click();
      renderAll();
    });
  }
}

function bindControls() {
  ui.scramBtn?.addEventListener('click', () => {
    audio.click();
    requestScram();
  });
  ui.autopilotBtn?.addEventListener('click', toggleAutopilot);
  ui.soundBtn?.addEventListener('click', toggleSound);
  ui.helpBtn?.addEventListener('click', () => {
    audio.click();
    openHelp();
  });
  ui.pauseBtn?.addEventListener('click', togglePause);

  ui.rodDec?.addEventListener('click', () => { audio.click(); adjustRods(5); });
  ui.rodInc?.addEventListener('click', () => { audio.click(); adjustRods(-5); });
  ui.rodAllOut?.addEventListener('click', () => { audio.click(); setRods(0); });
  ui.rodAllIn?.addEventListener('click', () => { audio.click(); setRods(100); });

  ui.pumpBtn?.addEventListener('click', togglePump);
  ui.breakerBtn?.addEventListener('click', toggleBreaker);
  ui.heaterBtn?.addEventListener('click', toggleHeater);
  ui.sprayBtn?.addEventListener('click', toggleSpray);

  ui.boronSub?.addEventListener('click', () => adjustBoron(-100));
  ui.boronAdd?.addEventListener('click', () => adjustBoron(100));
  ui.tripResetBtn?.addEventListener('click', resetTrip);

  ui.saveBtn?.addEventListener('click', () => {
    audio.click();
    saveGame(true);
  });
  ui.loadBtn?.addEventListener('click', () => {
    audio.click();
    loadGame(true);
  });
  ui.newBtn?.addEventListener('click', () => {
    audio.click();
    openModal({
      title: 'Start a new game',
      subtitle: 'Progress will be lost',
      body:
        '<p>Reset the score, day counter and statistics, then restart the standard shift?</p>' +
        '<p class="muted">Any saved shift on disk will also be deleted.</p>',
      actions: [
        { label: 'Cancel', variant: 'btn-ghost' },
        {
          label: 'Start new game',
          variant: 'btn-danger',
          onClick: async () => {
            await clearSave();
            resetProgress();
            loadScenario('normal', { silent: true });
            toast('success', 'New game', 'Standard shift started from a cold baseline.');
          }
        }
      ]
    });
  });

  ui.logClear?.addEventListener('click', () => {
    logEntries.length = 0;
    renderLog();
    audio.click();
  });

  ui.missionBriefBtn?.addEventListener('click', () => {
    audio.click();
    openMissionBrief();
  });
  ui.missionRestartBtn?.addEventListener('click', () => {
    audio.click();
    restartDrill();
  });

  ui.scenarioGroup?.addEventListener('click', (event) => {
    const button = event.target.closest('.seg-btn');
    if (!button) return;
    audio.click();
    loadScenario(button.dataset.scenario);
  });

  ui.speedGroup?.addEventListener('click', (event) => {
    const button = event.target.closest('.speed-btn');
    if (!button) return;
    setSpeed(Number(button.dataset.speed));
  });

  ui.annunciator?.addEventListener('click', (event) => {
    const tile = event.target.closest('.alarm');
    if (!tile) return;
    const id = tile.dataset.alarm;
    const alarm = state.alarms[id];
    if (!alarm) return;
    audio.click();
    if (alarm.active) {
      alarm.ack = true;
      renderAlarms();
      const label = ALARM_DEFS[id]?.label || id;
      toast('info', 'Alarm acknowledged', label);
    } else {
      const label = ALARM_DEFS[id]?.label || id;
      toast('info', 'Alarm clear', `${label} is not active.`);
    }
  });

  ui.hint?.addEventListener('click', () => openHelp());
}

function bindWindowControls() {
  const desktopWindow = window.desktop && window.desktop.window;
  if (!desktopWindow) {
    document.body.classList.add('browser');
    return;
  }

  ui.winMin?.addEventListener('click', () => desktopWindow.minimize());
  ui.winMax?.addEventListener('click', () => desktopWindow.toggleMaximize());
  ui.winClose?.addEventListener('click', () => desktopWindow.close());

  const drag = document.querySelector('.titlebar-drag');
  drag?.addEventListener('dblclick', (event) => {
    if (event.target.closest('button')) return;
    desktopWindow.toggleMaximize();
  });

  desktopWindow.onMaximized?.((maximized) => {
    ui.winMax?.setAttribute('aria-label', maximized ? 'Restore window' : 'Maximize window');
  });
}

const KEY_ACTIONS = {
  ' ': () => togglePause(),
  s: () => requestScram(),
  p: () => togglePump(),
  g: () => toggleBreaker(),
  r: () => (state.tripped ? resetTrip() : toast('info', 'Trip reset', 'The reactor is not tripped.')),
  m: () => toggleSound(),
  h: () => openHelp(),
  f: () => toggleFullscreen(),
  a: () => toggleAutopilot()
};

function bindKeyboard() {
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (modalOpen && modalDismissible) {
        event.preventDefault();
        closeModal();
      }
      return;
    }

    const target = event.target;
    const isField =
      target instanceof HTMLElement &&
      (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT');

    if (event.ctrlKey || event.altKey || event.metaKey) return;
    if (modalOpen) return;

    if (!isField) {
      const digit = Number(event.key);
      if (Number.isInteger(digit) && digit >= 1 && digit <= SCENARIO_ORDER.length) {
        event.preventDefault();
        loadScenario(SCENARIO_ORDER[digit - 1]);
        return;
      }
    }

    if (isField) return;

    const key = event.key.toLowerCase();
    const action = KEY_ACTIONS[key];
    if (!action) return;
    event.preventDefault();
    action();
  });
}

/* ── Frame loop ────────────────────────────────────────────── */

let lastFrameAt = 0;
let frameAccumulator = 0;
let lastRenderedTick = -1;
let fpsSmoothed = 60;
let fpsReportedAt = 0;

function tickSimulation(deltaMs) {
  frameAccumulator += deltaMs;
  const stepMs = CFG.tickMs / sim.speed;
  let steps = 0;

  while (frameAccumulator >= stepMs && steps < 8) {
    frameAccumulator -= stepMs;
    physicsStep();
    steps += 1;
  }

  if (frameAccumulator > stepMs * 2) frameAccumulator = 0;

  if (state.tick - sim.autosaveTick >= 120) {
    sim.autosaveTick = state.tick;
    if (sim.dirty) saveGame(false);
  }
}

function frame(now) {
  if (!lastFrameAt) lastFrameAt = now;
  const delta = Math.min(400, now - lastFrameAt);
  lastFrameAt = now;

  fpsSmoothed += ((delta > 0 ? 1000 / delta : 60) - fpsSmoothed) * 0.08;

  const paused = sim.paused || modalOpen;
  if (!paused) tickSimulation(delta);
  else frameAccumulator = 0;

  flowPhase += paused ? 0.6 : 1.6 * sim.speed;

  if (state.tick !== lastRenderedTick) {
    lastRenderedTick = state.tick;
    renderAll();
  }

  drawSchematic();
  drawChart();

  if (now - fpsReportedAt > 500) {
    fpsReportedAt = now;
    if (ui.fpsVal) ui.fpsVal.textContent = String(Math.round(fpsSmoothed));
  }

  requestAnimationFrame(frame);
}

/* ── Boot ──────────────────────────────────────────────────── */

async function boot() {
  loadSettings();
  bindWindowControls();
  bindSliders();
  bindControls();
  bindKeyboard();
  initSurfaces();
  wireSchematic();

  window.addEventListener('resize', () => {
    for (const surface of Object.values(surfaces)) measureSurface(surface);
  });

  document.addEventListener('contextmenu', (event) => event.preventDefault());
  document.addEventListener('pointerdown', () => audio.ensure(), { once: true });

  resetHistory();
  loadScenario('normal', { silent: true });
  updateSpeedButtons();

  if (window.desktop && window.desktop.app) {
    try {
      const info = await window.desktop.app.info();
      if (info && info.version && ui.appVersion) ui.appVersion.textContent = info.version;
    } catch {
      /* ignore */
    }
  }

  let saved = null;
  try {
    saved = await storeApi.load();
  } catch {
    saved = null;
  }

  renderAll();
  renderLog(true);
  showWelcome(saved);

  requestAnimationFrame(frame);
}

boot().catch((error) => {
  console.error('Boot failed', error);
  const stack = document.getElementById('log-list');
  if (stack) {
    stack.textContent = `Startup error: ${error && error.message ? error.message : error}`;
  }
});
