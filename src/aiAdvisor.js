/* AI Advisor for SimCit - Strategy Engine
 *
 * Grid-based city planner with zone districts:
 *   - Residential: NORTH of main road (clean, low pollution)
 *   - Commercial: Along main road (central, accessible)
 *   - Industrial: SOUTH of main road (pollution contained)
 *   - Power plant: South-east, near industrial
 *
 * Power math (work backwards from need):
 *   - Coal: 700 capacity = ~57 zones @ 12 tiles/zone, costs $3000
 *   - Nuclear: 2000 capacity = ~165 zones, costs $5000
 *   - Each zone ~12 power tiles (9 zone tiles + ~3 road/wire overhead)
 *   - 1 coal handles Town, City, and most of Capital
 *   - 2nd coal only when utilization > 80% (~45+ zones)
 *   - Nuclear only replaces 2+ coal at 80+ zones ($5k < 2×$3k)
 *
 * Employment balance (drives zone building):
 *   - employment = (comPop + indPop) / (resPop / 8)
 *   - Target range: 0.8 to 1.3
 *   - R:(C+I) ≈ 1:1 in zone count for balance
 *   - Below 0.8: prioritize C/I (need jobs)
 *   - Above 1.3: prioritize R (need workers)
 *   - Balanced: follow demand valves as tiebreaker
 *
 * Progression targets:
 *   - Starter: 1 coal + 3R+1C+2I = ~$4500 of $20k budget
 *   - Town (2k pop): ~10 developed zones, 1 coal
 *   - City (10k pop): ~25 zones, 1 coal
 *   - Capital (50k pop): ~70 zones, 2 coal
 *   - Metropolis (100k+): 120+ zones, nuclear upgrade
 *
 * Key mechanics:
 *   - Revenue: floor(totalPop * landValueAvg / 120) * cityTax * FLevels
 *   - Traffic: MAX_TRAFFIC_DISTANCE = 30 tiles residential to jobs
 *   - Power: Propagates through CONDBIT tiles (wire, road+wire, zone tiles)
 *   - Zone growth: road access + power + pollution < 128 for residential
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

// Power math constants
var COAL_CAPACITY = 700;
var NUCLEAR_CAPACITY = 2000;
var TILES_PER_ZONE = 12;      // 9 zone tiles + ~3 shared road/wire
var PLANT_OVERHEAD = 16;       // 4x4 plant footprint
var POWER_BUILD_THRESHOLD = 0.80;

// Employment balance targets
var EMPLOYMENT_LOW = 0.8;      // Below: need more C/I jobs
var EMPLOYMENT_HIGH = 1.3;     // Above: need more R residents
var NUCLEAR_MIN_ZONES = 80;    // Don't build nuclear below this

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
  var census = this.simulation._census;
  var totalZones = census.poweredZoneCount + census.unpoweredZoneCount;
  if (totalZones === 0) return 'bootstrap';
  if (census.totalPop < 50) return 'early';
  if (census.totalPop < 500) return 'growth';
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

  // Need area for T-grid: 15 wide x 15 tall
  // Wider to fit grid-aligned zones at gx-6, gx-2, gx+2, gx+6
  // Layout: (gx-7, gy-3) to (gx+7, gy+11)
  for (var r = 0; r < 40; r++) {
    for (var dy = -r; dy <= r; dy++) {
      for (var dx = -r; dx <= r; dx++) {
        if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
        var gx = cx + dx;
        var gy = cy + dy;
        if (this._isAreaClear(gx - 7, gy - 3, 15, 15)) {
          return { x: gx, y: gy };
        }
      }
    }
  }

  // Fallback: smaller area
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

  var map = this.map;

  // Find the main road by looking for the Y coordinate with the most road tiles
  // This establishes the dividing line: residential north, industrial south
  var roadCountByY = {};
  var bestY = -1;
  var bestCount = 0;
  var totalRoadX = 0;
  var totalRoadCount = 0;

  for (var y = 2; y < map.height - 2; y += 1) {
    var count = 0;
    for (var x = 2; x < map.width - 2; x += 1) {
      if (TileUtils.isRoad(map.getTileValue(x, y))) {
        count++;
        totalRoadX += x;
        totalRoadCount++;
      }
    }
    if (count > bestCount) {
      bestCount = count;
      bestY = y;
    }
  }

  if (bestY !== -1 && totalRoadCount > 0) {
    this._plan.initialized = true;
    this._plan.gridOriginX = Math.round(totalRoadX / totalRoadCount);
    this._plan.gridOriginY = bestY;
    return;
  }

  // Fallback: use map center
  this._plan.initialized = true;
  this._plan.gridOriginX = this.map.cityCentreX;
  this._plan.gridOriginY = this.map.cityCentreY;
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


// ---- Power analysis (math-based) ----
//
// Coal: 700 capacity handles ~57 zones. One plant is enough until ~45 zones.
// Nuclear: 2000 capacity handles ~165 zones. Only cost-effective at 80+ zones.
// Never build power reactively to unpowered zones - calculate actual capacity.

AIAdvisor.prototype._analyzePower = function(census, budget) {
  var recs = [];
  var totalZones = census.poweredZoneCount + census.unpoweredZoneCount;
  var coalPlants = census.coalPowerPop;
  var nuclearPlants = census.nuclearPowerPop;
  var maxPower = coalPlants * COAL_CAPACITY + nuclearPlants * NUCLEAR_CAPACITY;

  // No zones yet - no power needed
  if (totalZones === 0) return recs;

  // No power at all - need first coal plant
  if (maxPower === 0) {
    if (budget.totalFunds >= 3000 + MIN_RESERVE) {
      recs.push({
        priority: PRIORITIES.POWER + 10,
        message: 'No power! Building coal plant ($3000). Handles ~57 zones.',
        action: { type: 'build', tool: 'coal' }
      });
    } else {
      recs.push({
        priority: PRIORITIES.POWER + 10,
        message: 'Need coal plant ($3000). Have: $' + budget.totalFunds
      });
    }
    return recs;
  }

  // Calculate actual power utilization
  var estConsumption = totalZones * TILES_PER_ZONE +
    (coalPlants + nuclearPlants) * PLANT_OVERHEAD;
  var utilization = estConsumption / maxPower;
  var zonesUntilFull = Math.floor((maxPower - estConsumption) / TILES_PER_ZONE);

  // Only build new plant when utilization exceeds threshold
  if (utilization > POWER_BUILD_THRESHOLD || zonesUntilFull < 8) {
    // Nuclear only when: already have 2+ coal AND large city AND cheaper than 3rd coal
    if (coalPlants >= 2 && nuclearPlants === 0 &&
        totalZones >= NUCLEAR_MIN_ZONES &&
        budget.totalFunds >= 5000 + COMFORTABLE_FUNDS) {
      recs.push({
        priority: PRIORITIES.POWER + 5,
        message: 'Power ' + Math.round(utilization * 100) + '% (' +
          zonesUntilFull + ' zones left). Nuclear upgrade for ' + totalZones + ' zones.',
        action: { type: 'build', tool: 'nuclear' }
      });
    } else if (budget.totalFunds >= 3000 + MIN_RESERVE) {
      recs.push({
        priority: PRIORITIES.POWER + 5,
        message: 'Power ' + Math.round(utilization * 100) + '% (' +
          zonesUntilFull + ' zones left). Building 2nd coal plant.',
        action: { type: 'build', tool: 'coal' }
      });
    } else {
      recs.push({
        priority: PRIORITIES.POWER,
        message: 'Power running low (' + zonesUntilFull + ' zones left). Saving for plant.'
      });
    }
  } else if (census.unpoweredZoneCount > 0) {
    // Have capacity but zones aren't connected - wiring issue, not capacity
    recs.push({
      priority: PRIORITIES.WIRE_CONNECT,
      message: census.unpoweredZoneCount + ' zones need power lines (have capacity).',
      action: { type: 'wire_connect' }
    });
  }

  return recs;
};


// ---- Zone demand (employment-ratio driven) ----
//
// Core strategy: maintain R:(C+I) ≈ 1:1 for employment balance.
// employment = (comPop + indPop) / (resPop / 8)
// - Below 0.8: not enough jobs → build C/I
// - Above 1.3: excess jobs → build R
// - 0.8-1.3: balanced → follow valve demand with ratio guard
// Don't build zones if power can't handle them.

AIAdvisor.prototype._analyzeZoneDemand = function(census, valves, budget) {
  var recs = [];
  var totalZones = census.poweredZoneCount + census.unpoweredZoneCount;
  var phase = this._getPhase();

  // Bootstrap: build starter city
  if (totalZones === 0 && census.totalPop === 0 && budget.totalFunds >= 4500) {
    recs.push({
      priority: PRIORITIES.ZONE_DEMAND + 15,
      message: 'Building starter city: 1 coal + 3R+1C+2I (~$4500).',
      action: { type: 'build_starter' }
    });
    return recs;
  }

  // Early phase: wait for positive cash flow before expanding
  if (phase === 'early' && budget.cashFlow < 0) {
    recs.push({
      priority: PRIORITIES.BUDGET_INFO,
      message: 'Waiting for positive cash flow ($' + budget.cashFlow + '/yr).'
    });
    return recs;
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
        message: 'Demand exists but keeping reserve ($' + budget.totalFunds + ').'
      });
    }
    return recs;
  }

  // Don't build zones if power can't handle more
  var maxPower = census.coalPowerPop * COAL_CAPACITY + census.nuclearPowerPop * NUCLEAR_CAPACITY;
  var estConsumption = totalZones * TILES_PER_ZONE +
    (census.coalPowerPop + census.nuclearPowerPop) * PLANT_OVERHEAD;
  if (maxPower > 0 && estConsumption > maxPower * 0.90) {
    recs.push({
      priority: PRIORITIES.ZONE_DEMAND - 10,
      message: 'Power near capacity (' + Math.round(estConsumption / maxPower * 100) +
        '%). Build power plant before adding zones.'
    });
    return recs;
  }

  // Calculate employment balance (same formula as valve engine)
  var normalizedResPop = census.resPop / 8;
  var employment = 1;
  if (normalizedResPop > 0) {
    employment = (census.comPop + census.indPop) / normalizedResPop;
  }

  // PRIORITY 1: Fix severe employment imbalance
  if (employment < EMPLOYMENT_LOW && normalizedResPop > 2) {
    // Not enough jobs - build C or I
    var tool = valves.indValve >= valves.comValve ? 'industrial' : 'commercial';
    var loc = this.findBestZoneLocation(tool);
    if (loc && loc.score > -100) {
      recs.push({
        priority: PRIORITIES.ZONE_DEMAND + 15,
        message: 'Employment low (' + Math.round(employment * 100) +
          '%). Building ' + tool + ' for jobs.',
        action: { type: 'build', tool: tool }
      });
    } else {
      recs.push({
        priority: PRIORITIES.ROAD_CONNECT + 5,
        message: 'Need ' + tool + ' space. Expanding grid.',
        action: { type: 'expand_grid', zoneType: tool }
      });
    }
    return recs;
  }

  // PRIORITY 2: Excess jobs - need more residents
  if (employment > EMPLOYMENT_HIGH || (normalizedResPop < 2 && valves.resValve > 0)) {
    var loc = this.findBestZoneLocation('residential');
    if (loc && loc.score > -100) {
      recs.push({
        priority: PRIORITIES.ZONE_DEMAND + 12,
        message: (normalizedResPop < 2 ? 'Need residents for tax base.' :
          'Excess jobs (emp ' + Math.round(employment * 100) + '%).') +
          ' Building residential.',
        action: { type: 'build', tool: 'residential' }
      });
    } else {
      recs.push({
        priority: PRIORITIES.ROAD_CONNECT + 5,
        message: 'Need residential space. Expanding grid.',
        action: { type: 'expand_grid', zoneType: 'residential' }
      });
    }
    return recs;
  }

  // PRIORITY 3: Employment balanced - follow valve demand with ratio awareness
  var buildChoices = [];

  if (valves.resValve > 100) {
    buildChoices.push({ tool: 'residential', priority: valves.resValve / 100 });
  }
  if (valves.comValve > 100) {
    buildChoices.push({ tool: 'commercial', priority: valves.comValve / 75 });
  }
  if (valves.indValve > 100) {
    buildChoices.push({ tool: 'industrial', priority: valves.indValve / 75 });
  }

  buildChoices.sort(function(a, b) { return b.priority - a.priority; });

  for (var i = 0; i < buildChoices.length; i++) {
    var choice = buildChoices[i];
    var loc = this.findBestZoneLocation(choice.tool);
    if (loc && loc.score > -100) {
      recs.push({
        priority: PRIORITIES.ZONE_DEMAND + Math.min(Math.round(choice.priority), 20),
        message: 'Building ' + choice.tool + ' (emp: ' +
          Math.round(employment * 100) + '%, zones: ' + totalZones + ').',
        action: { type: 'build', tool: choice.tool }
      });
      break; // Only one zone per action cycle
    } else if (choice.tool === 'residential' || choice.tool === 'industrial') {
      recs.push({
        priority: PRIORITIES.ROAD_CONNECT + 5,
        message: 'Expanding grid for ' + choice.tool + '.',
        action: { type: 'expand_grid', zoneType: choice.tool }
      });
      break;
    }
  }

  // Oversupply warnings
  if (valves.resValve < -1000) {
    recs.push({ priority: PRIORITIES.BUDGET_INFO - 5,
      message: 'Residential oversupply. Need more jobs.' });
  }
  if (valves.comValve < -1000) {
    recs.push({ priority: PRIORITIES.BUDGET_INFO - 5,
      message: 'Commercial oversupply. Need more residents.' });
  }
  if (valves.indValve < -1000) {
    recs.push({ priority: PRIORITIES.BUDGET_INFO - 5,
      message: 'Industrial oversupply. Need more residents.' });
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


// Find road positions needed to expand the grid for a zone type
AIAdvisor.prototype.findGridExpansionRoads = function(zoneType) {
  if (!this._plan.initialized) return null;

  var gx = this._plan.gridOriginX;
  var gy = this._plan.gridOriginY;
  var map = this.map;
  var path = [];

  if (zoneType === 'residential') {
    // Extend main road east or west, then add a parallel road north
    // Try extending east first
    var extendX = gx + 8;
    while (extendX < map.width - 5 && TileUtils.isRoad(map.getTileValue(extendX, gy))) {
      extendX += 4;
    }
    if (extendX < map.width - 5 && this._isAreaClear(extendX, gy, 4, 1)) {
      // Extend main road east by 4 tiles
      for (var rx = extendX; rx < extendX + 4 && rx < map.width; rx++) {
        path.push({ x: rx, y: gy });
      }
      // Add parallel road north at gy-4 for new zone slots
      for (var rx = extendX; rx < extendX + 4 && rx < map.width; rx++) {
        if (gy - 4 >= 0) path.push({ x: rx, y: gy - 4 });
      }
      return path;
    }

    // Try extending west
    extendX = gx - 8;
    while (extendX >= 2 && TileUtils.isRoad(map.getTileValue(extendX, gy))) {
      extendX -= 4;
    }
    if (extendX >= 2 && this._isAreaClear(extendX - 3, gy, 4, 1)) {
      for (var rx = extendX; rx > extendX - 4 && rx >= 0; rx--) {
        path.push({ x: rx, y: gy });
      }
      return path;
    }
  } else if (zoneType === 'industrial') {
    // Extend branch road further south or add parallel branches
    var extendY = gy + 12;
    while (extendY < map.height - 5 && TileUtils.isRoad(map.getTileValue(gx, extendY))) {
      extendY += 4;
    }
    if (extendY < map.height - 5) {
      for (var ry = extendY; ry < extendY + 4 && ry < map.height; ry++) {
        path.push({ x: gx, y: ry });
      }
      // Add cross-road at the new depth
      for (var rx = gx - 2; rx <= gx + 4; rx++) {
        if (rx !== gx) path.push({ x: rx, y: extendY });
      }
      return path;
    }
  }

  return null;
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

  // HARD POSITIONAL DISTRICT RULES (based on grid origin)
  // Residential: NORTH of main road only (y <= gridOriginY)
  // Industrial: SOUTH of main road only (y > gridOriginY)
  // This prevents mixing regardless of build order
  if (this._plan.initialized) {
    var gridY = this._plan.gridOriginY;
    if (toolName === 'residential' && y > gridY) return -9999;
    if (toolName === 'industrial' && y <= gridY) return -9999;
  }

  switch (toolName) {
    case 'residential':
      // HARD REJECT: pollution kills residential (degrades at > 128)
      if (pollution > 100) return -9999;
      // HARD REJECT: industrial within district radius
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
      // Prefer near the main road (gridOriginY)
      if (this._plan.initialized) {
        score -= Math.abs(y - this._plan.gridOriginY) * 3;
      }
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
