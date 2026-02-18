/* AI Advisor for SimCit
 *
 * Analyzes the current city state and recommends optimal actions.
 * Can be used for both advisory tips and auto-play decision making.
 */

import * as TileValues from './tileValues.ts';
import { TileUtils } from './tileUtils.js';
import { Evaluation } from './evaluation.js';

var PRIORITIES = {
  POWER: 100,
  ROAD_CONNECT: 90,
  ZONE_DEMAND: 80,
  WIRE_CONNECT: 75,
  SERVICES: 60,
  SPECIAL_BUILDINGS: 50,
  BUDGET: 40,
  PARKS: 20
};

function AIAdvisor(simulation, gameMap, blockMaps) {
  this.simulation = simulation;
  this.map = gameMap;
  this.blockMaps = blockMaps;
}


// Analyze the full city state and return a prioritized list of recommendations
AIAdvisor.prototype.analyze = function() {
  var recommendations = [];
  var sim = this.simulation;
  var census = sim._census;
  var budget = sim.budget;
  var valves = sim._valves;
  var eval_ = sim.evaluation;

  // 1. Check power situation
  var powerRecs = this._analyzePower(census, budget);
  recommendations = recommendations.concat(powerRecs);

  // 2. Check zone demand
  var zoneRecs = this._analyzeZoneDemand(census, valves, budget);
  recommendations = recommendations.concat(zoneRecs);

  // 3. Check infrastructure
  var infraRecs = this._analyzeInfrastructure(census, budget);
  recommendations = recommendations.concat(infraRecs);

  // 4. Check services
  var serviceRecs = this._analyzeServices(census, budget);
  recommendations = recommendations.concat(serviceRecs);

  // 5. Check budget
  var budgetRecs = this._analyzeBudget(budget, census);
  recommendations = recommendations.concat(budgetRecs);

  // 6. Check special buildings
  var specialRecs = this._analyzeSpecialBuildings(census);
  recommendations = recommendations.concat(specialRecs);

  // Sort by priority (highest first)
  recommendations.sort(function(a, b) { return b.priority - a.priority; });

  return recommendations;
};


// Get a human-readable summary of the top recommendations
AIAdvisor.prototype.getAdvice = function() {
  var recs = this.analyze();
  var advice = [];
  var count = Math.min(recs.length, 5);
  for (var i = 0; i < count; i++) {
    advice.push(recs[i].message);
  }
  return advice;
};


// Decide the single best action to take right now (for auto-play)
AIAdvisor.prototype.decideBestAction = function() {
  var recs = this.analyze();
  if (recs.length === 0) return null;

  // Find the first actionable recommendation
  for (var i = 0; i < recs.length; i++) {
    if (recs[i].action) {
      return recs[i];
    }
  }
  return null;
};


// ---- Analysis functions ----

AIAdvisor.prototype._analyzePower = function(census, budget) {
  var recs = [];
  var totalZones = census.poweredZoneCount + census.unpoweredZoneCount;
  var powerPop = census.coalPowerPop + census.nuclearPowerPop;

  if (totalZones > 0 && powerPop === 0) {
    recs.push({
      priority: PRIORITIES.POWER + 10,
      message: 'CRITICAL: No power plants! Build a coal power plant ($3000).',
      action: { type: 'build', tool: 'coal' }
    });
  } else if (totalZones > 0 && census.unpoweredZoneCount > totalZones * 0.3) {
    // More than 30% unpowered
    if (budget.totalFunds >= 5000) {
      recs.push({
        priority: PRIORITIES.POWER + 5,
        message: 'Many zones lack power. Build a nuclear plant ($5000, 2000 units) or coal plant ($3000, 700 units).',
        action: { type: 'build', tool: budget.totalFunds >= 5000 ? 'nuclear' : 'coal' }
      });
    } else if (budget.totalFunds >= 3000) {
      recs.push({
        priority: PRIORITIES.POWER + 5,
        message: 'Many zones lack power. Build a coal power plant ($3000).',
        action: { type: 'build', tool: 'coal' }
      });
    } else {
      recs.push({
        priority: PRIORITIES.POWER,
        message: 'Zones need power but funds are low. Save for a coal plant ($3000).'
      });
    }
  } else if (totalZones > 0 && census.unpoweredZoneCount > 0) {
    recs.push({
      priority: PRIORITIES.WIRE_CONNECT,
      message: 'Some zones need power lines. Connect them with wire ($5 each).',
      action: { type: 'wire_connect' }
    });
  }

  return recs;
};


AIAdvisor.prototype._analyzeZoneDemand = function(census, valves, budget) {
  var recs = [];
  var totalZonePop = census.resZonePop + census.comZonePop + census.indZonePop;

  // Early game: need at least some of everything
  if (totalZonePop === 0 && budget.totalFunds >= 300) {
    recs.push({
      priority: PRIORITIES.ZONE_DEMAND + 15,
      message: 'Start your city! Place residential, commercial, and industrial zones connected by roads.',
      action: { type: 'build_starter' }
    });
    return recs;
  }

  // Check RCI demand valves
  if (valves.resValve > 100 && budget.totalFunds >= 100) {
    var urgency = Math.min(valves.resValve / 2000 * 20, 20);
    recs.push({
      priority: PRIORITIES.ZONE_DEMAND + urgency,
      message: 'Residential demand is high (' + Math.round(valves.resValve / 20) + '%). Build more residential zones.',
      action: { type: 'build', tool: 'residential' }
    });
  }

  if (valves.comValve > 100 && budget.totalFunds >= 100) {
    var urgency = Math.min(valves.comValve / 1500 * 15, 15);
    recs.push({
      priority: PRIORITIES.ZONE_DEMAND + urgency,
      message: 'Commercial demand is high (' + Math.round(valves.comValve / 15) + '%). Build more commercial zones.',
      action: { type: 'build', tool: 'commercial' }
    });
  }

  if (valves.indValve > 100 && budget.totalFunds >= 100) {
    var urgency = Math.min(valves.indValve / 1500 * 15, 15);
    recs.push({
      priority: PRIORITIES.ZONE_DEMAND + urgency,
      message: 'Industrial demand is high (' + Math.round(valves.indValve / 15) + '%). Build more industrial zones.',
      action: { type: 'build', tool: 'industrial' }
    });
  }

  // Warn about oversupply
  if (valves.resValve < -1000) {
    recs.push({
      priority: PRIORITIES.ZONE_DEMAND - 10,
      message: 'Residential oversupply detected. Focus on commercial/industrial instead.'
    });
  }
  if (valves.comValve < -1000) {
    recs.push({
      priority: PRIORITIES.ZONE_DEMAND - 10,
      message: 'Commercial oversupply detected. Focus on residential/industrial instead.'
    });
  }
  if (valves.indValve < -1000) {
    recs.push({
      priority: PRIORITIES.ZONE_DEMAND - 10,
      message: 'Industrial oversupply detected. Focus on residential/commercial instead.'
    });
  }

  return recs;
};


AIAdvisor.prototype._analyzeInfrastructure = function(census, budget) {
  var recs = [];
  var totalZonePop = census.resZonePop + census.comZonePop + census.indZonePop;

  if (totalZonePop > 10 && totalZonePop * 2 > census.roadTotal) {
    recs.push({
      priority: PRIORITIES.ROAD_CONNECT,
      message: 'Need more roads to connect zones. Build roads ($10 each).',
      action: { type: 'build_roads' }
    });
  }

  if (budget.roadEffect < budget.MAX_ROAD_EFFECT * 0.6 && census.roadTotal > 30) {
    recs.push({
      priority: PRIORITIES.BUDGET + 5,
      message: 'Roads are deteriorating! Increase road maintenance funding.'
    });
  }

  return recs;
};


AIAdvisor.prototype._analyzeServices = function(census, budget) {
  var recs = [];
  var totalPop = census.totalPop;

  if (totalPop > 60 && census.policeStationPop === 0 && budget.totalFunds >= 500) {
    recs.push({
      priority: PRIORITIES.SERVICES + 10,
      message: 'No police stations! Crime will rise. Build one ($500).',
      action: { type: 'build', tool: 'police' }
    });
  }

  if (totalPop > 60 && census.fireStationPop === 0 && budget.totalFunds >= 500) {
    recs.push({
      priority: PRIORITIES.SERVICES + 10,
      message: 'No fire stations! Fires will spread. Build one ($500).',
      action: { type: 'build', tool: 'fire' }
    });
  }

  // Need more police for crime
  if (census.crimeAverage > 100 && budget.totalFunds >= 500) {
    recs.push({
      priority: PRIORITIES.SERVICES + 5,
      message: 'Crime is high (avg ' + census.crimeAverage + '). Build more police stations.',
      action: { type: 'build', tool: 'police' }
    });
  }

  // Check service funding
  if (budget.policeEffect < budget.MAX_POLICESTATION_EFFECT * 0.7 && census.policeStationPop > 0) {
    recs.push({
      priority: PRIORITIES.BUDGET + 3,
      message: 'Police stations are underfunded. Increase police budget.'
    });
  }

  if (budget.fireEffect < budget.MAX_FIRESTATION_EFFECT * 0.7 && census.fireStationPop > 0) {
    recs.push({
      priority: PRIORITIES.BUDGET + 3,
      message: 'Fire stations are underfunded. Increase fire budget.'
    });
  }

  return recs;
};


AIAdvisor.prototype._analyzeBudget = function(budget, census) {
  var recs = [];

  if (budget.cityTax > 12) {
    recs.push({
      priority: PRIORITIES.BUDGET + 10,
      message: 'Tax rate is too high (' + budget.cityTax + '%). Residents are unhappy. Lower to 7-9%.'
    });
  }

  if (budget.cityTax < 5 && census.totalPop > 100) {
    recs.push({
      priority: PRIORITIES.BUDGET,
      message: 'Tax rate is very low (' + budget.cityTax + '%). Consider raising to 7% for more revenue.'
    });
  }

  if (budget.totalFunds < 500 && census.totalPop > 0) {
    recs.push({
      priority: PRIORITIES.BUDGET + 15,
      message: 'Funds critically low ($' + budget.totalFunds + '). Reduce spending or raise taxes temporarily.'
    });
  }

  if (budget.cashFlow < 0 && census.totalPop > 50) {
    recs.push({
      priority: PRIORITIES.BUDGET + 5,
      message: 'Negative cash flow ($' + budget.cashFlow + '/yr). Review service spending vs tax revenue.'
    });
  }

  return recs;
};


AIAdvisor.prototype._analyzeSpecialBuildings = function(census) {
  var recs = [];

  if (census.resPop > 500 && census.stadiumPop === 0) {
    recs.push({
      priority: PRIORITIES.SPECIAL_BUILDINGS,
      message: 'Population wants a stadium ($5000). Residential growth is capped without one.',
      action: { type: 'build', tool: 'stadium' }
    });
  }

  if (census.indPop > 70 && census.seaportPop === 0) {
    recs.push({
      priority: PRIORITIES.SPECIAL_BUILDINGS,
      message: 'Industry needs a seaport ($3000). Industrial growth is capped without one.',
      action: { type: 'build', tool: 'port' }
    });
  }

  if (census.comPop > 100 && census.airportPop === 0) {
    recs.push({
      priority: PRIORITIES.SPECIAL_BUILDINGS,
      message: 'Commerce needs an airport ($10000). Commercial growth is capped without one.',
      action: { type: 'build', tool: 'airport' }
    });
  }

  return recs;
};


// ---- Location finding functions (used by AIHelper for auto-play) ----

// Find the best location to place a 3x3 zone (residential, commercial, industrial, police, fire)
AIAdvisor.prototype.findBestZoneLocation = function(toolName) {
  var map = this.map;
  var blockMaps = this.blockMaps;
  var bestScore = -Infinity;
  var bestX = -1, bestY = -1;
  var width = map.width;
  var height = map.height;

  // Sample the map in a grid pattern (checking every 3rd tile for performance)
  for (var y = 2; y < height - 2; y += 2) {
    for (var x = 2; x < width - 2; x += 2) {
      // Check if a 3x3 area is buildable
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


// Find best location for a 4x4 building (power plants, port, stadium)
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


// Find the best place to lay a road to connect zones
AIAdvisor.prototype.findRoadToConnect = function() {
  var map = this.map;
  var width = map.width;
  var height = map.height;

  // Find zones that aren't adjacent to roads and build roads toward them
  for (var y = 1; y < height - 1; y++) {
    for (var x = 1; x < width - 1; x++) {
      var tile = map.getTile(x, y);
      if (!tile.isZone()) continue;

      // Check if this zone has a road adjacent
      if (this._hasAdjacentRoad(x, y)) continue;

      // Find nearest road and build toward it
      var roadTarget = this._findNearestRoad(x, y);
      if (roadTarget) {
        return this._getNextRoadStep(x, y, roadTarget.x, roadTarget.y);
      }
    }
  }

  return null;
};


// Find a place to extend power lines to unpowered zones
AIAdvisor.prototype.findWireToConnect = function() {
  var map = this.map;
  var width = map.width;
  var height = map.height;

  // Find unpowered zones and try to connect them to power
  for (var y = 1; y < height - 1; y++) {
    for (var x = 1; x < width - 1; x++) {
      var tile = map.getTile(x, y);
      if (!tile.isZone()) continue;
      if (tile.isPowered()) continue;

      // Find nearest powered tile and build wire toward it
      var powerSource = this._findNearestPowered(x, y);
      if (powerSource) {
        return this._getNextWireStep(x, y, powerSource.x, powerSource.y);
      }
    }
  }

  return null;
};


// ---- Scoring helper functions ----

AIAdvisor.prototype._scoreZoneLocation = function(x, y, toolName) {
  var score = 0;
  var blockMaps = this.blockMaps;

  // Prefer locations near roads (huge bonus)
  if (this._hasNearbyRoad(x, y, 3)) score += 100;
  else if (this._hasNearbyRoad(x, y, 6)) score += 50;
  else score -= 50;

  // Prefer locations near power (bonus)
  if (this._hasNearbyPower(x, y, 5)) score += 40;

  // Get block map values (safely)
  var landValue = this._safeBlockGet(blockMaps.landValueMap, x, y);
  var pollution = this._safeBlockGet(blockMaps.pollutionDensityMap, x, y);
  var crime = this._safeBlockGet(blockMaps.crimeRateMap, x, y);

  switch (toolName) {
    case 'residential':
      // Residential prefers high land value, low pollution, low crime
      score += landValue * 2;
      score -= pollution * 3;
      score -= crime * 2;
      // Prefer some distance from industrial
      if (this._hasNearbyIndustrial(x, y, 4)) score -= 30;
      break;

    case 'commercial':
      // Commercial prefers high land value, moderate traffic, low pollution
      score += landValue * 3;
      score -= pollution * 2;
      // Prefer near residential (customers)
      if (this._hasNearbyResidential(x, y, 8)) score += 30;
      break;

    case 'industrial':
      // Industrial doesn't care about pollution or land value as much
      // Prefer low land value areas (cheaper, and pollution doesn't hurt industry)
      score -= landValue;
      score += 20; // Base bonus for existing
      // Prefer distance from residential
      if (!this._hasNearbyResidential(x, y, 5)) score += 20;
      break;

    case 'police':
      // Police should cover areas with high crime
      score += crime * 3;
      // Prefer central locations or high-population areas
      var popDensity = this._safeBlockGet(blockMaps.populationDensityMap, x, y);
      score += popDensity;
      // Avoid being too close to existing police stations
      if (this._hasNearbyBuilding(x, y, TileValues.POLICESTATION, 15)) score -= 200;
      break;

    case 'fire':
      // Fire stations should cover populated areas
      var popDensity = this._safeBlockGet(blockMaps.populationDensityMap, x, y);
      score += popDensity * 2;
      // Avoid being too close to existing fire stations
      if (this._hasNearbyBuilding(x, y, TileValues.FIRESTATION, 15)) score -= 200;
      break;
  }

  // Slight preference for closer to city center (reduce sprawl)
  var dx = x - this.map.cityCentreX;
  var dy = y - this.map.cityCentreY;
  var dist = Math.sqrt(dx * dx + dy * dy);
  score -= dist * 0.5;

  return score;
};


AIAdvisor.prototype._scoreLargeLocation = function(x, y, toolName) {
  var score = 0;

  // Must be near roads
  if (this._hasNearbyRoad(x, y, 4)) score += 80;
  else if (this._hasNearbyRoad(x, y, 8)) score += 30;
  else score -= 100;

  // Prefer near power
  if (this._hasNearbyPower(x, y, 6)) score += 40;

  var blockMaps = this.blockMaps;
  var landValue = this._safeBlockGet(blockMaps.landValueMap, x, y);

  switch (toolName) {
    case 'coal':
    case 'nuclear':
      // Power plants should be away from residential
      if (!this._hasNearbyResidential(x, y, 8)) score += 40;
      score -= landValue; // Prefer low land value areas
      break;

    case 'stadium':
      // Stadiums near population centers
      var popDensity = this._safeBlockGet(blockMaps.populationDensityMap, x, y);
      score += popDensity * 2;
      score += landValue;
      break;

    case 'port':
      // Ports need to be near water
      if (this._hasNearbyWater(x, y, 3)) score += 100;
      else score -= 500;
      break;

    case 'airport':
      // Airports prefer open areas away from dense population
      score -= landValue;
      break;
  }

  return score;
};


// ---- Utility functions for map scanning ----

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
  for (var radius = 1; radius < 20; radius++) {
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


AIAdvisor.prototype._getNextRoadStep = function(fromX, fromY, toX, toY) {
  // Move one step toward the target road, preferring straight lines
  var dx = toX - fromX;
  var dy = toY - fromY;

  if (Math.abs(dx) > Math.abs(dy)) {
    return { x: fromX + (dx > 0 ? 1 : -1), y: fromY };
  } else {
    return { x: fromX, y: fromY + (dy > 0 ? 1 : -1) };
  }
};


AIAdvisor.prototype._getNextWireStep = function(fromX, fromY, toX, toY) {
  var dx = toX - fromX;
  var dy = toY - fromY;

  if (Math.abs(dx) > Math.abs(dy)) {
    return { x: fromX + (dx > 0 ? 1 : -1), y: fromY };
  } else {
    return { x: fromX, y: fromY + (dy > 0 ? 1 : -1) };
  }
};


AIAdvisor.prototype._safeBlockGet = function(blockMap, x, y) {
  try {
    return blockMap.worldGet(x, y) || 0;
  } catch (e) {
    return 0;
  }
};


export { AIAdvisor };
