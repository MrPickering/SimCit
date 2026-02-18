/* AI Helper for SimCit - Auto-Play Engine
 *
 * Integrates the AI Advisor strategy engine with the game:
 * 1. Advisory panel with recommendations
 * 2. Auto-play with optimal city building strategy
 *
 * Starter City Layout (T-grid):
 *   Main road (east-west) at y=gy with wire for power
 *   Branch road (south) at x=gx with wire for power
 *   South cross-road at y=gy+8 connecting to power plant
 *   Residential zones: NORTH of main road (clean area)
 *   Commercial zone: center, NORTH of main road
 *   Industrial zone: SOUTH, east of branch (pollution contained)
 *   Coal power plant: south-east, adjacent to road+wire grid
 *
 * Power Strategy:
 *   Wire on roads creates road+power hybrid tiles (CONDBIT)
 *   Power propagates: plant → road+wire → zone tiles (CONDBIT)
 *   All zones adjacent to wired roads get power automatically
 *
 * Key behaviors:
 *   - Maintains fund reserve (phase-dependent)
 *   - Adapts action speed to game speed
 *   - Always builds road+wire pairs for power connectivity
 *   - Strict zone district separation
 */

import $ from 'jquery';

import { AIAdvisor } from './aiAdvisor.js';
import { GameTools } from './gameTools.js';
import { Simulation } from './simulation.js';
import { TileUtils } from './tileUtils.js';

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

  var powerZones = census.poweredZoneCount + census.unpoweredZoneCount;
  var powerPct = powerZones > 0 ? Math.round(census.poweredZoneCount / powerZones * 100) : 100;

  var jobBase = (census.comPop + census.indPop) * 8;
  var unemployment = 0;
  if (jobBase > 0) {
    unemployment = Math.max(0, Math.round((census.resPop / jobBase - 1) * 100));
  }

  var phase = this.advisor._getPhase();

  $('#aiStatsContent').html(
    '<div class="ai-stat">Phase: ' + phase + ' | Demand: R' + rBar + ' C' + cBar + ' I' + iBar + '</div>' +
    '<div class="ai-stat">Power: ' + powerPct + '% | Crime: ' + (census.crimeAverage || 0) + '</div>' +
    '<div class="ai-stat">Traffic: ' + Math.round(census.trafficAverage || 0) + ' | Unemp: ' + unemployment + '%</div>' +
    '<div class="ai-stat">Score: ' + eval_.cityScore + ' | $' + budget.totalFunds + ' (flow: $' + budget.cashFlow + ')</div>'
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

    default:
      break;
  }

  if (success) {
    this._actionCount++;
    this._lastAction = description;
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


// ---- Core building: road + wire pair ----

AIHelper.prototype._buildRoadWithWire = function(x, y) {
  var budget = this.simulation.budget;
  if (budget.totalFunds < 15) return false; // $10 road + $5 wire

  var roadTool = this.tools.road;
  roadTool.doTool(x, y, this.blockMaps);
  if (roadTool.result === roadTool.TOOLRESULT_OK) {
    roadTool.modifyIfEnoughFunding(budget);
    if (roadTool.result === roadTool.TOOLRESULT_NO_MONEY) return false;
  } else {
    roadTool.clear();
    // Road might already exist - still wire it
  }

  // Wire on top of road creates road+power hybrid (CONDBIT)
  var wireTool = this.tools.wire;
  wireTool.doTool(x, y, this.blockMaps);
  if (wireTool.result === wireTool.TOOLRESULT_OK) {
    wireTool.modifyIfEnoughFunding(budget);
  } else {
    wireTool.clear();
  }

  return true;
};


// Wire adjacent road tiles to ensure zone gets power
AIHelper.prototype._wireAdjacentRoads = function(x, y, size) {
  var half = Math.floor(size / 2);
  var wireTool = this.tools.wire;
  var budget = this.simulation.budget;
  var map = this.map;

  // Check all perimeter tiles around the zone
  for (var dy = -(half + 1); dy <= half + 1; dy++) {
    for (var dx = -(half + 1); dx <= half + 1; dx++) {
      // Only perimeter
      if (Math.abs(dx) <= half && Math.abs(dy) <= half) continue;
      var nx = x + dx;
      var ny = y + dy;
      if (nx >= 0 && ny >= 0 && nx < map.width && ny < map.height) {
        var tv = map.getTileValue(nx, ny);
        if (TileUtils.isRoad(tv) && !map.getTile(nx, ny).isConductive()) {
          if (budget.totalFunds >= 505) {
            wireTool.doTool(nx, ny, this.blockMaps);
            if (wireTool.result === wireTool.TOOLRESULT_OK) {
              wireTool.modifyIfEnoughFunding(budget);
            } else {
              wireTool.clear();
            }
          }
        }
      }
    }
  }
};


// ---- Starter City: Optimal T-Grid Layout ----

AIHelper.prototype._buildStarterCity = function() {
  var budget = this.simulation.budget;
  if (budget.totalFunds < 4000) return false;

  var origin = this.advisor.findStarterLocation();
  if (!origin) return false;

  var gx = origin.x;
  var gy = origin.y;

  // Store grid plan
  this.advisor.initCityPlan(gx, gy);

  // === Step 1: Coal power plant (south-east, near future industrial area) ===
  // doTool(gx+4, gy+9) → occupies (gx+3, gy+8) to (gx+6, gy+11)
  // Plant tile at (gx+3, gy+8) will be adjacent to road at (gx+2, gy+8)
  var coalTool = this.tools.coal;
  coalTool.doTool(gx + 4, gy + 9, this.blockMaps);
  if (coalTool.result !== coalTool.TOOLRESULT_OK) {
    coalTool.clear();
    // Try alternate position
    coalTool.doTool(gx - 4, gy + 9, this.blockMaps);
    if (coalTool.result !== coalTool.TOOLRESULT_OK) {
      coalTool.clear();
      return false;
    }
  }
  coalTool.modifyIfEnoughFunding(budget);
  if (coalTool.result === coalTool.TOOLRESULT_NO_MONEY) return false;

  // === Step 2: Main horizontal road at y=gy (the city spine) ===
  // 13 tiles from gx-6 to gx+6, with wire on each for power
  var rx;
  for (rx = gx - 6; rx <= gx + 6; rx++) {
    this._buildRoadWithWire(rx, gy);
  }

  // === Step 3: Branch road south at x=gx (industrial access) ===
  // 8 tiles from gy+1 to gy+8, with wire
  var ry;
  for (ry = gy + 1; ry <= gy + 8; ry++) {
    this._buildRoadWithWire(gx, ry);
  }

  // === Step 4: South cross-road at y=gy+8 (power plant connection) ===
  // 4 tiles from gx-2 to gx+2, excluding gx (already has road)
  for (rx = gx - 2; rx <= gx + 2; rx++) {
    if (rx !== gx) {
      this._buildRoadWithWire(rx, gy + 8);
    }
  }

  // === Step 5: Residential zones (NORTH of main road - clean area) ===
  // Zone at (gx-4, gy-2): occupies (gx-5,gy-3) to (gx-3,gy-1)
  // South perimeter touches main road at gy → road access ✓
  // Zone tiles have CONDBIT → power from adjacent road+wire ✓
  var resTool = this.tools.residential;
  resTool.doTool(gx - 4, gy - 2, this.blockMaps);
  if (resTool.result === resTool.TOOLRESULT_OK) {
    resTool.modifyIfEnoughFunding(budget);
  } else {
    resTool.clear();
  }

  // Second residential zone (east side)
  if (budget.totalFunds >= 600) {
    resTool.doTool(gx + 4, gy - 2, this.blockMaps);
    if (resTool.result === resTool.TOOLRESULT_OK) {
      resTool.modifyIfEnoughFunding(budget);
    } else {
      resTool.clear();
    }
  }

  // === Step 6: Commercial zone (center, north of main road) ===
  if (budget.totalFunds >= 600) {
    var comTool = this.tools.commercial;
    comTool.doTool(gx, gy - 2, this.blockMaps);
    if (comTool.result === comTool.TOOLRESULT_OK) {
      comTool.modifyIfEnoughFunding(budget);
    } else {
      comTool.clear();
    }
  }

  // === Step 7: Industrial zone (SOUTH area, east of branch road) ===
  // Zone at (gx+2, gy+6): occupies (gx+1,gy+5) to (gx+3,gy+7)
  // West perimeter at x=gx touches branch road → road access ✓
  // Distance from residential (gx-4,gy-2): ~14 tiles → separation ✓
  // Distance from residential (gx+4,gy-2): ~10 tiles → separation ✓
  if (budget.totalFunds >= 600) {
    var indTool = this.tools.industrial;
    indTool.doTool(gx + 2, gy + 6, this.blockMaps);
    if (indTool.result === indTool.TOOLRESULT_OK) {
      indTool.modifyIfEnoughFunding(budget);
    } else {
      indTool.clear();
    }
  }

  // === Step 8: Set optimal starting tax rate ===
  this.simulation.budget.setTax(7);

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
      // Ensure road access (builds road+wire for power too)
      this._ensureRoadAccess(loc.x, loc.y, size);
      // Wire any adjacent roads that aren't conductive
      this._wireAdjacentRoads(loc.x, loc.y, size);
      return true;
    }
  }
  tool.clear();
  return false;
};


// Build road connection (with wire for power)
AIHelper.prototype._buildRoadConnection = function() {
  var pathOrLoc = this.advisor.findRoadToConnect();
  if (!pathOrLoc) {
    var bottleneck = this.advisor.findTrafficBottleneck();
    if (bottleneck) {
      return this._buildRoadWithWire(bottleneck.x, bottleneck.y);
    }
    return false;
  }

  var budget = this.simulation.budget;
  var success = false;
  var maxRoads = 10;

  for (var i = 0; i < Math.min(pathOrLoc.length, maxRoads); i++) {
    if (budget.totalFunds < 515) break; // Reserve + road + wire
    var pos = pathOrLoc[i];
    if (this._buildRoadWithWire(pos.x, pos.y)) {
      success = true;
    }
  }

  return success;
};


// Build wire connection (for unpowered zones)
AIHelper.prototype._buildWireConnection = function() {
  var path = this.advisor.findWireToConnect();
  if (!path || path.length === 0) return false;

  var budget = this.simulation.budget;
  var wireTool = this.tools.wire;
  var success = false;
  var maxWires = 20;

  for (var i = 0; i < Math.min(path.length, maxWires); i++) {
    if (budget.totalFunds < 505) break;

    var pos = path[i];
    wireTool.doTool(pos.x, pos.y, this.blockMaps);
    if (wireTool.result === wireTool.TOOLRESULT_OK) {
      wireTool.modifyIfEnoughFunding(budget);
      success = true;
    } else {
      wireTool.clear();
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


// Ensure road+wire access for a zone
AIHelper.prototype._ensureRoadAccess = function(x, y, size) {
  if (this.advisor._hasNearbyRoad(x, y, size)) return;

  var budget = this.simulation.budget;
  if (budget.totalFunds < 520) return;

  var half = Math.floor(size / 2);

  // Build a short road+wire segment along the bottom edge
  for (var rx = x - half; rx <= x + half; rx++) {
    var ry = y + half + 1;
    if (ry < this.map.height && budget.totalFunds >= 515) {
      this._buildRoadWithWire(rx, ry);
    }
  }
};


AIHelper.prototype._tryPlacePark = function() {
  var budget = this.simulation.budget;
  if (budget.totalFunds < 1000) return;

  var map = this.map;
  var blockMaps = this.blockMaps;
  var bestScore = -Infinity;
  var bestX = -1, bestY = -1;

  for (var y = 2; y < map.height - 2; y += 5) {
    for (var x = 2; x < map.width - 2; x += 5) {
      if (map.getTileValue(x, y) !== 0) continue;

      var pop = this.advisor._safeBlockGet(blockMaps.populationDensityMap, x, y);
      if (pop < 10) continue;

      var score = pop;
      if (this.advisor._hasNearbyRoad(x, y, 2)) score += 20;
      else continue;

      if (score > bestScore) {
        bestScore = score;
        bestX = x;
        bestY = y;
      }
    }
  }

  if (bestX === -1) return;

  var parkTool = this.tools.park;
  parkTool.doTool(bestX, bestY, blockMaps);
  if (parkTool.result === parkTool.TOOLRESULT_OK) {
    parkTool.modifyIfEnoughFunding(budget);
    this._actionCount++;
    this._lastAction = 'Placed park';
    $('#aiStatus').text('#' + this._actionCount + ': Placed park for land value');
  } else {
    parkTool.clear();
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


AIHelper.prototype.destroy = function() {
  if (this._autoPlayTimer) clearTimeout(this._autoPlayTimer);
  if (this._adviceTimer) clearInterval(this._adviceTimer);
};


export { AIHelper };
