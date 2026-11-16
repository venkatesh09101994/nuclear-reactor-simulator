'use strict';

/**
 * Smoke test for the renderer. Loads the real index.html in Electron, drives a
 * few interactions, asserts layout/canvas behaviour and writes screenshots to
 * verify-shots/.
 *
 *   npm run verify
 */

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'verify-shots');
const TMP_SAVE = path.join(os.tmpdir(), 'pwr9-verify-save.json');

const problems = [];
const checks = [];
const shots = [];

const logFile = () => path.join(OUT, 'verify.log');
function log(message) {
  const line = `${new Date().toISOString()} ${message}`;
  console.log(line);
  try {
    fs.appendFileSync(logFile(), `${line}\n`);
  } catch {
    /* ignore */
  }
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function check(name, ok, detail = '') {
  checks.push({ name, ok: Boolean(ok), detail: String(detail) });
  if (!ok) problems.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

async function capture(win, name) {
  const image = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT, name), image.toPNG());
  shots.push(name);
}

function registerIpc() {
  ipcMain.handle('app:info', () => ({ name: 'verify', version: '2.0.0', electron: process.versions.electron, platform: process.platform }));
  ipcMain.handle('window:minimize', () => true);
  ipcMain.handle('window:toggle-maximize', () => false);
  ipcMain.handle('window:close', () => true);
  ipcMain.handle('window:is-maximized', () => false);
  ipcMain.handle('store:save', (_event, payload) => {
    fs.writeFileSync(TMP_SAVE, JSON.stringify(payload), 'utf8');
    return { ok: true };
  });
  ipcMain.handle('store:load', () => {
    try {
      return JSON.parse(fs.readFileSync(TMP_SAVE, 'utf8'));
    } catch {
      return null;
    }
  });
  ipcMain.handle('store:clear', () => {
    try {
      fs.unlinkSync(TMP_SAVE);
    } catch {
      /* ignore */
    }
    return { ok: true };
  });
}

async function run() {
  const watchdog = setTimeout(() => {
    log('watchdog fired — forcing exit');
    console.log(JSON.stringify({ ok: false, problems: problems.concat('watchdog timeout'), checks }, null, 2));
    app.exit(3);
  }, 120000);

  fs.mkdirSync(OUT, { recursive: true });
  try {
    fs.unlinkSync(TMP_SAVE);
  } catch {
    /* ignore */
  }
  registerIpc();

  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    show: true,
    backgroundColor: '#060a12',
    title: 'PWR-9 verify',
    webPreferences: {
      preload: path.join(ROOT, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false
    }
  });

  win.webContents.on('console-message', (event, level, message) => {
    const text = typeof event === 'object' && event && event.message ? event.message : message;
    const severity = typeof event === 'object' && event && event.level !== undefined ? event.level : level;
    if (severity === 'error' || severity === 3) problems.push(`console: ${text}`);
  });

  win.webContents.on('render-process-gone', (_event, details) => {
    problems.push(`renderer gone: ${details.reason}`);
  });

  win.webContents.on('did-fail-load', (_event, code, description) => {
    problems.push(`did-fail-load ${code} ${description}`);
  });

  await win.loadFile(path.join(ROOT, 'index.html'));
  await wait(1200);

  const probe = async (expression) => {
    log(`probe ${expression.replace(/\s+/g, ' ').slice(0, 110)}`);
    const timeout = new Promise((resolve) => setTimeout(() => resolve('__TIMEOUT__'), 8000));
    const value = await Promise.race([
      win.webContents.executeJavaScript(
        `(() => { try { return ${expression}; } catch (e) { return 'ERR: ' + e.message; } })()`,
        true
      ),
      timeout
    ]);
    if (value === '__TIMEOUT__') problems.push(`probe timed out: ${expression.slice(0, 90)}`);
    return value;
  };

  // ── 1. Boot ────────────────────────────────────────────────────────────
  check('welcome modal visible', (await probe("!document.getElementById('modal-root').classList.contains('hidden')")) === true);
  check('bridge exposed', (await probe("typeof window.desktop === 'object' && typeof window.desktop.store.save === 'function'")) === true);
  await capture(win, '01-welcome.png');

  await probe('closeModal(); true');
  await wait(2600);
  await capture(win, '02-dashboard.png');

  const schematicRect = await probe(`(() => {
    const r = document.querySelector('.schematic-wrap').getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
  })()`);
  const schematicShot = await win.webContents.capturePage(schematicRect);
  fs.writeFileSync(path.join(OUT, '09-schematic.png'), schematicShot.toPNG());
  log(`schematic rect ${JSON.stringify(schematicRect)}`);

  log(
    'metrics ' +
      JSON.stringify(
        await probe(`(() => {
          const pick = (sel) => {
            const el = document.querySelector(sel);
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)];
          };
          return {
            vh: innerHeight,
            app: pick('.app'),
            workspace: pick('.workspace'),
            center: pick('.col-center'),
            schematicPanel: pick('.schematic-panel'),
            wrap: pick('.schematic-wrap'),
            chart: pick('.chart-panel'),
            log: pick('.log-panel'),
            left: pick('.col-left'),
            right: pick('.col-right'),
            statusbar: pick('.statusbar')
          };
        })()`)
      )
  );

  // ── 2. Simulation advances ─────────────────────────────────────────────
  const tickA = await probe('state.tick');
  const clockA = await probe("document.getElementById('clock-val').textContent");
  await wait(1800);
  const tickB = await probe('state.tick');
  const clockB = await probe("document.getElementById('clock-val').textContent");
  check('physics ticks advance', typeof tickA === 'number' && tickB > tickA, `${tickA} -> ${tickB}`);
  check('shift clock advances', clockA !== clockB, `${clockA} -> ${clockB}`);
  check('hud day rendered', (await probe("document.getElementById('day-val').textContent")) !== '');

  // ── 3. Canvases actually paint ─────────────────────────────────────────
  const canvas = await probe(`(() => {
    const out = {};
    for (const id of ['schematic-canvas', 'chart-canvas']) {
      const c = document.getElementById(id);
      const data = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let lit = 0;
      for (let i = 3; i < data.length; i += 4 * 61) if (data[i] > 8) lit += 1;
      out[id] = { w: c.width, h: c.height, lit };
    }
    return out;
  })()`);
  check('schematic canvas painted', canvas['schematic-canvas'] && canvas['schematic-canvas'].lit > 40, JSON.stringify(canvas['schematic-canvas']));
  check('chart canvas painted', canvas['chart-canvas'] && canvas['chart-canvas'].lit > 20, JSON.stringify(canvas['chart-canvas']));

  // ── 4. Layout: nothing clipped at the default size ─────────────────────
  const geometry = await probe(`(() => {
    const rects = [];
    const bad = [];
    const selectors = ['.hud-chip', '.seg-btn', '.speed-btn', '.alarm', '.gauge', '.toggle', '.stat', '.meter', '.mission-actions .btn', '.panel-head h2'];
    for (const selector of selectors) {
      document.querySelectorAll(selector).forEach((el) => {
        const r = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        if (style.display === 'none') return;
        if (r.width < 4 || r.height < 4) bad.push(selector + ' collapsed');
        if (r.right > innerWidth + 1 || r.left < -1) bad.push(selector + ' outside horizontally');
        if (r.bottom > innerHeight + 1 || r.top < -1) bad.push(selector + ' outside vertically');
        if (el.scrollWidth > el.clientWidth + 2 && style.overflow !== 'auto' && style.overflow !== 'scroll') {
          bad.push(selector + ' text overflow ' + el.scrollWidth + '>' + el.clientWidth);
        }
        rects.push(selector);
      });
    }
    const doc = document.documentElement;
    return {
      bad: Array.from(new Set(bad)),
      count: rects.length,
      overflowX: doc.scrollWidth - doc.clientWidth,
      overflowY: doc.scrollHeight - doc.clientHeight
    };
  })()`);
  check('layout elements present', geometry.count > 25, `${geometry.count} measured`);
  check('no clipped elements', geometry.bad.length === 0, geometry.bad.slice(0, 6).join(' | '));
  check('no page overflow', geometry.overflowX <= 1 && geometry.overflowY <= 1, JSON.stringify(geometry));

  // ── 5. Gauges reflect state ────────────────────────────────────────────
  const gauge = await probe(`(() => {
    const arc = document.querySelector('#g-temp .gauge-arc');
    return { offset: parseFloat(arc.style.strokeDashoffset), text: document.getElementById('temp-val').textContent };
  })()`);
  check('temperature gauge animates', Number.isFinite(gauge.offset) && gauge.offset >= 0, JSON.stringify(gauge));
  check('temperature readout numeric', /^[0-9]+$/.test(gauge.text), gauge.text);

  // ── 6. Power control responds ──────────────────────────────────────────
  const startOutput = await probe('state.output');
  await probe('setRods(0); state.boron = 150; true');
  await wait(2600);
  const upOutput = await probe('state.output');
  await capture(win, '03-power-up.png');
  check('output responds to rods/boron', upOutput > startOutput, `${startOutput} -> ${upOutput} MW`);
  check('slider mirrors state', (await probe("document.getElementById('rod-slider').value")) === '0');

  // ── 7. Trip latching ───────────────────────────────────────────────────
  await probe("tripPlant('VERIFY TEST'); true");
  await wait(800);
  await capture(win, '04-trip.png');
  check('trip latches', (await probe('state.tripped')) === true);
  check('trip disables rods', (await probe("document.getElementById('rod-slider').disabled")) === true);
  check('trip alarm active', (await probe("document.querySelector('.alarm[data-alarm=trip]').classList.contains('is-active')")) === true);
  check('scram guard message', (await probe('(requestScram(), true)')) === true);

  // ── 8. Cooldown drill ─────────────────────────────────────────────────
  await probe("loadScenario('cooldown'); closeModal(); true");
  await wait(3200);
  await capture(win, '05-cooldown.png');
  const cool = await probe('({ tripped: state.tripped, temp: state.coreTemp, press: state.pressure, thermal: state.thermal, demand: state.demand, status: mission.status })');
  check('cooldown drill tripped', cool.tripped === true);
  check('cooldown has decay heat', cool.thermal > 0, `${cool.thermal} MWt`);
  check('cooldown demand offline', cool.demand === 0);
  check('cooldown cooling down', cool.temp < 335, `${cool.temp.toFixed(1)} °C`);
  check('cooldown progress bar', (await probe("parseFloat(document.getElementById('mission-progress-bar').style.width)")) > 0);
  check('cooldown needs operator action', cool.temp > 120 && cool.status === 'active', JSON.stringify(cool));

  // Opening the steam valve and using spray must actually reach cold shutdown.
  await probe('(state.valve = 100, state.spray = true, setSpeed(4), true)');
  await wait(9000);
  const coolDone = await probe('({ temp: state.coreTemp, press: state.pressure, status: mission.status, modal: !document.getElementById(\'modal-root\').classList.contains(\'hidden\') })');
  log('cooldown done ' + JSON.stringify(coolDone));
  check('cooldown reaches cold shutdown', coolDone.temp < 120 && coolDone.press < 60, JSON.stringify(coolDone));
  check('cooldown mission completes', coolDone.status === 'complete' && coolDone.modal === true, JSON.stringify(coolDone));
  await probe('(closeModal(), setSpeed(1), true)');

  // ── 9. Help modal ─────────────────────────────────────────────────────
  await probe('openHelp(); true');
  await wait(500);
  await capture(win, '06-help.png');
  const help = await probe(`(() => {
    const card = document.querySelector('.modal-card');
    const r = card.getBoundingClientRect();
    return { rows: document.querySelectorAll('.kbd-row').length, fits: r.top >= 0 && r.bottom <= innerHeight + 1 };
  })()`);
  check('help lists shortcuts', help.rows >= 8, `${help.rows} rows`);
  check('help modal fits viewport', help.fits);
  await probe('closeModal(); true');

  // ── 10. Xenon drill + narrow layout ───────────────────────────────────
  await probe("loadScenario('xenon'); closeModal(); true");
  await wait(1400);
  await capture(win, '07-xenon.png');
  check('xenon drill loads', (await probe('state.xenon')) > 60, String(await probe('state.xenon')));

  win.setSize(1024, 720);
  await wait(900);
  await capture(win, '08-narrow.png');
  const narrow = await probe(`(() => {
    const doc = document.documentElement;
    const canvas = document.querySelector('.schematic-wrap').getBoundingClientRect();
    const right = document.querySelector('.col-right').getBoundingClientRect();
    const chart = document.querySelector('.chart-panel').getBoundingClientRect();
    const logPanel = document.querySelector('.log-panel').getBoundingClientRect();
    return {
      overflowX: doc.scrollWidth - doc.clientWidth,
      overflowY: doc.scrollHeight - doc.clientHeight,
      schematic: Math.round(canvas.width) + 'x' + Math.round(canvas.height),
      chart: Math.round(chart.width) + 'x' + Math.round(chart.height),
      log: Math.round(logPanel.width) + 'x' + Math.round(logPanel.height),
      rightVisible: right.right <= innerWidth + 1
    };
  })()`);
  log('narrow ' + JSON.stringify(narrow));
  check('no overflow at 1024x720', narrow.overflowX <= 1 && narrow.overflowY <= 1, JSON.stringify(narrow));
  check('right column visible at 1024', narrow.rightVisible, JSON.stringify(narrow));
  check('log timestamps inline at 1024', (await probe("getComputedStyle(document.querySelector('.log-time')).display")) === 'inline');

  // Modals must fit a 1024x720 window too.
  await probe('openHelp(); true');
  await wait(350);
  const narrowModal = await probe(`(() => {
    const card = document.querySelector('.modal-card').getBoundingClientRect();
    return { top: card.top, bottom: card.bottom, vh: innerHeight, scrollable: document.querySelector('.modal-card').scrollHeight > document.querySelector('.modal-card').clientHeight };
  })()`);
  check('help modal fits 1024x720', narrowModal.top >= -1 && narrowModal.bottom <= narrowModal.vh + 1, JSON.stringify(narrowModal));
  await probe('closeModal(); true');

  // ── 11. UI wiring: click real controls ────────────────────────────────
  await probe("loadScenario('normal'); closeModal(); true");
  await wait(400);
  const wiring = await probe(`(() => {
    const out = {};
    const click = (id) => document.getElementById(id).click();

    click('autopilot-btn');
    out.autopilotOn = state.autoPilot === true;
    click('autopilot-btn');
    out.autopilotOff = state.autoPilot === false;

    const pumpBefore = state.pump;
    click('pump-btn');
    out.pumpToggled = state.pump !== pumpBefore;
    click('pump-btn');

    const breakerBefore = state.breaker;
    click('breaker-btn');
    out.breakerToggled = state.breaker !== breakerBefore;
    click('breaker-btn');

    click('heater-btn');
    out.heaterOn = state.heater === true;
    click('heater-btn');

    click('spray-btn');
    out.sprayOn = state.spray === true;
    click('spray-btn');

    const boronBefore = state.boron;
    click('boron-add');
    out.boronUp = state.boron === boronBefore + 100;
    click('boron-sub');

    click('rod-all-out');
    out.rodsOut = state.rods === 0;
    click('rod-all-in');
    out.rodsIn = state.rods === 100;
    click('rod-inc');
    out.rodsStep = state.rods === 95;

    click('log-clear');
    out.logCleared = document.querySelectorAll('#log-list .log-item').length === 0;

    click('sound-btn');
    out.soundMuted = audio.enabled === false;
    click('sound-btn');
    out.soundBack = audio.enabled === true;

    document.querySelectorAll('.speed-btn')[1].click();
    out.speed2 = document.querySelectorAll('.speed-btn')[1].classList.contains('is-active');
    document.querySelectorAll('.speed-btn')[0].click();

    document.querySelectorAll('.seg-btn')[2].click();
    out.scenarioSwitch = mission.id === 'blackout';

    click('mission-brief-btn');
    out.briefOpen = !document.getElementById('modal-root').classList.contains('hidden');
    click('modal-close');
    out.briefClosed = document.getElementById('modal-root').classList.contains('hidden');

    click('pause-btn');
    out.paused = sim.paused === true;
    click('pause-btn');
    out.resumed = sim.paused === false;

    click('scram-btn');
    out.scramDialog = !document.getElementById('modal-root').classList.contains('hidden');
    document.getElementById('modal-close').click();
    out.scramCancelled = state.tripped === false;

    state.coreTemp = 360;
    updateAlarms();
    out.tempAlarm = state.alarms.temp.active === true;
    document.querySelector('.alarm[data-alarm=temp]').click();
    out.tempAck = state.alarms.temp.ack === true;

    return out;
  })()`);
  log('wiring ' + JSON.stringify(wiring));
  for (const [key, value] of Object.entries(wiring || {})) {
    check(`wiring: ${key}`, value === true);
  }
  await probe("state.coreTemp = 300; loadScenario('normal'); closeModal(); true");
  await wait(300);

  // ── 12. Save / load round trip ────────────────────────────────────────
  win.setSize(1440, 920);
  await wait(500);
  const scoreBefore = await probe('state.score');
  check('save succeeds', (await probe('saveGame(false)')) === true);
  await probe('state.score = 999999; state.rods = 88; renderAll(); true');
  check('load succeeds', (await probe('loadGame(false)')) === true);
  const restored = await probe('({ score: state.score, rods: state.rods })');
  check('load restores state', restored.score === scoreBefore && Math.abs(restored.rods - 88) > 1, JSON.stringify(restored));

  // ── 12. Pause and speed ───────────────────────────────────────────────
  await probe('togglePause(); true');
  const pausedTick = await probe('state.tick');
  await wait(1200);
  check('pause freezes physics', (await probe('state.tick')) === pausedTick);
  await probe('(togglePause(), setSpeed(4), true)');
  check('speed buttons reflect state', (await probe("document.querySelectorAll('.speed-btn')[2].classList.contains('is-active')")) === true);

  log('step: done');
  const result = {
    ok: problems.length === 0,
    checks: checks.length,
    failed: checks.filter((item) => !item.ok),
    problems,
    shots
  };
  console.log(JSON.stringify(result, null, 2));

  win.destroy();
  app.exit(problems.length === 0 ? 0 : 1);
}

app.whenReady().then(() =>
  run().catch((error) => {
    console.error('verify failed:', error);
    console.log(JSON.stringify({ ok: false, problems: problems.concat(String(error && error.stack ? error.stack : error)) }, null, 2));
    app.exit(1);
  })
);
