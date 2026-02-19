/* AI Helper for SimCit - Auto-Play Engine
 *
 * Starter City: 1 coal ($3000) + 3R+1C+2I ($600) = ~$4200
 *   R:(C+I) = 3:3 = 1:1 balanced employment from day one.
 *   1 coal (700 cap) handles all 6 zones + ~50 more before 2nd needed.
 *   Grid-aligned positions (offset ≡ 2 mod 4) for clean expansion.
 *
 * Power Strategy (math-driven):
 *   1 coal = 57 zones. Handles Town → City → most of Capital.
 *   2nd coal only when utilization > 80% (~45+ zones).
 *   Nuclear only at 80+ zones when replacing 2+ coal plants.
 *   Wire on roads creates road+power hybrid tiles (CONDBIT).
 *
 * Zone Strategy (employment-driven):
 *   employment = (comPop + indPop) / (resPop / 8)
 *   < 0.8: build C/I (need jobs)
 *   > 1.3: build R (need workers)
 *   Balanced: follow valve demand
 */

import $ from 'jquery';

import { AIAdvisor } from './aiAdvisor.js';
import { GameTools } from './gameTools.js';
import { Simulation } from './simulation.js';
import { TileUtils } from './tileUtils.js';
import * as TileValues from './tileValues.ts';

var SPEED_INTERVALS = {
  1: 3000,
  2: 1500,
  3: 500
};

var ADVICE_INTERVAL = 5000;

function AIHelper(game) {
  this.game = game;
  this.simulation = game.simulation;
  this.map = game.gameMap;
  this.blockMaps = game.simulation.blockMaps;

  this.advisor = new AIAdvisor(this.simulation, this.map, this.blockMaps);
  this.tools = new GameTools(this.map);

  this.autoPlayActive = false;
  this._autoPlayTimer = null;
  this._adviceTimer = null;
  this._actionCount = 0;
  this._lastAction = '';
  this._currentSpeed = this.simulation._speed;

  this._initUI();
  this._startAdviceLoop();
}


AIHelper.prototype._initUI = function() {
  var self = this;

  $('#aiToggle').click(function() {
    $('#aiPanel').toggleClass('ai-hidden');
    var btn = $(this);
    if ($('#aiPanel').hasClass('ai-hidden')) {
      btn.text('AI Helper');
    } else {
      btn.text('Hide AI');
      self._refreshAdvice();
    }
  });

  $('#aiAutoPlay').click(function() {
    self.toggleAutoPlay();
  });

  $('#aiRefresh').click(function() {
    self._refreshAdvice();
  });
};


AIHelper.prototype.toggleAutoPlay = function() {
  if (this.autoPlayActive) {
    this.stopAutoPlay();
  } else {
    this.startAutoPlay();
  }
};


AIHelper.prototype.startAutoPlay = function() {
  if (this.autoPlayActive) return;

  this.autoPlayActive = true;
  this._actionCount = 0;
  $('#aiAutoPlay').text('Stop Auto-Play').addClass('ai-active');
  $('#aiStatus').text('Auto-play active...').addClass('ai-status-active');

  this._scheduleNextAction();
};


AIHelper.prototype.stopAutoPlay = function() {
  this.autoPlayActive = false;
  if (this._autoPlayTimer) {
    clearTimeout(this._autoPlayTimer);
    this._autoPlayTimer = null;
  }

  $('#aiAutoPlay').text('Auto-Play').removeClass('ai-active');
  $('#aiStatus').text('Auto-play stopped. ' + this._actionCount + ' actions taken.').removeClass('ai-status-active');
};


AIHelper.prototype._scheduleNextAction = function() {
  if (!this.autoPlayActive) return;

  var self = this;
  var speed = this.simulation._speed;
  var interval = SPEED_INTERVALS[speed] || 2000;

  this._autoPlayTimer = setTimeout(function() {
    if (self.autoPlayActive) {
      if (!self.game.isPaused && !self.game.dialogOpen) {
        self._executeNextAction();
      }
      self._scheduleNextAction();
    }
  }, interval);
};


AIHelper.prototype._startAdviceLoop = function() {
  var self = this;
  this._adviceTimer = setInterval(function() {
    if (!$('#aiPanel').hasClass('ai-hidden')) {
      self._refreshAdvice();
    }
  }, ADVICE_INTERVAL);
};


AIHelper.prototype._refreshAdvice = function() {
  var advice = this.advisor.getAdvice();
  var $list = $('#aiAdviceList');
  $list.empty();

  if (advice.length === 0) {
    $list.append('<li class="ai-advice-item ai-good">City is doing well! No urgent actions needed.</li>');
  } else {
    for (var i = 0; i < advice.length; i++) {
      var className = 'ai-advice-item';
      if (i === 0) className += ' ai-urgent';
      $list.append('<li class="' + className + '">' + advice[i] + '</li>');
    }
  }

  this._updateStats();
};


AIHelper.prototype._updateStats = function() {
  var census = this.simulation._census;
  var budget = this.simulation.budget;
  var valves = this.simulation._valves;
  var eval_ = this.simulation.evaluation;

  var rBar = this._makeBar(valves.resValve);
  var cBar = this._makeBar(valves.comValve);
  var iBar = this._makeBar(valves.indValve);

  // Power utilization (math-based)
  var totalZones = census.poweredZoneCount + census.unpoweredZoneCount;
  var coalPlants = census.coalPowerPop;
  var nuclearPlants = census.nuclearPowerPop;
  var maxPower = coalPlants * 700 + nuclearPlants * 2000;
  var estConsumption = totalZones * 12 + (coalPlants + nuclearPlants) * 16;
  var powerUtil = maxPower > 0 ? Math.round(estConsumption / maxPower * 100) : 0;
  var zonesLeft = maxPower > 0 ? Math.floor((maxPower - estConsumption) / 12) : 0;

  // Employment balance
  var normalizedResPop = census.resPop / 8;
  var employment = normalizedResPop > 0 ?
    Math.round((census.comPop + census.indPop) / normalizedResPop * 100) : 100;

  var phase = this.advisor._getPhase();

  // Show tax valve effect — the key insight the smart AI exploits
  var taxEffect = this.advisor._getTaxValveEffect(budget.cityTax);
  var taxEffectStr = taxEffect > 0 ? '+' + taxEffect : '' + taxEffect;
  var neutralTax = this.advisor._getNeutralTax();

  // Show demand cap warnings
  var caps = [];
  if (valves.resCap) caps.push('R');
  if (valves.comCap) caps.push('C');
  if (valves.indCap) caps.push('I');
  var capStr = caps.length > 0 ? ' <span class="ai-demand-neg">CAP:' + caps.join(',') + '</span>' : '';

  // Revenue projection
  var projRevenue = this.advisor._projectRevenue(budget.cityTax);
  var projMaint = this.advisor._projectMaintenance();

  // === CLOSED-LOOP: Valve trajectory ===
  var prediction = this.advisor._lastValvePrediction;
  var valveTrajectory = '';
  if (prediction) {
    var rd = prediction.resDelta > 0 ? '+' + prediction.resDelta : '' + prediction.resDelta;
    var cd = prediction.comDelta > 0 ? '+' + prediction.comDelta : '' + prediction.comDelta;
    var id = prediction.indDelta > 0 ? '+' + prediction.indDelta : '' + prediction.indDelta;
    valveTrajectory = '<div class="ai-stat">Valve Δ/cycle: R' + rd + ' C' + cd + ' I' + id;
    if (prediction.employment !== undefined) {
      valveTrajectory += ' | LaggedEmp: ' + Math.round(prediction.employment * 100) + '%';
    }
    valveTrajectory += '</div>';
  }

  // === CLOSED-LOOP: Score breakdown ===
  var scoreInfo = '';
  var breakdown = this.advisor._lastScoreBreakdown;
  if (breakdown && census.totalPop > 50) {
    var penalties = breakdown.penalties.length > 0 ?
      ' <span class="ai-demand-neg">×' + breakdown.multiplier.toFixed(2) + '</span>' : '';
    scoreInfo = '<div class="ai-stat">Score: ' + eval_.cityScore +
      ' (est ' + breakdown.estimatedScore + ')' + penalties +
      ' | Top drain: ' + breakdown.biggestProblem + ' (-' + breakdown.biggestProblemCost + ')</div>';
  } else {
    scoreInfo = '<div class="ai-stat">Score: ' + eval_.cityScore + '</div>';
  }

  // === CLOSED-LOOP: Growth stall diagnosis ===
  var stallInfo = '';
  var stallDiag = this.advisor._lastStallDiagnosis;
  if (stallDiag && stallDiag.length > 0) {
    stallInfo = '<div class="ai-stat ai-demand-neg">STALL[' + this.advisor._stallCycles + ']: ' +
      stallDiag[0].cause + '</div>';
  }

  // === CLOSED-LOOP: Fund reservations ===
  var reserveInfo = '';
  var fundRes = this.advisor._shouldReserveFunds();
  if (fundRes.reservations.length > 0) {
    var resNames = fundRes.reservations.map(function(r) { return r.building + '($' + r.cost + ' ' + r.urgency + ')'; });
    reserveInfo = '<div class="ai-stat">Reserve: ' + resNames.join(', ') + '</div>';
  }

  $('#aiStatsContent').html(
    '<div class="ai-stat">Phase: ' + phase + ' | Demand: R' + rBar + ' C' + cBar + ' I' + iBar + capStr + '</div>' +
    '<div class="ai-stat">Tax: ' + budget.cityTax + '% (neutral=' + neutralTax + ', valve ' + taxEffectStr + '/cycle)</div>' +
    valveTrajectory +
    '<div class="ai-stat">Power: ' + powerUtil + '% (' + zonesLeft + ' left) | Emp: ' + employment + '% | Crime: ' + (census.crimeAverage || 0) + '</div>' +
    scoreInfo +
    '<div class="ai-stat">$' + budget.totalFunds + ' (rev $' + projRevenue + ' - maint $' + projMaint + ')</div>' +
    reserveInfo +
    stallInfo
  );
};


AIHelper.prototype._makeBar = function(value) {
  if (value > 500) return '<span class="ai-demand-pos">+++</span>';
  if (value > 100) return '<span class="ai-demand-pos">+</span>';
  if (value < -1000) return '<span class="ai-demand-neg">---</span>';
  if (value < -100) return '<span class="ai-demand-neg">-</span>';
  return '<span class="ai-demand-neutral">=</span>';
};


AIHelper.prototype._executeNextAction = function() {
  // === INFRASTRUCTURE AUDIT: Run BEFORE action dispatch ===
  // Every 3rd cycle, scan for broken infrastructure and fix it immediately.
  // This catches zones that were placed with failed road/power connections,
  // or connections that were destroyed by disasters.
  this._infraCheckCounter = (this._infraCheckCounter || 0) + 1;
  if (this._infraCheckCounter % 3 === 0) {
    var fixed = this._fixBrokenInfrastructure();
    if (fixed) {
      this._actionCount++;
      this._lastAction = 'Fixed broken infrastructure';
      $('#aiStatus').text('#' + this._actionCount + ': Fixed broken infrastructure');
      return; // Spend this cycle on infrastructure, not new building
    }
  }

  var action = this.advisor.decideBestAction();
  if (!action) {
    this._tryPlacePark();
    return;
  }

  var success = false;
  var description = '';

  switch (action.action.type) {
    case 'build_starter':
      success = this._buildStarterCity();
      description = 'Building optimal starter city';
      break;

    case 'build':
      success = this._buildZone(action.action.tool);
      description = 'Building ' + action.action.tool;
      break;

    case 'build_roads':
      success = this._buildRoadConnection();
      description = 'Building road connection';
      break;

    case 'wire_connect':
      success = this._buildWireConnection();
      description = 'Connecting power lines';
      break;

    case 'set_tax':
      success = this._setTaxRate(action.action.value);
      description = 'Set tax to ' + action.action.value + '%';
      break;

    case 'set_funding':
      success = this._setFunding(action.action.road, action.action.fire, action.action.police);
      description = 'Adjusted service funding';
      break;

    case 'bulldoze_rubble':
      success = this._bulldozeRubble();
      description = 'Clearing disaster rubble';
      break;

    case 'expand_grid':
      success = this._expandGrid(action.action.zoneType);
      description = 'Expanding grid for ' + action.action.zoneType;
      break;

    case 'build_park':
      success = this._buildParkAt(action.action.x, action.action.y);
      description = 'Strategic park for land value';
      break;

    case 'reduce_pollution':
      success = this._reducePollution();
      description = 'Pollution remediation';
      break;

    default:
      break;
  }

  if (success) {
    this._actionCount++;
    this._lastAction = description;
    // Track action type for closed-loop mistake detection
    this.advisor._lastActionType = action.action.type;
    this.advisor._lastActionTime = Date.now();
    if (action.action.tool) {
      this.advisor._lastZoneBuildType = action.action.tool;
    }
    $('#aiStatus').text('#' + this._actionCount + ': ' + description);
  }
};


// ---- Budget actions (FREE) ----

AIHelper.prototype._setTaxRate = function(rate) {
  this.simulation.budget.setTax(rate);
  return true;
};


AIHelper.prototype._setFunding = function(road, fire, police) {
  var budget = this.simulation.budget;
  budget.roadPercent = road;
  budget.firePercent = fire;
  budget.policePercent = police;
  budget.updateFundEffects();
  return true;
};


// ---- Core building: separate road and wire decisions ----
//
// OLD approach: _buildRoadWithWire on EVERY road = lazy, expensive ($15/tile).
// NEW approach: Build roads cheap ($10), wire only the power backbone.
//
// From powerManager.js: power propagates through CONDBIT tiles via BFS flood.
// A zone gets power if there's a continuous conductive path from a power plant.
// Zone tiles themselves propagate power when powered, so once one adjacent
// tile is conductive+powered, the whole zone lights up.
//
// Strategy:
//   - Roads for TRAFFIC → plain road ($10)
//   - Roads for POWER BACKBONE → road+wire ($15)
//   - After zone placement → wire the MINIMUM path to reach power grid

// Plain road — no wire, just for traffic. $10.
AIHelper.prototype._buildRoad = function(x, y) {
  var budget = this.simulation.budget;
  if (budget.totalFunds < 10) return false;

  var roadTool = this.tools.road;
  roadTool.doTool(x, y, this.blockMaps);
  if (roadTool.result === roadTool.TOOLRESULT_OK) {
    roadTool.modifyIfEnoughFunding(budget);
    return roadTool.result !== roadTool.TOOLRESULT_NO_MONEY;
  }
  roadTool.clear();
  return false;
};

// Road + wire — for power backbone only. $15.
AIHelper.prototype._buildRoadWithWire = function(x, y) {
  var budget = this.simulation.budget;
  if (budget.totalFunds < 15) return false;

  var roadSuccess = false;
  var roadTool = this.tools.road;
  roadTool.doTool(x, y, this.blockMaps);
  if (roadTool.result === roadTool.TOOLRESULT_OK) {
    roadTool.modifyIfEnoughFunding(budget);
    roadSuccess = (roadTool.result !== roadTool.TOOLRESULT_NO_MONEY);
  } else {
    roadTool.clear();
  }

  var wireSuccess = false;
  var wireTool = this.tools.wire;
  wireTool.doTool(x, y, this.blockMaps);
  if (wireTool.result === wireTool.TOOLRESULT_OK) {
    wireTool.modifyIfEnoughFunding(budget);
    wireSuccess = (wireTool.result !== wireTool.TOOLRESULT_NO_MONEY);
  } else {
    wireTool.clear();
  }

  return roadSuccess || wireSuccess;
};

// Wire a single tile (add wire to existing road or empty tile). $5.
AIHelper.prototype._wireOnly = function(x, y) {
  var budget = this.simulation.budget;
  if (budget.totalFunds < 5) return false;

  var wireTool = this.tools.wire;
  wireTool.doTool(x, y, this.blockMaps);
  if (wireTool.result === wireTool.TOOLRESULT_OK) {
    wireTool.modifyIfEnoughFunding(budget);
    return true;
  }
  wireTool.clear();
  return false;
};


// ---- Deliberate power routing (replaces blanket _wireAdjacentRoads) ----
//
// After placing a zone, wire the MINIMUM tiles needed to connect it to
// the power grid. Instead of wiring all ~8 perimeter roads ($40 wasted),
// find the ONE best adjacent road tile closest to the existing power
// backbone and wire only that tile (+ short path if needed).
//
// From powerManager.js: power BFS explores conductive neighbors.
// So we just need ONE conductive connection from zone to the grid.

// Ensure power reaches a newly placed zone.
//
// OLD: Found ONE adjacent road, wired it, tried a 6-step bridge.
// Failed silently if: no adjacent road, bridge too short, or road
// not connected to power grid. Result: zones placed but never powered.
//
// NEW: Multi-step approach that actually verifies connectivity:
// 1. Check if already powered (any adjacent conductive tile) — done
// 2. Find ALL adjacent roads, wire the one closest to grid
// 3. Build a longer wire path to the grid (up to 15 steps)
// 4. If no adjacent road, find nearest road ANYWHERE and wire path
// 5. As last resort, wire directly toward nearest conductive tile
AIHelper.prototype._ensurePowerAccess = function(x, y, size) {
  var half = Math.floor(size / 2);
  var map = this.map;
  var budget = this.simulation.budget;

  // Step 1: Check if zone already has power access
  for (var dy = -(half + 1); dy <= half + 1; dy++) {
    for (var dx = -(half + 1); dx <= half + 1; dx++) {
      if (Math.abs(dx) <= half && Math.abs(dy) <= half) continue;
      var nx = x + dx;
      var ny = y + dy;
      if (nx >= 0 && ny >= 0 && nx < map.width && ny < map.height) {
        if (map.getTile(nx, ny).isConductive()) return; // Already connected
      }
    }
  }

  if (budget.totalFunds < 5) return;

  // Step 2: Find ALL adjacent roads, pick the one closest to the power grid
  var bestRoad = null;
  var bestDist = Infinity;

  for (dy = -(half + 1); dy <= half + 1; dy++) {
    for (dx = -(half + 1); dx <= half + 1; dx++) {
      if (Math.abs(dx) <= half && Math.abs(dy) <= half) continue;
      nx = x + dx;
      ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= map.width || ny >= map.height) continue;

      var tv = map.getTileValue(nx, ny);
      if (!TileUtils.isRoad(tv) && tv !== 0) continue; // Road or empty tile
      if (map.getTile(nx, ny).isConductive()) {
        // This tile is already conductive — zone should get power from here
        return;
      }

      var dist = this._distToConductive(nx, ny);
      if (dist < bestDist) {
        bestDist = dist;
        bestRoad = { x: nx, y: ny };
      }
    }
  }

  // Step 3: Wire the best adjacent road
  if (bestRoad) {
    this._wireOnly(bestRoad.x, bestRoad.y);

    // Step 4: Build wire path from that road to the power grid
    // Use a LONGER max path (15 steps instead of old 6) to actually reach the grid
    if (bestDist > 1 && budget.totalFunds >= 5) {
      var nearest = this._findNearestConductive(bestRoad.x, bestRoad.y, 20);
      if (nearest) {
        this._wirePathBetween(bestRoad.x, bestRoad.y, nearest.x, nearest.y, 15);
      }
    }
    return;
  }

  // Step 5: No adjacent road at all — find nearest road ANYWHERE and wire toward it
  // This handles the case where _ensureRoadAccess built a road but it's not adjacent
  var nearestRoad = this.advisor._findNearestRoad(x, y);
  if (nearestRoad && budget.totalFunds >= 5) {
    // Wire from zone toward nearest road
    var startX = x + (nearestRoad.x > x ? half + 1 : -(half + 1));
    var startY = y + (nearestRoad.y > y ? half + 1 : -(half + 1));
    // Clamp start to map
    startX = Math.max(0, Math.min(startX, map.width - 1));
    startY = Math.max(0, Math.min(startY, map.height - 1));
    this._wirePathBetween(startX, startY, nearestRoad.x, nearestRoad.y, 15);
    return;
  }

  // Step 6: Last resort — wire directly toward nearest conductive tile
  var nearestCond = this._findNearestConductive(x, y, 25);
  if (nearestCond && budget.totalFunds >= 5) {
    var wireStart = { x: x + (nearestCond.x > x ? half + 1 : -(half + 1)),
                      y: y + (nearestCond.y > y ? half + 1 : -(half + 1)) };
    wireStart.x = Math.max(0, Math.min(wireStart.x, map.width - 1));
    wireStart.y = Math.max(0, Math.min(wireStart.y, map.height - 1));
    this._wirePathBetween(wireStart.x, wireStart.y, nearestCond.x, nearestCond.y, 20);
  }
};

// Manhattan-distance search for nearest conductive tile
AIHelper.prototype._distToConductive = function(x, y) {
  var map = this.map;
  for (var r = 1; r <= 12; r++) {
    for (var dy = -r; dy <= r; dy++) {
      for (var dx = -r; dx <= r; dx++) {
        if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
        var nx = x + dx;
        var ny = y + dy;
        if (nx >= 0 && ny >= 0 && nx < map.width && ny < map.height) {
          if (map.getTile(nx, ny).isConductive()) return r;
        }
      }
    }
  }
  return 999;
};

AIHelper.prototype._findNearestConductive = function(x, y, maxRadius) {
  var map = this.map;
  for (var r = 1; r <= maxRadius; r++) {
    for (var dy = -r; dy <= r; dy++) {
      for (var dx = -r; dx <= r; dx++) {
        if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
        var nx = x + dx;
        var ny = y + dy;
        if (nx >= 0 && ny >= 0 && nx < map.width && ny < map.height) {
          if (map.getTile(nx, ny).isConductive()) return { x: nx, y: ny };
        }
      }
    }
  }
  return null;
};

// Wire a path between two points, following existing roads where possible.
// If no road exists at a tile, build a road+wire there (power backbone).
// OLD: Stopped at the first non-road tile — gave up.
// NEW: Builds road+wire through empty tiles to actually complete the path.
AIHelper.prototype._wirePathBetween = function(fromX, fromY, toX, toY, maxSteps) {
  var map = this.map;
  var budget = this.simulation.budget;
  var cx = fromX;
  var cy = fromY;

  for (var step = 0; step < maxSteps; step++) {
    if (cx === toX && cy === toY) break;
    if (budget.totalFunds < 5) break;

    var ddx = toX - cx;
    var ddy = toY - cy;

    // Try primary direction (toward target)
    var nx, ny;
    if (Math.abs(ddx) >= Math.abs(ddy)) {
      nx = cx + (ddx > 0 ? 1 : -1);
      ny = cy;
    } else {
      nx = cx;
      ny = cy + (ddy > 0 ? 1 : -1);
    }

    if (nx < 0 || ny < 0 || nx >= map.width || ny >= map.height) break;

    var tile = map.getTile(nx, ny);
    if (tile.isConductive()) break; // Reached the power grid — done!

    var tv = map.getTileValue(nx, ny);
    if (TileUtils.isRoad(tv)) {
      // Road exists but not wired — wire it
      this._wireOnly(nx, ny);
      cx = nx;
      cy = ny;
      continue;
    }

    // Empty tile (or buildable) — build road+wire through it
    // This creates the power backbone to bridge the gap
    if (tv === 0 || tv === TileValues.DIRT) {
      if (budget.totalFunds >= 15) {
        this._buildRoadWithWire(nx, ny);
        cx = nx;
        cy = ny;
        continue;
      }
    }

    // Try alternate direction if primary is blocked
    if (Math.abs(ddx) >= Math.abs(ddy)) {
      nx = cx;
      ny = cy + (ddy >= 0 ? 1 : -1);
    } else {
      nx = cx + (ddx >= 0 ? 1 : -1);
      ny = cy;
    }

    if (nx < 0 || ny < 0 || nx >= map.width || ny >= map.height) break;

    tile = map.getTile(nx, ny);
    if (tile.isConductive()) break;

    tv = map.getTileValue(nx, ny);
    if (TileUtils.isRoad(tv)) {
      this._wireOnly(nx, ny);
      cx = nx;
      cy = ny;
      continue;
    }
    if ((tv === 0 || tv === TileValues.DIRT) && budget.totalFunds >= 15) {
      this._buildRoadWithWire(nx, ny);
      cx = nx;
      cy = ny;
      continue;
    }

    break; // Truly blocked — obstacle we can't build through
  }
};


// ---- Starter City: Optimal T-Grid Layout ----
//
// Math: 1 coal ($3000) + 3R+1C+2I ($600) + roads/wire (~$600) = ~$4200
// R:(C+I) = 3:3 = 1:1 → balanced employment from the start.
// 1 coal plant (700 capacity) handles all 6 zones + 50 more before 2nd needed.
// Grid-aligned positions (offset ≡ 2 mod 4) so expansion zones mesh perfectly.

AIHelper.prototype._buildStarterCity = function() {
  var budget = this.simulation.budget;
  if (budget.totalFunds < 4500) return false;

  var origin = this.advisor.findStarterLocation();
  if (!origin) return false;

  var gx = origin.x;
  var gy = origin.y;

  // Store grid plan
  this.advisor.initCityPlan(gx, gy);

  // === Step 1: Coal power plant ($3000) ===
  // 700 capacity = ~57 zones. This one plant handles Town → City → most of Capital.
  // South-east, adjacent to industrial area.
  var coalTool = this.tools.coal;
  coalTool.doTool(gx + 4, gy + 9, this.blockMaps);
  if (coalTool.result !== coalTool.TOOLRESULT_OK) {
    coalTool.clear();
    coalTool.doTool(gx - 4, gy + 9, this.blockMaps);
    if (coalTool.result !== coalTool.TOOLRESULT_OK) {
      coalTool.clear();
      return false;
    }
  }
  coalTool.modifyIfEnoughFunding(budget);
  if (coalTool.result === coalTool.TOOLRESULT_NO_MONEY) return false;

  // === Step 2: Main horizontal road at y=gy (city spine) ===
  //
  // Deliberate power routing:
  // Power plant is at (gx+4, gy+9). Power must reach zones north of main road.
  // The BACKBONE (wired): branch road (gx, gy+1..gy+8) + main road near zones.
  // The PERIPHERY (plain): outer road tiles only needed for traffic access.
  //
  // Zone positions: R at gx-2, gx+2, gx+6 (north), C at gx-6 (north),
  //                 I at gx-2, gx+2 (south, near plant cross-road).
  // Wired backbone: main road gx-7 to gx+7 (zones adjacent to main road
  //   need it conductive), branch gx down to plant, cross-road near plant.
  // We wire the main road because ALL zones are adjacent to it — without it
  // they'd all be unpowered. The branch and cross-road connect to the plant.
  var rx, ry;

  // Main road: wire it because zones on both sides need power from it.
  // This IS the power backbone — every zone touches this road.
  for (rx = gx - 7; rx <= gx + 7; rx++) {
    this._buildRoadWithWire(rx, gy);
  }

  // Branch road south: power backbone from main road to plant area.
  // Only need to wire from main road down to cross-road.
  for (ry = gy + 1; ry <= gy + 8; ry++) {
    this._buildRoadWithWire(gx, ry);
  }

  // Cross-road at plant: wire near industrial zones and plant connection.
  for (rx = gx - 3; rx <= gx + 3; rx++) {
    if (rx !== gx) {
      this._buildRoadWithWire(rx, gy + 8);
    }
  }

  // === Step 5: Residential zones NORTH (3 zones, grid-aligned) ===
  // Grid-aligned: offset ≡ 2 (mod 4) from grid origin
  // Zone at (gx-2, gy-2): occupies (gx-3,gy-3)→(gx-1,gy-1), adjacent to road at gy ✓
  // Zone at (gx+2, gy-2): occupies (gx+1,gy-3)→(gx+3,gy-1), adjacent to road at gy ✓
  // Zone at (gx+6, gy-2): occupies (gx+5,gy-3)→(gx+7,gy-1), adjacent to road at gy ✓
  var resTool = this.tools.residential;
  var resPositions = [[gx - 2, gy - 2], [gx + 2, gy - 2], [gx + 6, gy - 2]];
  for (var i = 0; i < resPositions.length; i++) {
    if (budget.totalFunds < 600) break;
    resTool.doTool(resPositions[i][0], resPositions[i][1], this.blockMaps);
    if (resTool.result === resTool.TOOLRESULT_OK) {
      resTool.modifyIfEnoughFunding(budget);
    } else {
      resTool.clear();
    }
  }

  // === Step 6: Commercial zone (1 zone, near junction) ===
  // At (gx-6, gy-2): west end of main road, grid-aligned
  if (budget.totalFunds >= 600) {
    var comTool = this.tools.commercial;
    comTool.doTool(gx - 6, gy - 2, this.blockMaps);
    if (comTool.result === comTool.TOOLRESULT_OK) {
      comTool.modifyIfEnoughFunding(budget);
    } else {
      comTool.clear();
    }
  }

  // === Step 7: Industrial zones SOUTH (2 zones, flanking branch) ===
  // At (gx+2, gy+6) and (gx-2, gy+6): grid-aligned, adjacent to branch road
  // Distance from residential: ~8 tiles vertically → good separation
  var indTool = this.tools.industrial;
  var indPositions = [[gx + 2, gy + 6], [gx - 2, gy + 6]];
  for (var i = 0; i < indPositions.length; i++) {
    if (budget.totalFunds < 600) break;
    indTool.doTool(indPositions[i][0], indPositions[i][1], this.blockMaps);
    if (indTool.result === indTool.TOOLRESULT_OK) {
      indTool.modifyIfEnoughFunding(budget);
    } else {
      indTool.clear();
    }
  }

  // === Step 8: Growth-optimized starting tax ===
  // OLD: fixed 7% (only neutral on Easy). NEW: use low tax for growth burst.
  // From valves.js: taxTable index = cityTax + gameLevel
  // Tax 3 on Easy = index 3 = +100/cycle valve bonus = explosive early growth
  // We have $15k+ in reserves to cover the deficit.
  var neutralTax = this.advisor._getNeutralTax();
  var startTax = Math.max(0, neutralTax - 4); // Aggressive growth investment
  this.simulation.budget.setTax(startTax);

  return true;
};


// ---- Zone building with power connectivity ----

AIHelper.prototype._buildZone = function(toolName) {
  var budget = this.simulation.budget;
  var tool = this.tools[toolName];
  if (!tool) return false;

  var loc;
  var size = this._getToolSize(toolName);

  if (size === 6) {
    loc = this.advisor.findBestAirportLocation();
  } else if (size === 4) {
    loc = this.advisor.findBestLargeLocation(toolName);
  } else {
    loc = this.advisor.findBestZoneLocation(toolName);
  }

  if (!loc || loc.score < -100) return false;

  tool.doTool(loc.x, loc.y, this.blockMaps);
  if (tool.result === tool.TOOLRESULT_OK) {
    tool.modifyIfEnoughFunding(budget);
    if (tool.result !== tool.TOOLRESULT_NO_MONEY) {
      // Ensure road access (plain road — no wire wasted)
      this._ensureRoadAccess(loc.x, loc.y, size);
      // Wire the MINIMUM path to connect this zone to the power grid
      // (replaces old _wireAdjacentRoads that blanket-wired everything)
      this._ensurePowerAccess(loc.x, loc.y, size);
      return true;
    }
  }
  tool.clear();
  return false;
};


// Build road connection — connect isolated zones to the road network.
// OLD: Built ONE path to ONE zone per cycle (max 10 roads).
// NEW: Fix MULTIPLE disconnected zones per cycle, and wire the
// connection point so power can flow through the new road.
AIHelper.prototype._buildRoadConnection = function() {
  var budget = this.simulation.budget;
  var success = false;
  var maxAttempts = 3; // Fix up to 3 disconnected zones per cycle

  for (var attempt = 0; attempt < maxAttempts; attempt++) {
    if (budget.totalFunds < 200) break;

    var pathOrLoc = this.advisor.findRoadToConnect();
    if (!pathOrLoc) {
      // No more disconnected zones — try traffic bottleneck instead
      if (attempt === 0) {
        var bottleneck = this.advisor.findTrafficBottleneck();
        if (bottleneck) {
          return this._buildRoad(bottleneck.x, bottleneck.y);
        }
      }
      break;
    }

    var maxRoads = 15;
    var pathSuccess = false;

    for (var i = 0; i < Math.min(pathOrLoc.length, maxRoads); i++) {
      if (budget.totalFunds < 10) break;
      var pos = pathOrLoc[i];
      if (this._buildRoad(pos.x, pos.y)) {
        pathSuccess = true;
      }
    }

    // After building the road path, wire the connection point so
    // power can flow through to the zone.
    if (pathSuccess && pathOrLoc.length > 0) {
      var lastPos = pathOrLoc[Math.min(pathOrLoc.length - 1, maxRoads - 1)];
      // Wire the road tiles near the power grid connection
      var nearCond = this._findNearestConductive(lastPos.x, lastPos.y, 5);
      if (nearCond) {
        this._wireOnly(lastPos.x, lastPos.y);
        // Also wire a couple tiles toward the grid for better connectivity
        this._wirePathBetween(lastPos.x, lastPos.y, nearCond.x, nearCond.y, 5);
      }
      success = true;
    }
  }

  return success;
};


// Build wire connection (for unpowered zones)
// OLD: Fixed ONE path to ONE zone per cycle (max 20 wires).
// NEW: Fix MULTIPLE unpowered zones per cycle. Keep going until
// budget runs low or all zones are connected.
AIHelper.prototype._buildWireConnection = function() {
  var budget = this.simulation.budget;
  var wireTool = this.tools.wire;
  var success = false;
  var totalWired = 0;
  var maxAttempts = 5; // Try up to 5 different unpowered zones per cycle

  for (var attempt = 0; attempt < maxAttempts; attempt++) {
    if (budget.totalFunds < 100) break;

    var path = this.advisor.findWireToConnect();
    if (!path || path.length === 0) break;

    var pathSuccess = false;
    for (var i = 0; i < path.length; i++) {
      if (budget.totalFunds < 5) break;

      var pos = path[i];
      wireTool.doTool(pos.x, pos.y, this.blockMaps);
      if (wireTool.result === wireTool.TOOLRESULT_OK) {
        wireTool.modifyIfEnoughFunding(budget);
        pathSuccess = true;
        totalWired++;
      } else {
        wireTool.clear();
      }
    }

    if (pathSuccess) success = true;
    else break; // Pathfinding failed — stop trying
  }

  return success;
};


// Expand the grid to create new zone slots.
// Plain roads only ($10/tile) — wire added later when zones are actually placed.
// This saves $5/tile on speculative roads that may not need power routing.
AIHelper.prototype._expandGrid = function(zoneType) {
  var roads = this.advisor.findGridExpansionRoads(zoneType);
  if (!roads || roads.length === 0) return false;

  var budget = this.simulation.budget;
  var success = false;

  for (var i = 0; i < roads.length; i++) {
    if (budget.totalFunds < 510) break;
    var pos = roads[i];
    if (this._buildRoad(pos.x, pos.y)) {
      success = true;
    }
  }

  return success;
};


AIHelper.prototype._bulldozeRubble = function() {
  var loc = this.advisor.findRubbleToClear();
  if (!loc) return false;

  var budget = this.simulation.budget;
  if (budget.totalFunds < 501) return false;

  var bulldozerTool = this.tools.bulldozer;
  bulldozerTool.doTool(loc.x, loc.y, this.blockMaps);
  if (bulldozerTool.result === bulldozerTool.TOOLRESULT_OK) {
    bulldozerTool.modifyIfEnoughFunding(budget);
    return true;
  }
  bulldozerTool.clear();
  return false;
};


// ---- Pollution remediation ----
//
// Active response to high pollution. Strategies in order:
//   1. Build parks near polluted residential zones (boost landValue to compensate)
//   2. Bulldoze abandoned/dead residential zones in pollution zones (they waste space)
//
// From residential.js:121: pollution > 128 = zone CANNOT grow.
// From blockMapUtils.js: landValue = (34 - dist/2)*4 + terrain - pollution
// Parks boost terrain density → partially offset pollution damage to land value.

AIHelper.prototype._reducePollution = function() {
  var budget = this.simulation.budget;

  // Strategy 1: Build park near the most polluted residential area
  // Parks cost $10, boost terrain density, partially offset pollution in landValue formula
  if (budget.totalFunds >= 100) {
    var parkLoc = this.advisor.findPollutionParkLocation();
    if (parkLoc) {
      var parkTool = this.tools.park;
      parkTool.doTool(parkLoc.x, parkLoc.y, this.blockMaps);
      if (parkTool.result === parkTool.TOOLRESULT_OK) {
        parkTool.modifyIfEnoughFunding(budget);
        return true;
      }
      parkTool.clear();
    }
  }

  // Strategy 2: Bulldoze dead residential zones (pollution > 128, they'll never grow)
  // This frees up the land and removes the "dead zone" from the city
  if (budget.totalFunds >= 50) {
    var polluted = this.advisor.findPollutedResidentialZone();
    if (polluted && polluted.pollution > 128) {
      var bulldozerTool = this.tools.bulldozer;
      bulldozerTool.doTool(polluted.x, polluted.y, this.blockMaps);
      if (bulldozerTool.result === bulldozerTool.TOOLRESULT_OK) {
        bulldozerTool.modifyIfEnoughFunding(budget);
        return true;
      }
      bulldozerTool.clear();
    }
  }

  return false;
};


// Ensure road access for a zone — ACTUALLY connect to the road network.
//
// OLD: Built a 3-tile stub on the bottom edge. This created disconnected
// road segments that didn't reach the existing network. Zones had a road
// tile adjacent but couldn't route traffic → degraded anyway.
//
// NEW: Find the nearest existing road in the network and build a PATH to it.
// If no road exists within range, build a stub as fallback.
AIHelper.prototype._ensureRoadAccess = function(x, y, size) {
  var half = Math.floor(size / 2);
  var map = this.map;
  var budget = this.simulation.budget;

  // Step 1: Check if zone already has road access via the network
  if (this.advisor._hasAdjacentRoad(x, y)) return;

  if (budget.totalFunds < 510) return;

  // Step 2: Find the nearest road tile that's part of the actual network.
  // Search outward in expanding rings to find it.
  var nearestRoad = this.advisor._findNearestRoad(x, y);
  if (!nearestRoad) {
    // No road on the entire map — build a short stub as minimum
    for (var rx = x - half; rx <= x + half; rx++) {
      var ry = y + half + 1;
      if (ry < map.height && budget.totalFunds >= 10) {
        this._buildRoad(rx, ry);
      }
    }
    return;
  }

  // Step 3: Build a road path from zone edge to the nearest network road.
  // Start from the zone edge closest to the target road.
  var startX, startY;
  var dx = nearestRoad.x - x;
  var dy = nearestRoad.y - y;

  // Pick the zone edge closest to the target
  if (Math.abs(dx) >= Math.abs(dy)) {
    startX = x + (dx > 0 ? half + 1 : -(half + 1));
    startY = y;
  } else {
    startX = x;
    startY = y + (dy > 0 ? half + 1 : -(half + 1));
  }

  // Walk from start toward target, building roads
  var cx = startX;
  var cy = startY;
  var maxSteps = 20; // Cap spending — don't build 50-tile roads
  var roadsBuilt = 0;

  for (var step = 0; step < maxSteps; step++) {
    if (budget.totalFunds < 10) break;

    // Check if we've reached the road network
    if (TileUtils.isRoad(map.getTileValue(cx, cy))) break;

    // Build road at current position
    if (cx >= 0 && cy >= 0 && cx < map.width && cy < map.height) {
      if (this._buildRoad(cx, cy)) roadsBuilt++;
    }

    // Move toward target
    var ddx = nearestRoad.x - cx;
    var ddy = nearestRoad.y - cy;
    if (ddx === 0 && ddy === 0) break;

    // Prefer the longer axis (Manhattan routing)
    if (Math.abs(ddx) >= Math.abs(ddy)) {
      cx += (ddx > 0 ? 1 : -1);
    } else {
      cy += (ddy > 0 ? 1 : -1);
    }
  }
};


// Build a park at a specific location (from advisor recommendation)
AIHelper.prototype._buildParkAt = function(x, y) {
  var budget = this.simulation.budget;
  if (budget.totalFunds < 525) return false;

  var parkTool = this.tools.park;
  parkTool.doTool(x, y, this.blockMaps);
  if (parkTool.result === parkTool.TOOLRESULT_OK) {
    parkTool.modifyIfEnoughFunding(budget);
    return true;
  }
  parkTool.clear();
  return false;
};


// When no other actions: place multiple parks per cycle for land value optimization.
// Parks are $25 each with zero maintenance — best ROI in the game.
// From blockMapUtils.js: parks boost terrainDensity → landValue → revenue.
AIHelper.prototype._tryPlacePark = function() {
  var budget = this.simulation.budget;
  if (budget.totalFunds < 1000) return;

  var map = this.map;
  var blockMaps = this.blockMaps;

  // Find and rank all candidate park locations
  var candidates = [];
  for (var y = 2; y < map.height - 2; y += 3) {
    for (var x = 2; x < map.width - 2; x += 3) {
      if (map.getTileValue(x, y) !== 0) continue;

      var pop = this.advisor._safeBlockGet(blockMaps.populationDensityMap, x, y);
      if (pop < 8) continue;

      var score = pop * 2;
      if (this.advisor._hasNearbyRoad(x, y, 2)) score += 30;
      else continue;
      if (this.advisor._hasNearbyResidential(x, y, 4)) score += 40;

      // Prefer areas where land value improvement helps most
      var lv = this.advisor._safeBlockGet(blockMaps.landValueMap, x, y);
      if (lv < 100) score += 20;

      candidates.push({ x: x, y: y, score: score });
    }
  }

  if (candidates.length === 0) return;

  // Sort by score descending
  candidates.sort(function(a, b) { return b.score - a.score; });

  // Place up to 3 parks per idle cycle (they're cheap)
  var parksPlaced = 0;
  var maxParks = Math.min(3, candidates.length);

  for (var i = 0; i < maxParks; i++) {
    if (budget.totalFunds < 525) break;

    var c = candidates[i];
    var parkTool = this.tools.park;
    parkTool.doTool(c.x, c.y, blockMaps);
    if (parkTool.result === parkTool.TOOLRESULT_OK) {
      parkTool.modifyIfEnoughFunding(budget);
      parksPlaced++;
    } else {
      parkTool.clear();
    }
  }

  if (parksPlaced > 0) {
    this._actionCount += parksPlaced;
    this._lastAction = 'Placed ' + parksPlaced + ' parks';
    $('#aiStatus').text('#' + this._actionCount + ': Placed ' + parksPlaced + ' parks for land value');
  }
};


AIHelper.prototype._getToolSize = function(toolName) {
  var sizes = {
    residential: 3, commercial: 3, industrial: 3,
    police: 3, fire: 3,
    coal: 4, nuclear: 4, port: 4, stadium: 4,
    airport: 6
  };
  return sizes[toolName] || 3;
};


// === INFRASTRUCTURE AUDIT LOOP ===
// Scans the entire map for broken infrastructure and fixes it.
// This is the AI's "look at what I built and fix what's wrong" loop.
//
// Checks:
// 1. Zones without adjacent roads → build road path to network
// 2. Zones with roads but no power → wire path to power grid
//
// Returns true if any fix was applied (so the cycle is spent on repair).
AIHelper.prototype._fixBrokenInfrastructure = function() {
  var map = this.map;
  var budget = this.simulation.budget;
  if (budget.totalFunds < 200) return false;

  var fixed = false;

  // Pass 1: Fix zones without road access
  for (var y = 1; y < map.height - 1; y++) {
    for (var x = 1; x < map.width - 1; x++) {
      if (budget.totalFunds < 100) return fixed;

      var tile = map.getTile(x, y);
      if (!tile.isZone()) continue;

      // Check if this zone has any adjacent road (within 2 tiles for 3x3 zones)
      if (!this.advisor._hasAdjacentRoad(x, y)) {
        // Zone has NO road access — build a connection
        this._ensureRoadAccess(x, y, 3);
        fixed = true;
        continue; // Move to next zone
      }

      // Check if zone is unpowered and has adjacent roads we can wire
      if (!tile.isPowered()) {
        this._ensurePowerAccess(x, y, 3);
        fixed = true;
      }
    }
  }

  return fixed;
};


AIHelper.prototype.destroy = function() {
  if (this._autoPlayTimer) clearTimeout(this._autoPlayTimer);
  if (this._adviceTimer) clearInterval(this._adviceTimer);
};


export { AIHelper };
