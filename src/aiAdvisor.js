/* AI Advisor for SimCit
 *
 * Analyzes the current city state and recommends optimal actions.
 * Understands the full scoring formula from evaluation.js, the valve
 * system from valves.js, traffic routing, unemployment, and budget
 * mechanics to make decisions that maximize city score.
 */

import * as TileValues from './tileValues.ts';
import { TileUtils } from './tileUtils.js';

var PRIORITIES = {
  EMERGENCY: 120,     // Going broke, no power
  POWER: 100,
  BUDGET_ADJUST: 95,  // Tax/funding changes (free actions)
  ROAD_CONNECT: 90,
  ZONE_DEMAND: 80,
  WIRE_CONNECT: 75,
  SERVICES: 60,
  SPECIAL_BUILDINGS: 50,
  TRAFFIC: 45,
  BUDGET_INFO: 40,
  PARKS: 20
};

// Minimum funds to keep in reserve (don't spend below this)
var MIN_RESERVE = 500;
// Don't build expensive things unless we have this much headroom
var COMFORTABLE_FUNDS = 2000;

function AIAdvisor(simulation, gameMap, blockMaps) {
  this.simulation = simulation;
  this.map = gameMap;
  this.blockMaps = blockMaps;
}


AIAdvisor.prototype.analyze = function() {
  var recommendations = [];
  var sim = this.simulation;
  var census = sim._census;
  var budget = sim.budget;
  var valves = sim._valves;

  // Budget adjustments are FREE actions - always check first
  var budgetActions = this._analyzeBudgetActions(budget, census);
  recommendations = recommendations.concat(budgetActions);

  // Check if we're in emergency mode (very low funds)
  var isEmergency = budget.totalFunds < MIN_RESERVE && census.totalPop > 0;

  if (isEmergency) {
    recommendations.push({
      priority: PRIORITIES.EMERGENCY,
      message: 'EMERGENCY: Funds at $' + budget.totalFunds + '. Halting construction until revenue recovers.'
    });
    // In emergency, only return budget actions (free) - don't build anything
    recommendations.sort(function(a, b) { return b.priority - a.priority; });
    return recommendations;
  }

  // Power
  recommendations = recommendations.concat(this._analyzePower(census, budget));

  // Zone demand (with unemployment awareness)
  recommendations = recommendations.concat(this._analyzeZoneDemand(census, valves, budget));

  // Infrastructure (roads, traffic)
  recommendations = recommendations.concat(this._analyzeInfrastructure(census, budget));

  // Traffic
  recommendations = recommendations.concat(this._analyzeTraffic(census));

  // Services (police, fire - using effect maps for coverage gaps)
  recommendations = recommendations.concat(this._analyzeServices(census, budget));

  // Budget info (non-actionable advice)
  recommendations = recommendations.concat(this._analyzeBudgetInfo(budget, census));

  // Special buildings (stadium, port, airport)
  recommendations = recommendations.concat(this._analyzeSpecialBuildings(census, budget));

  // Disaster recovery
  recommendations = recommendations.concat(this._analyzeDisasterRecovery());

  recommendations.sort(function(a, b) { return b.priority - a.priority; });
  return recommendations;
};


AIAdvisor.prototype.getAdvice = function() {
  var recs = this.analyze();
  var advice = [];
  var count = Math.min(recs.length, 5);
  for (var i = 0; i < count; i++) {
    advice.push(recs[i].message);
  }
  return advice;
};


AIAdvisor.prototype.decideBestAction = function() {
  var recs = this.analyze();
  if (recs.length === 0) return null;

  for (var i = 0; i < recs.length; i++) {
    if (recs[i].action) return recs[i];
  }
  return null;
};


// ---- Budget actions (FREE - no spending required) ----

AIAdvisor.prototype._analyzeBudgetActions = function(budget, census) {
  var recs = [];

  // Optimal tax rate: 7% is the sweet spot (taxTable gives 0 penalty at index 7)
  // Above 12 triggers complaints; game score directly penalised by cityTax amount
  var optimalTax = 7;
  if (budget.totalFunds < 1000 && census.totalPop > 0) {
    // In financial trouble: raise to 9% temporarily
    optimalTax = 9;
  } else if (budget.totalFunds > 15000) {
    // Flush with cash: lower to 6% to boost growth
    optimalTax = 6;
  }

  if (budget.cityTax !== optimalTax) {
    recs.push({
      priority: PRIORITIES.BUDGET_ADJUST,
      message: 'Adjusting tax rate from ' + budget.cityTax + '% to ' + optimalTax + '%.',
      action: { type: 'set_tax', value: optimalTax }
    });
  }

  // Ensure service funding is at 100% when we can afford it, reduce when we can't
  var totalMaintenance = budget.roadMaintenanceBudget + budget.fireMaintenanceBudget + budget.policeMaintenanceBudget;
  if (totalMaintenance > 0 && budget.totalFunds < totalMaintenance && census.totalPop > 0) {
    // Can't afford full funding - prioritize roads > fire > police
    // Roads deteriorate and hurt score; fire/police just reduce effectiveness
    var targetRoad = Math.min(1.0, budget.totalFunds / budget.roadMaintenanceBudget);
    var remaining = Math.max(0, budget.totalFunds - budget.roadMaintenanceBudget);
    var targetFire = budget.fireMaintenanceBudget > 0 ? Math.min(1.0, remaining / budget.fireMaintenanceBudget) : 1.0;
    remaining = Math.max(0, remaining - budget.fireMaintenanceBudget);
    var targetPolice = budget.policeMaintenanceBudget > 0 ? Math.min(1.0, remaining / budget.policeMaintenanceBudget) : 1.0;

    if (budget.roadPercent !== targetRoad || budget.firePercent !== targetFire || budget.policePercent !== targetPolice) {
      recs.push({
        priority: PRIORITIES.BUDGET_ADJUST - 1,
        message: 'Adjusting service funding to match available revenue.',
        action: { type: 'set_funding', road: targetRoad, fire: targetFire, police: targetPolice }
      });
    }
  } else if (budget.roadPercent < 1 || budget.firePercent < 1 || budget.policePercent < 1) {
    // We can afford full funding but it's not set
    if (budget.totalFunds > totalMaintenance * 2) {
      recs.push({
        priority: PRIORITIES.BUDGET_ADJUST - 1,
        message: 'Restoring service funding to 100%.',
        action: { type: 'set_funding', road: 1, fire: 1, police: 1 }
      });
    }
  }

  return recs;
};


// ---- Power analysis ----

AIAdvisor.prototype._analyzePower = function(census, budget) {
  var recs = [];
  var totalZones = census.poweredZoneCount + census.unpoweredZoneCount;
  var powerPop = census.coalPowerPop + census.nuclearPowerPop;

  if (totalZones > 0 && powerPop === 0) {
    if (budget.totalFunds >= 3000 + MIN_RESERVE) {
      recs.push({
        priority: PRIORITIES.POWER + 10,
        message: 'CRITICAL: No power plants! Building coal power plant ($3000).',
        action: { type: 'build', tool: 'coal' }
      });
    } else {
      recs.push({
        priority: PRIORITIES.POWER + 10,
        message: 'CRITICAL: No power! Saving for a coal plant ($3000). Have: $' + budget.totalFunds
      });
    }
  } else if (totalZones > 0 && census.unpoweredZoneCount > totalZones * 0.3) {
    // Score penalty: score *= (poweredZones / totalZones) - this is huge
    if (budget.totalFunds >= 5000 + COMFORTABLE_FUNDS) {
      recs.push({
        priority: PRIORITIES.POWER + 5,
        message: 'Many zones unpowered (score penalty!). Building nuclear plant.',
        action: { type: 'build', tool: 'nuclear' }
      });
    } else if (budget.totalFunds >= 3000 + MIN_RESERVE) {
      recs.push({
        priority: PRIORITIES.POWER + 5,
        message: 'Many zones unpowered (score penalty!). Building coal plant.',
        action: { type: 'build', tool: 'coal' }
      });
    } else {
      recs.push({
        priority: PRIORITIES.POWER,
        message: 'Zones need power but funds too low. Saving for coal plant ($3000).'
      });
    }
  } else if (totalZones > 0 && census.unpoweredZoneCount > 0) {
    recs.push({
      priority: PRIORITIES.WIRE_CONNECT,
      message: census.unpoweredZoneCount + ' zones need power lines ($5 each).',
      action: { type: 'wire_connect' }
    });
  }

  return recs;
};


// ---- Zone demand (with unemployment awareness) ----

AIAdvisor.prototype._analyzeZoneDemand = function(census, valves, budget) {
  var recs = [];
  var totalZonePop = census.resZonePop + census.comZonePop + census.indZonePop;

  // Early game: build starter city
  if (totalZonePop === 0 && budget.totalFunds >= 1000) {
    recs.push({
      priority: PRIORITIES.ZONE_DEMAND + 15,
      message: 'Start your city! Placing residential, commercial, industrial with roads and power.',
      action: { type: 'build_starter' }
    });
    return recs;
  }

  // Calculate unemployment: key factor the evaluation uses
  // unemployment = (resPop / ((comPop + indPop) * 8)) - 1, clamped 0-255
  var jobBase = (census.comPop + census.indPop) * 8;
  var unemployment = 0;
  if (jobBase > 0) {
    unemployment = Math.round((census.resPop / jobBase - 1) * 255);
    unemployment = Math.max(0, Math.min(unemployment, 255));
  }

  // Don't build if we can't afford it plus maintain reserves
  var canAffordZone = budget.totalFunds >= 100 + MIN_RESERVE;

  if (!canAffordZone) {
    if (valves.resValve > 500 || valves.comValve > 500 || valves.indValve > 500) {
      recs.push({
        priority: PRIORITIES.ZONE_DEMAND - 5,
        message: 'Demand exists but funds too low ($' + budget.totalFunds + '). Waiting for tax revenue.'
      });
    }
    return recs;
  }

  // If unemployment is high, prioritize jobs (commercial/industrial) over residential
  if (unemployment > 100 && (valves.comValve > 0 || valves.indValve > 0)) {
    recs.push({
      priority: PRIORITIES.ZONE_DEMAND + 12,
      message: 'High unemployment (' + unemployment + '). Prioritizing job-creating zones.',
      action: { type: 'build', tool: valves.comValve >= valves.indValve ? 'commercial' : 'industrial' }
    });
    return recs;
  }

  // Follow RCI demand valves - they encode the simulation's own growth model
  if (valves.resValve > 100) {
    var urgency = Math.min(valves.resValve / 2000 * 20, 20);
    recs.push({
      priority: PRIORITIES.ZONE_DEMAND + urgency,
      message: 'Residential demand: ' + Math.round(valves.resValve / 20) + '%',
      action: { type: 'build', tool: 'residential' }
    });
  }

  if (valves.comValve > 100) {
    var urgency = Math.min(valves.comValve / 1500 * 15, 15);
    recs.push({
      priority: PRIORITIES.ZONE_DEMAND + urgency,
      message: 'Commercial demand: ' + Math.round(valves.comValve / 15) + '%',
      action: { type: 'build', tool: 'commercial' }
    });
  }

  if (valves.indValve > 100) {
    var urgency = Math.min(valves.indValve / 1500 * 15, 15);
    recs.push({
      priority: PRIORITIES.ZONE_DEMAND + urgency,
      message: 'Industrial demand: ' + Math.round(valves.indValve / 15) + '%',
      action: { type: 'build', tool: 'industrial' }
    });
  }

  // Oversupply warnings - score penalty at -1000 (0.85x per type)
  if (valves.resValve < -1000) {
    recs.push({ priority: PRIORITIES.BUDGET_INFO - 5,
      message: 'Residential oversupply (score -15%). Need more jobs.' });
  }
  if (valves.comValve < -1000) {
    recs.push({ priority: PRIORITIES.BUDGET_INFO - 5,
      message: 'Commercial oversupply (score -15%). Need more residents.' });
  }
  if (valves.indValve < -1000) {
    recs.push({ priority: PRIORITIES.BUDGET_INFO - 5,
      message: 'Industrial oversupply (score -15%). Need more residents.' });
  }

  return recs;
};


// ---- Infrastructure ----

AIAdvisor.prototype._analyzeInfrastructure = function(census, budget) {
  var recs = [];
  var totalZonePop = census.resZonePop + census.comZonePop + census.indZonePop;

  // Game sends NEED_MORE_ROADS when totalZonePop > 10 && totalZonePop * 2 > roadTotal
  if (totalZonePop > 10 && totalZonePop * 2 > census.roadTotal && budget.totalFunds >= 10 + MIN_RESERVE) {
    recs.push({
      priority: PRIORITIES.ROAD_CONNECT,
      message: 'Need roads to connect zones (have ' + census.roadTotal + ', need ~' + (totalZonePop * 2) + ').',
      action: { type: 'build_roads' }
    });
  }

  // Road deterioration: score -= MAX_ROAD_EFFECT - roadEffect
  if (budget.roadEffect < Math.floor(5 * budget.MAX_ROAD_EFFECT / 8) && census.roadTotal > 30) {
    recs.push({
      priority: PRIORITIES.BUDGET_ADJUST,
      message: 'Roads deteriorating (score penalty). Funding: ' + Math.round(budget.roadPercent * 100) + '%.',
      action: { type: 'set_funding', road: 1, fire: budget.firePercent, police: budget.policePercent }
    });
  }

  return recs;
};


// ---- Traffic analysis (NEW) ----

AIAdvisor.prototype._analyzeTraffic = function(census) {
  var recs = [];

  // Game warns at trafficAverage > 60
  var trafficAvg = census.trafficAverage || 0;
  if (trafficAvg > 60) {
    recs.push({
      priority: PRIORITIES.TRAFFIC + 5,
      message: 'Traffic congestion (avg ' + Math.round(trafficAvg) + '). Build parallel roads to ease bottlenecks.',
      action: { type: 'build_roads' }
    });
  }

  return recs;
};


// ---- Services (with effect map awareness) ----

AIAdvisor.prototype._analyzeServices = function(census, budget) {
  var recs = [];
  var totalPop = census.totalPop;
  var canAfford = budget.totalFunds >= 500 + COMFORTABLE_FUNDS;

  // Game sends NEED_POLICE_STATION at totalPop > 60 && policeStationPop === 0
  if (totalPop > 60 && census.policeStationPop === 0 && canAfford) {
    recs.push({
      priority: PRIORITIES.SERVICES + 10,
      message: 'No police! Crime rising. Building station ($500).',
      action: { type: 'build', tool: 'police' }
    });
  }

  // Game sends NEED_FIRE_STATION at totalPop > 60 && fireStationPop === 0
  if (totalPop > 60 && census.fireStationPop === 0 && canAfford) {
    recs.push({
      priority: PRIORITIES.SERVICES + 10,
      message: 'No fire dept! Fires will spread. Building station ($500).',
      action: { type: 'build', tool: 'fire' }
    });
  }

  // Crime > 100 triggers game warning - add more police using coverage gap detection
  if (census.crimeAverage > 100 && canAfford) {
    recs.push({
      priority: PRIORITIES.SERVICES + 5,
      message: 'Crime high (avg ' + census.crimeAverage + '). Building police station in worst area.',
      action: { type: 'build', tool: 'police' }
    });
  }

  // Active fires
  if (census.firePop > 0 && census.fireStationPop === 0 && canAfford) {
    recs.push({
      priority: PRIORITIES.SERVICES + 8,
      message: census.firePop + ' active fires! Need fire stations.',
      action: { type: 'build', tool: 'fire' }
    });
  }

  return recs;
};


// ---- Budget info (non-actionable) ----

AIAdvisor.prototype._analyzeBudgetInfo = function(budget, census) {
  var recs = [];

  if (budget.totalFunds < MIN_RESERVE && census.totalPop > 0) {
    recs.push({
      priority: PRIORITIES.EMERGENCY,
      message: 'Funds critical ($' + budget.totalFunds + '). No construction until revenue rebuilds.'
    });
  } else if (budget.totalFunds < COMFORTABLE_FUNDS && census.totalPop > 0) {
    recs.push({
      priority: PRIORITIES.BUDGET_INFO + 5,
      message: 'Low funds ($' + budget.totalFunds + '). Building only essential infrastructure.'
    });
  }

  if (budget.cashFlow < -100 && census.totalPop > 50) {
    recs.push({
      priority: PRIORITIES.BUDGET_INFO,
      message: 'Negative cash flow ($' + budget.cashFlow + '/yr). Maintenance exceeds tax revenue.'
    });
  }

  return recs;
};


// ---- Special buildings ----

AIAdvisor.prototype._analyzeSpecialBuildings = function(census, budget) {
  var recs = [];

  // These thresholds match exactly what simulation.js uses to set resCap/comCap/indCap
  // When capped, score gets 0.85x penalty per capped type
  if (census.resPop > 500 && census.stadiumPop === 0 && budget.totalFunds >= 5000 + COMFORTABLE_FUNDS) {
    recs.push({
      priority: PRIORITIES.SPECIAL_BUILDINGS + 5,
      message: 'Need stadium (res growth capped, -15% score). Building ($5000).',
      action: { type: 'build', tool: 'stadium' }
    });
  }

  if (census.indPop > 70 && census.seaportPop === 0 && budget.totalFunds >= 3000 + COMFORTABLE_FUNDS) {
    recs.push({
      priority: PRIORITIES.SPECIAL_BUILDINGS + 5,
      message: 'Need seaport (ind growth capped, -15% score). Building ($3000).',
      action: { type: 'build', tool: 'port' }
    });
  }

  if (census.comPop > 100 && census.airportPop === 0 && budget.totalFunds >= 10000 + COMFORTABLE_FUNDS) {
    recs.push({
      priority: PRIORITIES.SPECIAL_BUILDINGS,
      message: 'Need airport (com growth capped, -15% score). Building ($10000).',
      action: { type: 'build', tool: 'airport' }
    });
  }

  return recs;
};


// ---- Disaster recovery (NEW) ----

AIAdvisor.prototype._analyzeDisasterRecovery = function() {
  var recs = [];
  var map = this.map;
  var width = map.width;
  var height = map.height;

  // Scan for fire/rubble/flood and count damaged tiles
  var fireCount = 0;
  var rubbleCount = 0;

  // Sample every 4th tile for performance
  for (var y = 0; y < height; y += 4) {
    for (var x = 0; x < width; x += 4) {
      var tv = map.getTileValue(x, y);
      if (tv >= TileValues.FIRE && tv <= TileValues.LASTFIRE) fireCount++;
      if (tv >= TileValues.RUBBLE && tv <= TileValues.LASTRUBBLE) rubbleCount++;
    }
  }

  if (fireCount > 3) {
    recs.push({
      priority: PRIORITIES.EMERGENCY - 5,
      message: 'Fires burning! ' + (fireCount * 16) + '+ tiles affected. Fire stations needed.',
      action: { type: 'build', tool: 'fire' }
    });
  }

  if (rubbleCount > 5) {
    recs.push({
      priority: PRIORITIES.TRAFFIC,
      message: 'Disaster rubble detected (' + (rubbleCount * 16) + '+ tiles). Rebuilding needed.',
      action: { type: 'bulldoze_rubble' }
    });
  }

  return recs;
};


// ---- Location finding functions ----

// Find best location for a 3x3 zone
AIAdvisor.prototype.findBestZoneLocation = function(toolName) {
  var map = this.map;
  var blockMaps = this.blockMaps;
  var bestScore = -Infinity;
  var bestX = -1, bestY = -1;
  var width = map.width;
  var height = map.height;

  for (var y = 2; y < height - 2; y += 2) {
    for (var x = 2; x < width - 2; x += 2) {
      if (!this._isAreaClear(x - 1, y - 1, 3)) continue;

      var score = this._scoreZoneLocation(x, y, toolName);
      if (score > bestScore) {
        bestScore = score;
        bestX = x;
        bestY = y;
      }
    }
  }

  if (bestX === -1) return null;
  return { x: bestX, y: bestY, score: bestScore };
};


// Find best location for a 4x4 building
AIAdvisor.prototype.findBestLargeLocation = function(toolName) {
  var map = this.map;
  var bestScore = -Infinity;
  var bestX = -1, bestY = -1;
  var width = map.width;
  var height = map.height;

  for (var y = 2; y < height - 3; y += 3) {
    for (var x = 2; x < width - 3; x += 3) {
      if (!this._isAreaClear(x - 1, y - 1, 4)) continue;

      var score = this._scoreLargeLocation(x, y, toolName);
      if (score > bestScore) {
        bestScore = score;
        bestX = x;
        bestY = y;
      }
    }
  }

  if (bestX === -1) return null;
  return { x: bestX, y: bestY, score: bestScore };
};


// Find best location for a 6x6 building (airport)
AIAdvisor.prototype.findBestAirportLocation = function() {
  var map = this.map;
  var bestScore = -Infinity;
  var bestX = -1, bestY = -1;
  var width = map.width;
  var height = map.height;

  for (var y = 4; y < height - 4; y += 4) {
    for (var x = 4; x < width - 4; x += 4) {
      if (!this._isAreaClear(x - 1, y - 1, 6)) continue;

      var score = this._scoreLargeLocation(x, y, 'airport');
      if (score > bestScore) {
        bestScore = score;
        bestX = x;
        bestY = y;
      }
    }
  }

  if (bestX === -1) return null;
  return { x: bestX, y: bestY, score: bestScore };
};


// Build a full road path between two points, returning an array of positions
AIAdvisor.prototype.findRoadPath = function(fromX, fromY, toX, toY) {
  var path = [];
  var cx = fromX;
  var cy = fromY;
  var map = this.map;
  var maxSteps = Math.abs(toX - fromX) + Math.abs(toY - fromY) + 5;

  for (var step = 0; step < maxSteps; step++) {
    if (cx === toX && cy === toY) break;

    var dx = toX - cx;
    var dy = toY - cy;
    var nx, ny;

    // Prefer the longer axis
    if (Math.abs(dx) >= Math.abs(dy)) {
      nx = cx + (dx > 0 ? 1 : -1);
      ny = cy;
    } else {
      nx = cx;
      ny = cy + (dy > 0 ? 1 : -1);
    }

    // Check if the target tile is buildable
    if (nx >= 0 && ny >= 0 && nx < map.width && ny < map.height) {
      var tv = map.getTileValue(nx, ny);
      if (tv === TileValues.DIRT || TileUtils.canBulldoze(tv) || TileUtils.isRoad(tv)) {
        if (!TileUtils.isRoad(tv)) {
          path.push({ x: nx, y: ny });
        }
        cx = nx;
        cy = ny;
        continue;
      }
    }

    // Obstacle - try the other axis
    if (Math.abs(dx) >= Math.abs(dy)) {
      nx = cx;
      ny = cy + (dy !== 0 ? (dy > 0 ? 1 : -1) : 1);
    } else {
      nx = cx + (dx !== 0 ? (dx > 0 ? 1 : -1) : 1);
      ny = cy;
    }

    if (nx >= 0 && ny >= 0 && nx < map.width && ny < map.height) {
      var tv = map.getTileValue(nx, ny);
      if (tv === TileValues.DIRT || TileUtils.canBulldoze(tv) || TileUtils.isRoad(tv)) {
        if (!TileUtils.isRoad(tv)) {
          path.push({ x: nx, y: ny });
        }
        cx = nx;
        cy = ny;
        continue;
      }
    }

    break; // Stuck
  }

  return path;
};


// Find zones needing roads and return the full path to connect them
AIAdvisor.prototype.findRoadToConnect = function() {
  var map = this.map;
  var width = map.width;
  var height = map.height;

  for (var y = 1; y < height - 1; y++) {
    for (var x = 1; x < width - 1; x++) {
      var tile = map.getTile(x, y);
      if (!tile.isZone()) continue;
      if (this._hasAdjacentRoad(x, y)) continue;

      var roadTarget = this._findNearestRoad(x, y);
      if (roadTarget) {
        // Return the full path
        var path = this.findRoadPath(x, y, roadTarget.x, roadTarget.y);
        if (path.length > 0) return path;
      }

      // No existing road found - build one adjacent to the zone
      var dirs = [[0, -2], [2, 0], [0, 2], [-2, 0]];
      for (var d = 0; d < dirs.length; d++) {
        var rx = x + dirs[d][0];
        var ry = y + dirs[d][1];
        if (rx >= 0 && ry >= 0 && rx < width && ry < height) {
          var tv = map.getTileValue(rx, ry);
          if (tv === TileValues.DIRT || TileUtils.canBulldoze(tv)) {
            return [{ x: rx, y: ry }];
          }
        }
      }
    }
  }

  return null;
};


// Find wire path to connect unpowered zones
AIAdvisor.prototype.findWireToConnect = function() {
  var map = this.map;
  var width = map.width;
  var height = map.height;

  for (var y = 1; y < height - 1; y++) {
    for (var x = 1; x < width - 1; x++) {
      var tile = map.getTile(x, y);
      if (!tile.isZone()) continue;
      if (tile.isPowered()) continue;

      var powerSource = this._findNearestPowered(x, y);
      if (powerSource) {
        var path = this.findRoadPath(x, y, powerSource.x, powerSource.y);
        if (path.length > 0) return path;
      }
    }
  }

  return null;
};


// Find rubble tiles to bulldoze (disaster recovery)
AIAdvisor.prototype.findRubbleToClear = function() {
  var map = this.map;
  for (var y = 0; y < map.height; y += 2) {
    for (var x = 0; x < map.width; x += 2) {
      var tv = map.getTileValue(x, y);
      if (tv >= TileValues.RUBBLE && tv <= TileValues.LASTRUBBLE) {
        return { x: x, y: y };
      }
    }
  }
  return null;
};


// Find areas with high traffic density for road expansion
AIAdvisor.prototype.findTrafficBottleneck = function() {
  var blockMaps = this.blockMaps;
  var map = this.map;
  var bestTraffic = 0;
  var bestX = -1, bestY = -1;

  var tdMap = blockMaps.trafficDensityMap;
  for (var x = 0; x < tdMap.gameMapWidth; x += tdMap.blockSize * 2) {
    for (var y = 0; y < tdMap.gameMapHeight; y += tdMap.blockSize * 2) {
      var traffic = tdMap.worldGet(x, y);
      if (traffic > bestTraffic) {
        // Check if we can build a parallel road nearby
        for (var dy = -2; dy <= 2; dy++) {
          for (var dx = -2; dx <= 2; dx++) {
            var nx = x + dx;
            var ny = y + dy;
            if (nx >= 0 && ny >= 0 && nx < map.width && ny < map.height) {
              if (map.getTileValue(nx, ny) === TileValues.DIRT) {
                bestTraffic = traffic;
                bestX = nx;
                bestY = ny;
              }
            }
          }
        }
      }
    }
  }

  if (bestX === -1) return null;
  return { x: bestX, y: bestY };
};


// ---- Scoring functions ----

AIAdvisor.prototype._scoreZoneLocation = function(x, y, toolName) {
  var score = 0;
  var blockMaps = this.blockMaps;

  // Road adjacency is critical - zones without road access won't grow
  // (residential.js findPerimeterRoad checks 12 perimeter tiles for driveable)
  if (this._hasNearbyRoad(x, y, 2)) score += 150;
  else if (this._hasNearbyRoad(x, y, 4)) score += 60;
  else if (this._hasNearbyRoad(x, y, 8)) score += 10;
  else return -1000; // Don't place zones with no road access at all

  // Power connectivity
  if (this._hasNearbyPower(x, y, 4)) score += 50;
  else if (this._hasNearbyPower(x, y, 8)) score += 20;

  // Block map values
  var landValue = this._safeBlockGet(blockMaps.landValueMap, x, y);
  var pollution = this._safeBlockGet(blockMaps.pollutionDensityMap, x, y);
  var crime = this._safeBlockGet(blockMaps.crimeRateMap, x, y);
  var traffic = this._safeBlockGet(blockMaps.trafficDensityMap, x, y);
  var popDensity = this._safeBlockGet(blockMaps.populationDensityMap, x, y);

  switch (toolName) {
    case 'residential':
      // residential.js: pollution > 128 causes zone to DEGRADE. Critical threshold.
      if (pollution > 128) return -500;
      score += landValue * 2;
      score -= pollution * 3;
      score -= crime * 2;
      score -= traffic; // High traffic is bad for residential
      // Keep away from industrial (pollution source)
      if (this._hasNearbyIndustrial(x, y, 4)) score -= 40;
      // But needs to be within traffic routing distance (MAX_TRAFFIC_DISTANCE = 30)
      // of commercial/industrial for employment
      if (this._hasNearbyCommercial(x, y, 15) || this._hasNearbyIndustrial(x, y, 15)) score += 25;
      break;

    case 'commercial':
      score += landValue * 3;
      score -= pollution * 2;
      // Commercial needs residential nearby (labor supply)
      if (this._hasNearbyResidential(x, y, 10)) score += 40;
      else score -= 30;
      // Moderate traffic is OK for commercial
      break;

    case 'industrial':
      // Industrial doesn't care about pollution; prefers low land value
      score -= landValue;
      score += 20;
      // Keep away from residential
      if (!this._hasNearbyResidential(x, y, 5)) score += 30;
      // But needs to be reachable from residential
      if (this._hasNearbyResidential(x, y, 20)) score += 15;
      break;

    case 'police':
      // Use policeStationEffectMap to find coverage gaps
      var policeEffect = this._safeBlockGet(blockMaps.policeStationEffectMap, x, y);
      score += (1000 - policeEffect); // High score where coverage is LOW
      score += crime * 2;
      score += popDensity;
      if (this._hasNearbyBuilding(x, y, TileValues.POLICESTATION, 15)) score -= 300;
      break;

    case 'fire':
      // Use fireStationEffectMap to find coverage gaps
      var fireEffect = this._safeBlockGet(blockMaps.fireStationEffectMap, x, y);
      score += (1000 - fireEffect); // High score where coverage is LOW
      score += popDensity * 2;
      if (this._hasNearbyBuilding(x, y, TileValues.FIRESTATION, 15)) score -= 300;
      break;
  }

  // Prefer closer to city center to reduce sprawl and road costs
  var dx = x - this.map.cityCentreX;
  var dy = y - this.map.cityCentreY;
  var dist = Math.sqrt(dx * dx + dy * dy);
  score -= dist * 0.3;

  return score;
};


AIAdvisor.prototype._scoreLargeLocation = function(x, y, toolName) {
  var score = 0;
  var blockMaps = this.blockMaps;

  if (this._hasNearbyRoad(x, y, 4)) score += 80;
  else if (this._hasNearbyRoad(x, y, 8)) score += 20;
  else score -= 150;

  if (this._hasNearbyPower(x, y, 6)) score += 40;

  var landValue = this._safeBlockGet(blockMaps.landValueMap, x, y);

  switch (toolName) {
    case 'coal':
    case 'nuclear':
      if (!this._hasNearbyResidential(x, y, 8)) score += 50;
      score -= landValue;
      break;

    case 'stadium':
      var popDensity = this._safeBlockGet(blockMaps.populationDensityMap, x, y);
      score += popDensity * 2;
      score += landValue;
      break;

    case 'port':
      if (this._hasNearbyWater(x, y, 3)) score += 150;
      else score -= 500;
      break;

    case 'airport':
      score -= landValue;
      // Airports need open space
      break;
  }

  return score;
};


// ---- Map scanning utilities ----

AIAdvisor.prototype._isAreaClear = function(startX, startY, size) {
  var map = this.map;
  if (startX < 0 || startY < 0 || startX + size > map.width || startY + size > map.height)
    return false;

  for (var dy = 0; dy < size; dy++) {
    for (var dx = 0; dx < size; dx++) {
      var tileValue = map.getTileValue(startX + dx, startY + dy);
      if (tileValue !== TileValues.DIRT && !TileUtils.canBulldoze(tileValue))
        return false;
    }
  }
  return true;
};


AIAdvisor.prototype._hasAdjacentRoad = function(x, y) {
  var map = this.map;
  var checks = [[-1,0],[1,0],[0,-1],[0,1],[-2,0],[2,0],[0,-2],[0,2]];
  for (var i = 0; i < checks.length; i++) {
    var nx = x + checks[i][0];
    var ny = y + checks[i][1];
    if (nx >= 0 && ny >= 0 && nx < map.width && ny < map.height) {
      if (TileUtils.isRoad(map.getTileValue(nx, ny))) return true;
    }
  }
  return false;
};


AIAdvisor.prototype._hasNearbyRoad = function(x, y, radius) {
  var map = this.map;
  for (var dy = -radius; dy <= radius; dy++) {
    for (var dx = -radius; dx <= radius; dx++) {
      var nx = x + dx;
      var ny = y + dy;
      if (nx >= 0 && ny >= 0 && nx < map.width && ny < map.height) {
        if (TileUtils.isRoad(map.getTileValue(nx, ny))) return true;
      }
    }
  }
  return false;
};


AIAdvisor.prototype._hasNearbyPower = function(x, y, radius) {
  var map = this.map;
  for (var dy = -radius; dy <= radius; dy++) {
    for (var dx = -radius; dx <= radius; dx++) {
      var nx = x + dx;
      var ny = y + dy;
      if (nx >= 0 && ny >= 0 && nx < map.width && ny < map.height) {
        var tile = map.getTile(nx, ny);
        if (tile.isPowered() || tile.isConductive()) return true;
      }
    }
  }
  return false;
};


AIAdvisor.prototype._hasNearbyIndustrial = function(x, y, radius) {
  var map = this.map;
  for (var dy = -radius; dy <= radius; dy++) {
    for (var dx = -radius; dx <= radius; dx++) {
      var nx = x + dx;
      var ny = y + dy;
      if (nx >= 0 && ny >= 0 && nx < map.width && ny < map.height) {
        if (TileUtils.isIndustrial(map.getTileValue(nx, ny))) return true;
      }
    }
  }
  return false;
};


AIAdvisor.prototype._hasNearbyResidential = function(x, y, radius) {
  var map = this.map;
  for (var dy = -radius; dy <= radius; dy++) {
    for (var dx = -radius; dx <= radius; dx++) {
      var nx = x + dx;
      var ny = y + dy;
      if (nx >= 0 && ny >= 0 && nx < map.width && ny < map.height) {
        if (TileUtils.isResidential(map.getTileValue(nx, ny))) return true;
      }
    }
  }
  return false;
};


AIAdvisor.prototype._hasNearbyCommercial = function(x, y, radius) {
  var map = this.map;
  for (var dy = -radius; dy <= radius; dy++) {
    for (var dx = -radius; dx <= radius; dx++) {
      var nx = x + dx;
      var ny = y + dy;
      if (nx >= 0 && ny >= 0 && nx < map.width && ny < map.height) {
        if (TileUtils.isCommercial(map.getTileValue(nx, ny))) return true;
      }
    }
  }
  return false;
};


AIAdvisor.prototype._hasNearbyWater = function(x, y, radius) {
  var map = this.map;
  for (var dy = -radius; dy <= radius; dy++) {
    for (var dx = -radius; dx <= radius; dx++) {
      var nx = x + dx;
      var ny = y + dy;
      if (nx >= 0 && ny >= 0 && nx < map.width && ny < map.height) {
        var tv = map.getTileValue(nx, ny);
        if (tv >= TileValues.WATER_LOW && tv <= TileValues.WATER_HIGH) return true;
      }
    }
  }
  return false;
};


AIAdvisor.prototype._hasNearbyBuilding = function(x, y, centerTile, radius) {
  var map = this.map;
  for (var dy = -radius; dy <= radius; dy++) {
    for (var dx = -radius; dx <= radius; dx++) {
      var nx = x + dx;
      var ny = y + dy;
      if (nx >= 0 && ny >= 0 && nx < map.width && ny < map.height) {
        if (map.getTileValue(nx, ny) === centerTile) return true;
      }
    }
  }
  return false;
};


AIAdvisor.prototype._findNearestRoad = function(x, y) {
  var map = this.map;
  for (var radius = 1; radius < 25; radius++) {
    for (var dy = -radius; dy <= radius; dy++) {
      for (var dx = -radius; dx <= radius; dx++) {
        if (Math.abs(dx) !== radius && Math.abs(dy) !== radius) continue;
        var nx = x + dx;
        var ny = y + dy;
        if (nx >= 0 && ny >= 0 && nx < map.width && ny < map.height) {
          if (TileUtils.isRoad(map.getTileValue(nx, ny)))
            return { x: nx, y: ny };
        }
      }
    }
  }
  return null;
};


AIAdvisor.prototype._findNearestPowered = function(x, y) {
  var map = this.map;
  for (var radius = 1; radius < 30; radius++) {
    for (var dy = -radius; dy <= radius; dy++) {
      for (var dx = -radius; dx <= radius; dx++) {
        if (Math.abs(dx) !== radius && Math.abs(dy) !== radius) continue;
        var nx = x + dx;
        var ny = y + dy;
        if (nx >= 0 && ny >= 0 && nx < map.width && ny < map.height) {
          var tile = map.getTile(nx, ny);
          if (tile.isPowered()) return { x: nx, y: ny };
        }
      }
    }
  }
  return null;
};


AIAdvisor.prototype._safeBlockGet = function(blockMap, x, y) {
  try {
    return blockMap.worldGet(x, y) || 0;
  } catch (e) {
    return 0;
  }
};


export { AIAdvisor };
