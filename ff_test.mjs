// Fast-forward test harness for SimCit AI.
// Boots the game in headless Chromium via Playwright, then repeatedly calls the
// simulation's internal _simulate() directly (bypassing the real-time throttle in
// _simFrame) so we can fast-forward years of simulated time in seconds, driving the
// AI's decision loop (aiHelper._executeNextAction) once per simulated "cityTime" tick.
import { chromium } from 'playwright';

const URL = process.env.SIMCIT_URL || 'http://localhost:8080/';
const YEARS = parseInt(process.env.FF_YEARS || '80', 10);
const MAP_SIZE = process.env.FF_MAP || '120x100';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

page.on('console', msg => {
  const t = msg.text();
  if (/error/i.test(t)) console.log('[console]', t);
});
page.on('pageerror', err => console.log('[pageerror]', err.message));

await page.goto(URL, { waitUntil: 'load' });

// Pick map size, click Play on splash, then submit name/difficulty form.
await page.waitForSelector('#splashPlay', { state: 'visible', timeout: 15000 });
await page.selectOption('#mapSize', MAP_SIZE);
// Let the map regenerate for the new size selection.
await page.waitForTimeout(200);
await page.click('#splashPlay');
await page.waitForSelector('#playit', { state: 'visible', timeout: 15000 });
await page.fill('#nameForm', 'TestCity');
await page.click('#playit');

await page.waitForFunction(() => !!window.__simcitGame, { timeout: 15000 });
console.log('Game booted.');

const result = await page.evaluate(async (years) => {
  const game = window.__simcitGame;
  const sim = game.simulation;
  const helper = game.aiHelper;

  // Force fast simulation speed so power/pollution/crime scans run every cycle
  // (matches the in-game "fast" setting semantics, purely for scan cadence — the
  // throttle itself is bypassed below).
  sim._speed = 3; // Simulation.SPEED_FAST

  // Instrument each action-executing method on the helper so we can see what's being
  // attempted vs what's actually landing, even though _executeNextAction now tries
  // multiple recommendations per tick internally (falls through on failure).
  const actionLog = {};
  const failLog = {};
  const advisor = helper.advisor;
  const methodsToTrack = ['_buildStarterCity', '_buildZone', '_buildRoadConnection',
    '_buildWireConnection', '_setTaxRate', '_setFunding', '_bulldozeRubble', '_expandGrid'];
  for (const name of methodsToTrack) {
    const orig = helper[name].bind(helper);
    helper[name] = function (...args) {
      const result = orig(...args);
      const bucket = result ? actionLog : failLog;
      bucket[name] = (bucket[name] || 0) + 1;
      return result;
    };
  }

  const targetCityTime = sim._cityTime + years * 48;
  const snapshots = [];
  let iterations = 0;
  const maxIterations = years * 48 * 16 * 2; // generous safety cap

  while (sim._cityTime < targetCityTime && iterations < maxIterations) {
    const beforePhase = sim._phaseCycle;
    const simData = sim._constructSimData();
    sim._simulate(simData);
    iterations++;

    // One AI decision per full 16-phase cycle (i.e. once per cityTime tick).
    if (beforePhase === 15) {
      try {
        helper._executeNextAction();
      } catch (e) {
        snapshots.push({ error: String(e && e.stack || e), cityTime: sim._cityTime });
      }
    }

    // Snapshot right after phase 9 (census/tax/eval just ran for this cityTime)
    // on year boundaries — earlier in the cycle (phase 0) the census counts have
    // already been cleared for the new tick and haven't been rebuilt by the
    // mapScan yet, so they'd read back as zero.
    if (beforePhase === 9 && sim._cityTime % 48 === 0) {
      const c = sim._census;
      const b = sim.budget;
      const e = sim.evaluation;
      snapshots.push({
        year: Math.floor(sim._cityTime / 48),
        cityTime: sim._cityTime,
        totalPop: c.totalPop,
        resPop: c.resPop, comPop: c.comPop, indPop: c.indPop,
        cityPop: e.cityPop,
        cityClass: e.cityClass,
        cityScore: e.cityScore,
        funds: b.totalFunds,
        cashFlow: b.cashFlow,
        poweredZones: c.poweredZoneCount, unpoweredZones: c.unpoweredZoneCount,
        coal: c.coalPowerPop, nuclear: c.nuclearPowerPop,
        crime: c.crimeAverage, traffic: c.trafficAverage,
      });
    }
  }

  // Post-run map diagnostic: scan every tile, classify zones as powered/unpowered,
  // and sample a few unpowered zone coordinates plus their immediate surroundings.
  const map = game.gameMap;
  let zoneCount = 0, poweredCount = 0, roadCount = 0, wireCount = 0;
  const unpoweredSamples = [];
  for (let y = 0; y < map.height; y++) {
    for (let x = 0; x < map.width; x++) {
      const tile = map.getTile(x, y);
      if (tile.isZone()) {
        zoneCount++;
        if (tile.isPowered()) poweredCount++;
        else if (unpoweredSamples.length < 15) unpoweredSamples.push({ x, y });
      }
      if (tile.isConductive()) wireCount++;
    }
  }

  const topRecs = advisor.analyze().slice(0, 5).map(r => r.message);

  // Terrain census: how much of the map is water/rubble-etc (unbuildable without a
  // bridge or bulldozing) vs. genuinely open dirt vs. already built on. If "open" is
  // near zero while zone growth has stalled well short of the map filling up, the
  // remaining unclaimed territory is most likely water the AI has no way to cross.
  const terrainCensus = { dirt: 0, water: 0, buildable: 0, other: 0, total: map.width * map.height };
  for (let y = 0; y < map.height; y++) {
    for (let x = 0; x < map.width; x++) {
      const tv = map.getTileValue(x, y);
      const t = map.getTile(x, y);
      if (tv === 0) terrainCensus.dirt++;
      else if (tv >= 2 && tv <= 20) terrainCensus.water++; // WATER_LOW..WATER_HIGH (river/edges)
      else if (t.isBulldozable()) terrainCensus.buildable++; // trees, rubble, etc — clearable
      else terrainCensus.other++; // zones, roads, wire, buildings, ...
    }
  }

  const valveDebug = {
    resValve: sim._valves.resValve, comValve: sim._valves.comValve, indValve: sim._valves.indValve,
    employment: sim._census.resPop > 0 ? (sim._census.comPop + sim._census.indPop) / (sim._census.resPop / 8) : null,
  };

  const gridExpansionDebug = {
    residential: advisor.findGridExpansionRoads('residential'),
    industrial: advisor.findGridExpansionRoads('industrial'),
  };

  // Actually try to execute the road tool on the industrial candidate's tiles (we're
  // at the very end of the run, so committing this doesn't affect anything else we
  // care about) and record the real TOOLRESULT code for each — this tells us exactly
  // why _buildRoadWithWire is failing on tiles findGridExpansionRoads itself thought
  // were buildable.
  const buildAttemptDebug = [];
  if (gridExpansionDebug.industrial) {
    const roadTool = helper.tools.road;
    const codeName = (tool, result) => {
      for (const k of Object.keys(tool)) {
        if (k.indexOf('TOOLRESULT_') === 0 && tool[k] === result) return k;
      }
      return String(result);
    };
    for (const pos of gridExpansionDebug.industrial) {
      const tvBefore = map.getTileValue(pos.x, pos.y);
      roadTool.doTool(pos.x, pos.y, helper.blockMaps);
      const result = roadTool.result;
      const resultName = codeName(roadTool, result);
      if (result === roadTool.TOOLRESULT_OK) {
        roadTool.modifyIfEnoughFunding(sim.budget);
      } else {
        roadTool.clear();
      }
      buildAttemptDebug.push({ x: pos.x, y: pos.y, tileValueBefore: tvBefore, result: resultName });
    }
  }

  // Zone-placement bottleneck diagnostic: for each zone type, scan the whole map at
  // the same stride findBestZoneLocation uses and bucket every candidate by which
  // hard-reject condition (if any) it fails, so we can see exactly what's blocking
  // further growth once _buildZone stalls out.
  const placementDiagnostic = {};
  for (const toolName of ['residential', 'commercial', 'industrial']) {
    const buckets = { notClear: 0, hardReject: 0, belowViableThreshold: 0, viable: 0, total: 0 };
    let bestScore = -Infinity, bestPos = null;
    let bestBelowThreshold = -Infinity, bestBelowThresholdPos = null;
    for (let y = 2; y < map.height - 2; y += 2) {
      for (let x = 2; x < map.width - 2; x += 2) {
        buckets.total++;
        if (!advisor._isAreaClear(x - 1, y - 1, 3)) { buckets.notClear++; continue; }
        const score = advisor._scoreZoneLocation(x, y, toolName);
        if (score <= -9000) { buckets.hardReject++; continue; }
        if (score < -100) {
          buckets.belowViableThreshold++;
          if (score > bestBelowThreshold) { bestBelowThreshold = score; bestBelowThresholdPos = { x, y, score }; }
          continue;
        }
        buckets.viable++;
        if (score > bestScore) { bestScore = score; bestPos = { x, y, score }; }
      }
    }
    placementDiagnostic[toolName] = { buckets, bestViablePos: bestPos, bestBelowThresholdPos };
  }

  // Proper (non-buggy) BFS over the conductive-tile graph, seeded from every power
  // plant tile, to see the TRUE size of the connected network vs. the engine's
  // maxPower budget (COAL_POWER_STRENGTH * plant count) — this tells us whether the
  // brownout is a genuine capacity shortfall or a topological disconnect (island of
  // wire with no plant feeding it).
  let PLANT_TILE_VALUES;
  {
    // POWERPLANT / NUCLEAR tile-value constants aren't on window, so detect plants
    // by tile value equality against known census-tracked positions instead: scan
    // for any tile whose value matches the census plant counts by re-deriving from
    // TileUtils isn't available either, so just look for tiles with high POWERBIT
    // fan-out (a plant is always powered and conductive with 4 anim tiles around it).
    // Simpler: reuse this._findNearestPowered-style scan seeded from all conductive
    // tiles adjacent to a tile that is powered AND has no zone flag AND stays powered
    // regardless of the graph (plants self-power). We just BFS from ALL currently
    // "isPowered()" tiles simultaneously as a proxy for "seeded from real sources",
    // since every powered tile must trace back to a plant in the real algorithm too.
  }
  const visited = new Set();
  const queue = [];
  for (let y = 0; y < map.height; y++) {
    for (let x = 0; x < map.width; x++) {
      const t = map.getTile(x, y);
      if (t.isPowered() && t.isConductive()) {
        const key = x + ',' + y;
        if (!visited.has(key)) { visited.add(key); queue.push([x, y]); }
      }
    }
  }
  const seedCount = queue.length;
  while (queue.length) {
    const [cx, cy] = queue.pop();
    for (const [dx, dy] of [[0, -1], [1, 0], [0, 1], [-1, 0]]) {
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= map.width || ny >= map.height) continue;
      const key = nx + ',' + ny;
      if (visited.has(key)) continue;
      if (map.getTile(nx, ny).isConductive()) {
        visited.add(key);
        queue.push([nx, ny]);
      }
    }
  }
  const lastSnap = snapshots.length ? snapshots[snapshots.length - 1] : null;
  const trueNetworkDiagnostic = {
    seedCount,
    totalReachableConductive: visited.size,
    totalConductiveOnMap: wireCount,
    maxPowerBudget: lastSnap ? lastSnap.coal * 700 + lastSnap.nuclear * 2000 : null,
  };

  // Deep-dive across several unpowered zones: replay what findWireToConnect() does
  // internally for each, and separately BFS over ALL open/traversable ground (not
  // just conductive tiles, matching _findWirePath's own canTraverse) to get a ground
  // truth independent of the advisor's own code, for comparison.
  const openGroundVisited = new Set();
  {
    const q = [];
    for (let y = 0; y < map.height; y++) {
      for (let x = 0; x < map.width; x++) {
        const t = map.getTile(x, y);
        if (t.isPowered()) { const k = x + ',' + y; if (!openGroundVisited.has(k)) { openGroundVisited.add(k); q.push([x, y]); } }
      }
    }
    while (q.length) {
      const [cx, cy] = q.pop();
      for (const [dx, dy] of [[0, -1], [1, 0], [0, 1], [-1, 0]]) {
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= map.width || ny >= map.height) continue;
        const key = nx + ',' + ny;
        if (openGroundVisited.has(key)) continue;
        const tv = map.getTileValue(nx, ny);
        const t = map.getTile(nx, ny);
        const traversable = tv === 0 /* DIRT */ || t.isBulldozable() || t.isConductive();
        if (traversable) { openGroundVisited.add(key); q.push([nx, ny]); }
      }
    }
  }

  const wireDebug = {
    topLevelResult: advisor.findWireToConnect(),
    openGroundReachableCount: openGroundVisited.size,
    samples: unpoweredSamples.slice(0, 8).map(z => {
      const path = advisor._findWirePath(z.x, z.y);
      const groundTruthReachable = [[0, -1], [1, 0], [0, 1], [-1, 0]].some(([dx, dy]) => {
        return openGroundVisited.has((z.x + dx) + ',' + (z.y + dy));
      }) || openGroundVisited.has(z.x + ',' + z.y);
      return {
        zone: z,
        advisorPath: path === null ? 'null(unreachable)' : (path.length + ' steps'),
        groundTruthReachableViaOpenGround: groundTruthReachable,
      };
    }),
  };

  return {
    finalCityTime: sim._cityTime,
    iterations,
    snapshots,
    actionCount: helper._actionCount,
    actionLog, failLog,
    finalCensus: (() => {
      const c = sim._census;
      return { totalPop: c.totalPop, resPop: c.resPop, comPop: c.comPop, indPop: c.indPop };
    })(),
    finalEval: { cityPop: sim.evaluation.cityPop, cityClass: sim.evaluation.cityClass, cityScore: sim.evaluation.cityScore },
    mapDiagnostic: { zoneCount, poweredCount, unpoweredCount: zoneCount - poweredCount, conductiveTileCount: wireCount, unpoweredSamples },
    topRecommendations: topRecs,
    wireDebug,
    trueNetworkDiagnostic,
    placementDiagnostic,
    terrainCensus,
    gridExpansionDebug,
    valveDebug,
    buildAttemptDebug,
  };
}, YEARS);

console.log(JSON.stringify(result, null, 2));

await browser.close();
