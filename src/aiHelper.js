/* AI Helper for SimCit
 *
 * Integrates the AI Advisor with the game to provide:
 * 1. An advisory panel with recommendations
 * 2. Auto-play mode that automatically builds and manages the city
 *
 * Key behaviors:
 * - Maintains a $500 fund reserve (never spends below this)
 * - Adjusts tax rate and service funding automatically
 * - Adapts action speed to game speed setting
 * - Builds full road/wire paths in one action
 * - Tracks unemployment and zone balance
 */

import $ from 'jquery';

import { AIAdvisor } from './aiAdvisor.js';
import { GameTools } from './gameTools.js';
import { Simulation } from './simulation.js';

// Speed-dependent intervals (ms) for auto-play actions
var SPEED_INTERVALS = {
  1: 3000,  // Slow: act every 3s
  2: 1500,  // Medium: act every 1.5s
  3: 500    // Fast: act every 0.5s
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


// Schedule next action based on current game speed
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

  // Calculate unemployment for display
  var jobBase = (census.comPop + census.indPop) * 8;
  var unemployment = 0;
  if (jobBase > 0) {
    unemployment = Math.max(0, Math.round((census.resPop / jobBase - 1) * 100));
  }

  $('#aiStatsContent').html(
    '<div class="ai-stat">Demand: R' + rBar + ' C' + cBar + ' I' + iBar + '</div>' +
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
    // Nothing urgent - try placing parks to improve land value
    this._tryPlacePark();
    return;
  }

  var success = false;
  var description = '';

  switch (action.action.type) {
    case 'build_starter':
      success = this._buildStarterCity();
      description = 'Building starter city layout';
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


// ---- Budget actions (FREE - no spending) ----

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


// ---- Building actions ----

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
      this._ensureRoadAccess(loc.x, loc.y, size);
      this._ensurePowerAccess(loc.x, loc.y, size);
      return true;
    }
  }
  tool.clear();
  return false;
};


AIHelper.prototype._buildStarterCity = function() {
  var budget = this.simulation.budget;
  if (budget.totalFunds < 1000) return false;

  var cx = this.map.cityCentreX;
  var cy = this.map.cityCentreY;

  // Find a clear area near center
  var startX = -1, startY = -1;
  for (var r = 0; r < 30; r++) {
    for (var dy = -r; dy <= r; dy++) {
      for (var dx = -r; dx <= r; dx++) {
        if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
        var tx = cx + dx;
        var ty = cy + dy;
        if (this.advisor._isAreaClear(tx - 2, ty - 2, 15)) {
          startX = tx;
          startY = ty;
          break;
        }
      }
      if (startX !== -1) break;
    }
    if (startX !== -1) break;
  }

  if (startX === -1) return false;

  // Strategy: build SMALL and compact. Don't overspend.
  // Layout:
  //   Power plant at top-left, wire row connecting to zones
  //   Road row through middle
  //   2 residential above road, 1 commercial + 1 industrial below

  // Step 1: Power plant if we can afford it ($3000)
  if (budget.totalFunds >= 5000) {
    var coalTool = this.tools.coal;
    coalTool.doTool(startX - 4, startY - 3, this.blockMaps);
    coalTool.modifyIfEnoughFunding(budget);
  }

  // Step 2: Short road segment (only 6-8 tiles, not 11)
  var roadTool = this.tools.road;
  for (var rx = startX - 1; rx <= startX + 6; rx++) {
    roadTool.doTool(rx, startY, this.blockMaps);
    roadTool.modifyIfEnoughFunding(budget);
  }

  // Step 3: Just 1 residential zone to start (don't overspend!)
  var resTool = this.tools.residential;
  resTool.doTool(startX + 1, startY - 2, this.blockMaps);
  resTool.modifyIfEnoughFunding(budget);

  // Step 4: 1 commercial
  if (budget.totalFunds >= 600) {
    var comTool = this.tools.commercial;
    comTool.doTool(startX + 5, startY - 2, this.blockMaps);
    comTool.modifyIfEnoughFunding(budget);
  }

  // Step 5: 1 industrial (placed away from residential)
  if (budget.totalFunds >= 600) {
    var indTool = this.tools.industrial;
    indTool.doTool(startX + 1, startY + 3, this.blockMaps);
    indTool.modifyIfEnoughFunding(budget);

    // Extra road to industrial
    roadTool.doTool(startX + 1, startY + 1, this.blockMaps);
    roadTool.modifyIfEnoughFunding(budget);
  }

  // Step 6: Wire from power plant to zones (if plant was built)
  if (budget.totalFunds >= 50) {
    var wireTool = this.tools.wire;
    for (var wx = startX - 2; wx <= startX + 5; wx++) {
      wireTool.doTool(wx, startY - 4, this.blockMaps);
      wireTool.modifyIfEnoughFunding(budget);
    }
  }

  // Set tax to 7% (optimal starting rate)
  this.simulation.budget.setTax(7);

  return true;
};


// Build full road path (not just 1 tile)
AIHelper.prototype._buildRoadConnection = function() {
  var pathOrLoc = this.advisor.findRoadToConnect();
  if (!pathOrLoc) {
    // If no disconnected zones, try relieving traffic bottlenecks
    var bottleneck = this.advisor.findTrafficBottleneck();
    if (bottleneck) {
      return this._placeRoadAt(bottleneck.x, bottleneck.y);
    }
    return false;
  }

  // pathOrLoc is an array of positions
  var budget = this.simulation.budget;
  var roadTool = this.tools.road;
  var success = false;
  var maxRoads = 10; // Cap per action to avoid spending spree

  for (var i = 0; i < Math.min(pathOrLoc.length, maxRoads); i++) {
    if (budget.totalFunds < 510) break; // Keep $500 reserve + $10 for road

    var pos = pathOrLoc[i];
    roadTool.doTool(pos.x, pos.y, this.blockMaps);
    if (roadTool.result === roadTool.TOOLRESULT_OK) {
      roadTool.modifyIfEnoughFunding(budget);
      success = true;
    } else {
      roadTool.clear();
    }
  }

  return success;
};


AIHelper.prototype._placeRoadAt = function(x, y) {
  var budget = this.simulation.budget;
  if (budget.totalFunds < 510) return false;

  var roadTool = this.tools.road;
  roadTool.doTool(x, y, this.blockMaps);
  if (roadTool.result === roadTool.TOOLRESULT_OK) {
    roadTool.modifyIfEnoughFunding(budget);
    return true;
  }
  roadTool.clear();
  return false;
};


// Build full wire path (not just 1 tile)
AIHelper.prototype._buildWireConnection = function() {
  var path = this.advisor.findWireToConnect();
  if (!path || path.length === 0) return false;

  var budget = this.simulation.budget;
  var wireTool = this.tools.wire;
  var success = false;
  var maxWires = 20; // Cap per action

  for (var i = 0; i < Math.min(path.length, maxWires); i++) {
    if (budget.totalFunds < 505) break; // Keep $500 reserve + $5 for wire

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


AIHelper.prototype._ensureRoadAccess = function(x, y, size) {
  if (this.advisor._hasNearbyRoad(x, y, size)) return;

  var budget = this.simulation.budget;
  if (budget.totalFunds < 520) return; // Reserve check

  var roadTool = this.tools.road;
  var half = Math.floor(size / 2);

  // Build a short road segment along the bottom edge
  for (var rx = x - half; rx <= x + half; rx++) {
    var ry = y + half + 1;
    if (ry < this.map.height && budget.totalFunds >= 510) {
      roadTool.doTool(rx, ry, this.blockMaps);
      roadTool.modifyIfEnoughFunding(budget);
    }
  }
};


AIHelper.prototype._ensurePowerAccess = function(x, y, size) {
  if (this.advisor._hasNearbyPower(x, y, size + 2)) return;

  var budget = this.simulation.budget;
  if (budget.totalFunds < 505) return; // Reserve check

  var wireTool = this.tools.wire;
  var dirs = [[0, -1], [1, 0], [0, 1], [-1, 0]];
  for (var i = 0; i < dirs.length; i++) {
    var wx = x + dirs[i][0] * (Math.floor(size / 2) + 1);
    var wy = y + dirs[i][1] * (Math.floor(size / 2) + 1);
    if (wx >= 0 && wy >= 0 && wx < this.map.width && wy < this.map.height) {
      wireTool.doTool(wx, wy, this.blockMaps);
      if (wireTool.result === wireTool.TOOLRESULT_OK) {
        wireTool.modifyIfEnoughFunding(budget);
        return;
      }
      wireTool.clear();
    }
  }
};


AIHelper.prototype._tryPlacePark = function() {
  var budget = this.simulation.budget;
  if (budget.totalFunds < 1000) return; // Don't waste money on parks when low

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
