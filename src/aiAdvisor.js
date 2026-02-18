/* AI Advisor for SimCit - Strategy Engine
 *
 * Grid-based city planner with zone districts:
 *   - Residential: NORTH of main road (clean, low pollution)
 *   - Commercial: Along main road (central, accessible)
 *   - Industrial: SOUTH of main road (pollution contained)
 *   - Power plant: South-east, near industrial
 *
 * Phased growth:
 *   - Bootstrap: Build optimal starter city layout
 *   - Early: Wait for positive cash flow, build sparingly
 *   - Growth: Expand grid systematically following demand
 *   - Metro: Optimize score, add special buildings
 *
 * Key mechanics:
 *   - Score: power ratio, zone caps (0.85x), crime, tax, unemployment
 *   - Revenue: floor(totalPop * landValueAvg / 120) * cityTax * FLevels
 *   - Traffic: MAX_TRAFFIC_DISTANCE = 30 tiles residential to jobs
 *   - Power: Propagates through CONDBIT tiles (wire, road+wire hybrids, zone tiles)
 *   - Zone tiles have CONDBIT (BNCNBIT = BURNBIT | CONDBIT)
 *   - Zone growth: road access + power + pollution < 128 for residential
 *   - Unemployment: resPop / ((comPop + indPop) * 8) - 1
 */

import * as TileValues from './tileValues.ts';
import { TileUtils } from './tileUtils.js';

var PRIORITIES = {
  EMERGENCY: 120,
  POWER: 100,
  BUDGET_ADJUST: 95,
  ROAD_CONNECT: 90,
  ZONE_DEMAND: 80,
  WIRE_CONNECT: 75,
  SERVICES: 60,
  SPECIAL_BUILDINGS: 50,
  TRAFFIC: 45,
  BUDGET_INFO: 40,
  PARKS: 20
};

var MIN_RESERVE = 500;
var COMFORTABLE_FUNDS = 2000;
var GRID_SPACING = 4;
var DISTRICT_RADIUS = 6;

function AIAdvisor(simulation, gameMap, blockMaps) {
  this.simulation = simulation;
  this.map = gameMap;
  this.blockMaps = blockMaps;

  this._plan = {
    initialized: false,
    gridOriginX: 0,
    gridOriginY: 0
  };
}


// ---- City plan management ----

AIAdvisor.prototype._getPhase = function() {
  var pop = this.simulation._census.totalPop;
  if (pop === 0) return 'bootstrap';
  if (pop < 50) return 'early';
  if (pop < 500) return 'growth';
  return 'metro';
};


AIAdvisor.prototype.initCityPlan = function(gx, gy) {
  this._plan.initialized = true;
  this._plan.gridOriginX = gx;
  this._plan.gridOriginY = gy;
};


AIAdvisor.prototype.findStarterLocation = function() {
  var cx = this.map.cityCentreX;
  var cy = this.map.cityCentreY;

  // Need area for T-grid: 13 wide x 15 tall
  // Layout: (gx-6, gy-3) to (gx+6, gy+11)
  for (var r = 0; r < 40; r++) {
    for (var dy = -r; dy <= r; dy++) {
      for (var dx = -r; dx <= r; dx++) {
        if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
        var gx = cx + dx;
        var gy = cy + dy;
        if (this._isAreaClear(gx - 6, gy - 3, 13, 15)) {
          return { x: gx, y: gy };
        }
      }
    }
  }

  // Fallback: smaller area (plant placed separately)
  for (var r = 0; r < 40; r++) {
    for (var dy = -r; dy <= r; dy++) {
      for (var dx = -r; dx <= r; dx++) {
        if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
        var gx = cx + dx;
        var gy = cy + dy;
        if (this._isAreaClear(gx - 6, gy - 3, 13, 12)) {
          return { x: gx, y: gy };
        }
      }
    }
  }

  return null;
};


AIAdvisor.prototype._isGridAligned = function(x, y) {
  if (!this._plan.initialized) return false;
  var relX = x - this._plan.gridOriginX;
  var relY = y - this._plan.gridOriginY;
  return (((relX % GRID_SPACING) + GRID_SPACING) % GRID_SPACING === 2) &&
         (((relY % GRID_SPACING) + GRID_SPACING) % GRID_SPACING === 2);
};


// Auto-detect grid from existing city if plan wasn't initialized
AIAdvisor.prototype._ensurePlanInitialized = function() {
  if (this._plan.initialized) return;

  // Try to detect grid origin from existing zones
  var map = this.map;
  for (var y = 2; y < map.height - 2; y++) {
    for (var x = 2; x < map.width - 2; x++) {
      var tile = map.getTile(x, y);
      if (tile.isZone()) {
        this._plan.initialized = true;
        this._plan.gridOriginX = x;
        this._plan.gridOriginY = y;
        return;
      }
    }
  }
};


// ---- Main analysis ----

AIAdvisor.prototype.analyze = function() {
  var recommendations = [];
  var sim = this.simulation;
  var census = sim._census;
  var budget = sim.budget;
  var valves = sim._valves;

  this._ensurePlanInitialized();

  // Budget adjustments are FREE - always check first
  var budgetActions = this._analyzeBudgetActions(budget, census);
  recommendations = recommendations.concat(budgetActions);

  // Emergency mode
  var isEmergency = budget.totalFunds < MIN_RESERVE && census.totalPop > 0;
  if (isEmergency) {
    recommendations.push({
      priority: PRIORITIES.EMERGENCY,
      message: 'EMERGENCY: Funds at $' + budget.totalFunds + '. Halting construction.'
    });
    recommendations.sort(function(a, b) { return b.priority - a.priority; });
    return recommendations;
  }

  recommendations = recommendations.concat(this._analyzePower(census, budget));
  recommendations = recommendations.concat(this._analyzeZoneDemand(census, valves, budget));
  recommendations = recommendations.concat(this._analyzeInfrastructure(census, budget));
  recommendations = recommendations.concat(this._analyzeTraffic(census));
  recommendations = recommendations.concat(this._analyzeServices(census, budget));
  recommendations = recommendations.concat(this._analyzeBudgetInfo(budget, census));
  recommendations = recommendations.concat(this._analyzeSpecialBuildings(census, budget));
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


// ---- Budget actions (FREE) ----

AIAdvisor.prototype._analyzeBudgetActions = function(budget, census) {
  var recs = [];

  var optimalTax = 7;
  if (budget.totalFunds < 1000 && census.totalPop > 0) {
    optimalTax = 9;
  } else if (budget.totalFunds > 15000) {
    optimalTax = 6;
  }

  if (budget.cityTax !== optimalTax) {
    recs.push({
      priority: PRIORITIES.BUDGET_ADJUST,
      message: 'Adjusting tax rate from ' + budget.cityTax + '% to ' + optimalTax + '%.',
      action: { type: 'set_tax', value: optimalTax }
    });
  }

  var totalMaintenance = budget.roadMaintenanceBudget + budget.fireMaintenanceBudget + budget.policeMaintenanceBudget;
  if (totalMaintenance > 0 && budget.totalFunds < totalMaintenance && census.totalPop > 0) {
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
        message: 'CRITICAL: No power! Saving for coal plant ($3000). Have: $' + budget.totalFunds
      });
    }
  } else if (totalZones > 0 && census.unpoweredZoneCount > totalZones * 0.3) {
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


// ---- Zone demand (phase-aware) ----

AIAdvisor.prototype._analyzeZoneDemand = function(census, valves, budget) {
  var recs = [];
  var totalZonePop = census.resZonePop + census.comZonePop + census.indZonePop;
  var phase = this._getPhase();

  // Bootstrap: build starter city
  if (totalZonePop === 0 && budget.totalFunds >= 4000) {
    recs.push({
      priority: PRIORITIES.ZONE_DEMAND + 15,
      message: 'Building optimal starter city with grid layout and power.',
      action: { type: 'build_starter' }
    });
    return recs;
  }

  // Early phase: don't build until cash flow is positive
  if (phase === 'early' && budget.cashFlow < 0) {
    recs.push({
      priority: PRIORITIES.BUDGET_INFO,
      message: 'Early phase: waiting for positive cash flow ($' + budget.cashFlow + '/yr) before expanding.'
    });
    return recs;
  }

  // Calculate unemployment
  var jobBase = (census.comPop + census.indPop) * 8;
  var unemployment = 0;
  if (jobBase > 0) {
    unemployment = Math.round((census.resPop / jobBase - 1) * 255);
    unemployment = Math.max(0, Math.min(unemployment, 255));
  }

  // Phase-dependent reserve
  var buildReserve = phase === 'early' ? 5000 :
                     phase === 'growth' ? COMFORTABLE_FUNDS :
                     phase === 'metro' ? 5000 : MIN_RESERVE;
  var canAffordZone = budget.totalFunds >= 200 + buildReserve;

  if (!canAffordZone) {
    if (valves.resValve > 500 || valves.comValve > 500 || valves.indValve > 500) {
      recs.push({
        priority: PRIORITIES.ZONE_DEMAND - 5,
        message: 'Demand exists but keeping reserve ($' + budget.totalFunds + '). Waiting for revenue.'
      });
    }
    return recs;
  }

  // High unemployment: prioritize jobs
  if (unemployment > 100 && (valves.comValve > 0 || valves.indValve > 0)) {
    recs.push({
      priority: PRIORITIES.ZONE_DEMAND + 12,
      message: 'High unemployment (' + unemployment + '). Prioritizing job-creating zones.',
      action: { type: 'build', tool: valves.comValve >= valves.indValve ? 'commercial' : 'industrial' }
    });
    return recs;
  }

  // Follow RCI demand valves
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

  // Oversupply warnings
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

  if (totalZonePop > 10 && totalZonePop * 2 > census.roadTotal && budget.totalFunds >= 10 + MIN_RESERVE) {
    recs.push({
      priority: PRIORITIES.ROAD_CONNECT,
      message: 'Need roads to connect zones (have ' + census.roadTotal + ', need ~' + (totalZonePop * 2) + ').',
      action: { type: 'build_roads' }
    });
  }

  if (budget.roadEffect < Math.floor(5 * budget.MAX_ROAD_EFFECT / 8) && census.roadTotal > 30) {
    recs.push({
      priority: PRIORITIES.BUDGET_ADJUST,
      message: 'Roads deteriorating (score penalty). Funding: ' + Math.round(budget.roadPercent * 100) + '%.',
      action: { type: 'set_funding', road: 1, fire: budget.firePercent, police: budget.policePercent }
    });
  }

  return recs;
};


// ---- Traffic ----

AIAdvisor.prototype._analyzeTraffic = function(census) {
  var recs = [];
  var trafficAvg = census.trafficAverage || 0;

  if (trafficAvg > 60) {
    recs.push({
      priority: PRIORITIES.TRAFFIC + 5,
      message: 'Traffic congestion (avg ' + Math.round(trafficAvg) + '). Building parallel roads.',
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

  if (totalPop > 60 && census.policeStationPop === 0 && canAfford) {
    recs.push({
      priority: PRIORITIES.SERVICES + 10,
      message: 'No police! Crime rising. Building station ($500).',
      action: { type: 'build', tool: 'police' }
    });
  }

  if (totalPop > 60 && census.fireStationPop === 0 && canAfford) {
    recs.push({
      priority: PRIORITIES.SERVICES + 10,
      message: 'No fire dept! Building station ($500).',
      action: { type: 'build', tool: 'fire' }
    });
  }

  if (census.crimeAverage > 100 && canAfford) {
    recs.push({
      priority: PRIORITIES.SERVICES + 5,
      message: 'Crime high (avg ' + census.crimeAverage + '). Building police station.',
      action: { type: 'build', tool: 'police' }
    });
  }

  if (census.firePop > 0 && census.fireStationPop === 0 && canAfford) {
    recs.push({
      priority: PRIORITIES.SERVICES + 8,
      message: census.firePop + ' active fires! Need fire stations.',
      action: { type: 'build', tool: 'fire' }
    });
  }

  return recs;
};


// ---- Budget info ----

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
      message: 'Low funds ($' + budget.totalFunds + '). Building only essentials.'
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


// ---- Disaster recovery ----

AIAdvisor.prototype._analyzeDisasterRecovery = function() {
  var recs = [];
  var map = this.map;
  var fireCount = 0;
  var rubbleCount = 0;

  for (var y = 0; y < map.height; y += 4) {
    for (var x = 0; x < map.width; x += 4) {
      var tv = map.getTileValue(x, y);
      if (tv >= TileValues.FIRE && tv <= TileValues.LASTFIRE) fireCount++;
      if (tv >= TileValues.RUBBLE && tv <= TileValues.LASTRUBBLE) rubbleCount++;
    }
  }

  if (fireCount > 3) {
    recs.push({
      priority: PRIORITIES.EMERGENCY - 5,
      message: 'Fires burning! ' + (fireCount * 16) + '+ tiles affected.',
      action: { type: 'build', tool: 'fire' }
    });
  }

  if (rubbleCount > 5) {
    recs.push({
      priority: PRIORITIES.TRAFFIC,
      message: 'Disaster rubble (' + (rubbleCount * 16) + '+ tiles). Rebuilding.',
      action: { type: 'bulldoze_rubble' }
    });
  }

  return recs;
};


// ---- Location finding ----

AIAdvisor.prototype.findBestZoneLocation = function(toolName) {
  var map = this.map;
  var bestScore = -Infinity;
  var bestX = -1, bestY = -1;

  for (var y = 2; y < map.height - 2; y += 2) {
    for (var x = 2; x < map.width - 2; x += 2) {
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


AIAdvisor.prototype.findBestLargeLocation = function(toolName) {
  var map = this.map;
  var bestScore = -Infinity;
  var bestX = -1, bestY = -1;

  for (var y = 2; y < map.height - 3; y += 3) {
    for (var x = 2; x < map.width - 3; x += 3) {
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


AIAdvisor.prototype.findBestAirportLocation = function() {
  var map = this.map;
  var bestScore = -Infinity;
  var bestX = -1, bestY = -1;

  for (var y = 4; y < map.height - 4; y += 4) {
    for (var x = 4; x < map.width - 4; x += 4) {
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

    if (Math.abs(dx) >= Math.abs(dy)) {
      nx = cx + (dx > 0 ? 1 : -1);
      ny = cy;
    } else {
      nx = cx;
      ny = cy + (dy > 0 ? 1 : -1);
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

    break;
  }

  return path;
};


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
        var path = this.findRoadPath(x, y, roadTarget.x, roadTarget.y);
        if (path.length > 0) return path;
      }

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


// Find wire path to connect unpowered zones - routes along roads
AIAdvisor.prototype.findWireToConnect = function() {
  var map = this.map;
  var width = map.width;
  var height = map.height;

  for (var y = 1; y < height - 1; y++) {
    for (var x = 1; x < width - 1; x++) {
      var tile = map.getTile(x, y);
      if (!tile.isZone()) continue;
      if (tile.isPowered()) continue;

      // Find nearest powered tile (prefer powered roads for wire routing)
      var powerSource = this._findNearestPowered(x, y);
      if (!powerSource) continue;

      // Build wire path, preferring to follow roads
      var path = this._findWirePath(x, y, powerSource.x, powerSource.y);
      if (path.length > 0) return path;

      // Fallback: direct path
      var directPath = this.findRoadPath(x, y, powerSource.x, powerSource.y);
      if (directPath.length > 0) return directPath;
    }
  }

  return null;
};


// Wire path that follows roads (converts to road+wire hybrids)
AIAdvisor.prototype._findWirePath = function(fromX, fromY, toX, toY) {
  var path = [];
  var cx = fromX;
  var cy = fromY;
  var map = this.map;
  var maxSteps = Math.abs(toX - fromX) + Math.abs(toY - fromY) + 10;

  for (var step = 0; step < maxSteps; step++) {
    if (cx === toX && cy === toY) break;

    var dx = toX - cx;
    var dy = toY - cy;

    // Try all 4 directions, prioritizing: toward target + road tiles
    var candidates = [];
    var dirs = [[0, -1], [1, 0], [0, 1], [-1, 0]];
    for (var i = 0; i < dirs.length; i++) {
      var nx = cx + dirs[i][0];
      var ny = cy + dirs[i][1];
      if (nx < 0 || ny < 0 || nx >= map.width || ny >= map.height) continue;

      var tv = map.getTileValue(nx, ny);
      var tile = map.getTile(nx, ny);
      var isRoad = TileUtils.isRoad(tv);
      var isClear = tv === TileValues.DIRT || TileUtils.canBulldoze(tv);
      var isConductive = tile.isConductive();

      if (!isRoad && !isClear && !isConductive) continue;

      // Score: prefer roads, prefer direction toward target
      var score = 0;
      if (isRoad) score += 100; // Strongly prefer wiring roads
      if (isConductive) score += 50; // Already powered path
      score -= Math.abs(nx - toX) + Math.abs(ny - toY); // Closer to target

      candidates.push({ x: nx, y: ny, score: score, isRoad: isRoad, needsWire: isRoad && !isConductive });
    }

    if (candidates.length === 0) break;

    candidates.sort(function(a, b) { return b.score - a.score; });
    var best = candidates[0];

    // Only add to path if it needs a wire placed
    if (best.needsWire || (!TileUtils.isRoad(map.getTileValue(best.x, best.y)) && !map.getTile(best.x, best.y).isConductive())) {
      path.push({ x: best.x, y: best.y });
    }

    cx = best.x;
    cy = best.y;
  }

  return path;
};


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


// ---- Scoring (strict district enforcement + clustering) ----

AIAdvisor.prototype._scoreZoneLocation = function(x, y, toolName) {
  var score = 0;
  var blockMaps = this.blockMaps;

  // Road adjacency is critical - zones without road access won't grow
  if (this._hasNearbyRoad(x, y, 2)) score += 150;
  else if (this._hasNearbyRoad(x, y, 4)) score += 60;
  else if (this._hasNearbyRoad(x, y, 8)) score += 10;
  else return -9999;

  // Power connectivity
  if (this._hasNearbyPower(x, y, 4)) score += 50;
  else if (this._hasNearbyPower(x, y, 8)) score += 20;

  // Grid alignment bonus
  if (this._isGridAligned(x, y)) score += 40;

  var landValue = this._safeBlockGet(blockMaps.landValueMap, x, y);
  var pollution = this._safeBlockGet(blockMaps.pollutionDensityMap, x, y);
  var crime = this._safeBlockGet(blockMaps.crimeRateMap, x, y);
  var traffic = this._safeBlockGet(blockMaps.trafficDensityMap, x, y);
  var popDensity = this._safeBlockGet(blockMaps.populationDensityMap, x, y);

  switch (toolName) {
    case 'residential':
      // HARD REJECT: pollution kills residential (degrades at > 128)
      if (pollution > 100) return -9999;
      // HARD REJECT: industrial within district radius = pollution source
      if (this._hasNearbyIndustrial(x, y, DISTRICT_RADIUS)) return -9999;
      score += landValue * 2;
      score -= pollution * 4;
      score -= crime * 2;
      score -= traffic;
      // Cluster bonus: residential near residential
      if (this._hasNearbyResidential(x, y, 6)) score += 80;
      // Needs jobs within traffic routing distance
      if (this._hasNearbyCommercial(x, y, 15) || this._hasNearbyIndustrial(x, y, 20)) score += 25;
      break;

    case 'commercial':
      if (pollution > 128) return -9999;
      score += landValue * 3;
      score -= pollution * 2;
      // Needs residential nearby (labor)
      if (this._hasNearbyResidential(x, y, 10)) score += 50;
      else score -= 40;
      // Cluster bonus
      if (this._hasNearbyCommercial(x, y, 6)) score += 60;
      break;

    case 'industrial':
      // HARD REJECT: keep away from residential
      if (this._hasNearbyResidential(x, y, DISTRICT_RADIUS)) return -9999;
      score -= landValue;
      score += 30;
      // Cluster bonus: industrial near industrial
      if (this._hasNearbyIndustrial(x, y, 6)) score += 80;
      // But must be reachable from residential for traffic routing
      if (this._hasNearbyResidential(x, y, 25)) score += 20;
      break;

    case 'police':
      var policeEffect = this._safeBlockGet(blockMaps.policeStationEffectMap, x, y);
      score += (1000 - policeEffect);
      score += crime * 2;
      score += popDensity;
      if (this._hasNearbyBuilding(x, y, TileValues.POLICESTATION, 15)) score -= 300;
      break;

    case 'fire':
      var fireEffect = this._safeBlockGet(blockMaps.fireStationEffectMap, x, y);
      score += (1000 - fireEffect);
      score += popDensity * 2;
      if (this._hasNearbyBuilding(x, y, TileValues.FIRESTATION, 15)) score -= 300;
      break;
  }

  // Prefer closer to city center
  var dx = x - this.map.cityCentreX;
  var dy = y - this.map.cityCentreY;
  score -= Math.sqrt(dx * dx + dy * dy) * 0.3;

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
      // Keep away from residential (pollution source)
      if (!this._hasNearbyResidential(x, y, 8)) score += 50;
      // Prefer near industrial
      if (this._hasNearbyIndustrial(x, y, 10)) score += 30;
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
      break;
  }

  return score;
};


// ---- Map scanning utilities ----

AIAdvisor.prototype._isAreaClear = function(startX, startY, width, height) {
  if (height === undefined) height = width;
  var map = this.map;

  if (startX < 0 || startY < 0 || startX + width > map.width || startY + height > map.height)
    return false;

  for (var dy = 0; dy < height; dy++) {
    for (var dx = 0; dx < width; dx++) {
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
