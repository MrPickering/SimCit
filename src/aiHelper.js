/* AI Helper for SimCit
 *
 * Integrates the AI Advisor with the game to provide:
 * 1. An advisory panel with recommendations
 * 2. Auto-play mode that automatically builds and manages the city
 */

import $ from 'jquery';

import { AIAdvisor } from './aiAdvisor.js';
import { GameTools } from './gameTools.js';

var ACTION_INTERVAL = 2000; // ms between auto-play actions
var ADVICE_INTERVAL = 5000; // ms between advice refreshes

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

  this._initUI();
  this._startAdviceLoop();
}


AIHelper.prototype._initUI = function() {
  var self = this;

  // Toggle advice panel
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

  // Auto-play toggle
  $('#aiAutoPlay').click(function() {
    self.toggleAutoPlay();
  });

  // Refresh advice
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

  var self = this;
  this._autoPlayTimer = setInterval(function() {
    if (!self.game.isPaused && !self.game.dialogOpen) {
      self._executeNextAction();
    }
  }, ACTION_INTERVAL);
};


AIHelper.prototype.stopAutoPlay = function() {
  this.autoPlayActive = false;
  if (this._autoPlayTimer) {
    clearInterval(this._autoPlayTimer);
    this._autoPlayTimer = null;
  }

  $('#aiAutoPlay').text('Auto-Play').removeClass('ai-active');
  $('#aiStatus').text('Auto-play stopped. ' + this._actionCount + ' actions taken.').removeClass('ai-status-active');
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

  // Update city stats summary
  this._updateStats();
};


AIHelper.prototype._updateStats = function() {
  var census = this.simulation._census;
  var budget = this.simulation.budget;
  var valves = this.simulation._valves;
  var eval_ = this.simulation.evaluation;

  var rBar = this._makeBar(valves.resValve, 2000);
  var cBar = this._makeBar(valves.comValve, 1500);
  var iBar = this._makeBar(valves.indValve, 1500);

  var powerZones = census.poweredZoneCount + census.unpoweredZoneCount;
  var powerPct = powerZones > 0 ? Math.round(census.poweredZoneCount / powerZones * 100) : 100;

  $('#aiStatsContent').html(
    '<div class="ai-stat">Demand: R' + rBar + ' C' + cBar + ' I' + iBar + '</div>' +
    '<div class="ai-stat">Power: ' + powerPct + '% | Crime: ' + (census.crimeAverage || 0) + '</div>' +
    '<div class="ai-stat">Pollution: ' + (census.pollutionAverage || 0) + ' | Score: ' + eval_.cityScore + '</div>' +
    '<div class="ai-stat">Cash: $' + budget.totalFunds + ' | Flow: $' + budget.cashFlow + '</div>'
  );
};


AIHelper.prototype._makeBar = function(value, max) {
  if (value > 100) return '<span class="ai-demand-pos">+</span>';
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

    default:
      break;
  }

  if (success) {
    this._actionCount++;
    this._lastAction = description;
    $('#aiStatus').text('Action #' + this._actionCount + ': ' + description);
  }
};


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

  if (!loc) return false;

  // Try to place the building
  tool.doTool(loc.x, loc.y, this.blockMaps);
  if (tool.result === tool.TOOLRESULT_OK) {
    tool.modifyIfEnoughFunding(budget);
    if (tool.result !== tool.TOOLRESULT_NO_MONEY) {
      // Also build a connecting road if the zone doesn't have one
      this._ensureRoadAccess(loc.x, loc.y, size);
      // Also try to wire up power
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

  // Find a good starting spot near the center of the map
  var cx = this.map.cityCentreX;
  var cy = this.map.cityCentreY;

  // Look for a clear area near center
  var startX = -1, startY = -1;
  for (var r = 0; r < 30; r++) {
    for (var dy = -r; dy <= r; dy++) {
      for (var dx = -r; dx <= r; dx++) {
        if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
        var tx = cx + dx;
        var ty = cy + dy;
        if (this.advisor._isAreaClear(tx - 2, ty - 2, 12)) {
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

  // Build a simple starter layout:
  // Road row at startY
  // Residential above, commercial and industrial below
  var roadTool = this.tools.road;
  var resTool = this.tools.residential;
  var comTool = this.tools.commercial;
  var indTool = this.tools.industrial;

  // Lay a horizontal road
  for (var rx = startX - 2; rx <= startX + 8; rx++) {
    roadTool.doTool(rx, startY, this.blockMaps);
    roadTool.modifyIfEnoughFunding(budget);
  }

  // Place residential above the road
  resTool.doTool(startX + 1, startY - 2, this.blockMaps);
  resTool.modifyIfEnoughFunding(budget);

  resTool.doTool(startX + 5, startY - 2, this.blockMaps);
  resTool.modifyIfEnoughFunding(budget);

  // Place commercial below the road
  comTool.doTool(startX + 1, startY + 3, this.blockMaps);
  comTool.modifyIfEnoughFunding(budget);

  // Place industrial further away
  indTool.doTool(startX + 5, startY + 3, this.blockMaps);
  indTool.modifyIfEnoughFunding(budget);

  // Build a power plant nearby if we can afford it
  if (budget.totalFunds >= 3000) {
    var coalTool = this.tools.coal;
    coalTool.doTool(startX - 3, startY - 3, this.blockMaps);
    coalTool.modifyIfEnoughFunding(budget);

    // Connect power with wires
    var wireTool = this.tools.wire;
    for (var wx = startX - 1; wx <= startX + 6; wx++) {
      wireTool.doTool(wx, startY - 4, this.blockMaps);
      wireTool.modifyIfEnoughFunding(budget);
    }
  }

  return true;
};


AIHelper.prototype._buildRoadConnection = function() {
  var loc = this.advisor.findRoadToConnect();
  if (!loc) return false;

  var budget = this.simulation.budget;
  var roadTool = this.tools.road;

  roadTool.doTool(loc.x, loc.y, this.blockMaps);
  if (roadTool.result === roadTool.TOOLRESULT_OK) {
    roadTool.modifyIfEnoughFunding(budget);
    return true;
  }
  roadTool.clear();
  return false;
};


AIHelper.prototype._buildWireConnection = function() {
  var loc = this.advisor.findWireToConnect();
  if (!loc) return false;

  var budget = this.simulation.budget;
  var wireTool = this.tools.wire;

  wireTool.doTool(loc.x, loc.y, this.blockMaps);
  if (wireTool.result === wireTool.TOOLRESULT_OK) {
    wireTool.modifyIfEnoughFunding(budget);
    return true;
  }
  wireTool.clear();
  return false;
};


AIHelper.prototype._ensureRoadAccess = function(x, y, size) {
  // Build roads adjacent to the placed zone if none exist
  if (this.advisor._hasNearbyRoad(x, y, size)) return;

  var budget = this.simulation.budget;
  var roadTool = this.tools.road;
  var half = Math.floor(size / 2);

  // Build a road along the bottom edge of the zone
  for (var rx = x - half; rx <= x + half; rx++) {
    var ry = y + half + 1;
    if (ry < this.map.height) {
      roadTool.doTool(rx, ry, this.blockMaps);
      roadTool.modifyIfEnoughFunding(budget);
    }
  }
};


AIHelper.prototype._ensurePowerAccess = function(x, y, size) {
  if (this.advisor._hasNearbyPower(x, y, size + 2)) return;

  var budget = this.simulation.budget;
  var wireTool = this.tools.wire;

  // Try to connect by placing a wire adjacent
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
  if (budget.totalFunds < 100) return;

  // Find a spot near populated areas that could benefit from a park
  var map = this.map;
  var blockMaps = this.blockMaps;
  var bestScore = -Infinity;
  var bestX = -1, bestY = -1;

  for (var y = 2; y < map.height - 2; y += 5) {
    for (var x = 2; x < map.width - 2; x += 5) {
      if (map.getTileValue(x, y) !== 0) continue; // DIRT

      // Score by nearby population and lack of existing parks
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
    $('#aiStatus').text('Action #' + this._actionCount + ': Placed park for land value');
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
  if (this._autoPlayTimer) clearInterval(this._autoPlayTimer);
  if (this._adviceTimer) clearInterval(this._adviceTimer);
};


export { AIHelper };
