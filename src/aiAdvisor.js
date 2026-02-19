/* AI Advisor for SimCit - Strategy Engine (Source-Code-Aware Edition)
 *
 * This AI has been designed with full knowledge of the simulation internals:
 *
 * === TAX TABLE (valves.js) ===
 * Index = min(cityTax + gameLevel, 20)
 * [200, 150, 120, 100, 80, 50, 30, 0, -10, -40, -100, ...]
 * Neutral point = index 7 → tax = 7 - gameLevel
 * Easy(0): neutral@7, Medium(1): neutral@6, Hard(2): neutral@5
 * Each point below neutral adds that bonus to ALL valve deltas every cycle.
 * Tax 0 on Easy = +200/cycle to all valves. Tax 9 on Easy = -40/cycle.
 *
 * === ZONE GROWTH (residential.js / commercial.js / industrial.js) ===
 * zoneScore = valve + locationScore
 * Growth if: zoneScore > -350 AND (zoneScore - 26380) > random16signed
 * P(growth) = (zoneScore + 6388) / 65536  (when zoneScore > -350)
 * Residential locationScore: (min(landValue-pollution,0)*32, cap 6000) - 3000
 * Pollution > 128 = residential HARD BLOCK
 * Zones assessed with 1-in-8 chance per scan cycle
 *
 * === SCORE (evaluation.js) ===
 * problemSum = crime + pollution + (landValue*0.7) + (tax*10) + traffic + unemployment + fire
 * baseScore = (250 - min(problemSum/3, 250)) * 4  → range 0-1000
 * Penalties: ×0.85 per demand cap, ×0.85 per valve < -1000
 * Score -= fireSeverity + cityTax (raw subtraction!)
 * Final = average(oldScore, newScore)
 *
 * === REVENUE (budget.js) ===
 * taxFund = floor(totalPop * landValueAvg / 120) * cityTax * FLevels[gameLevel]
 * FLevels = [1.4, 1.2, 0.8]  RLevels(road cost) = [0.7, 0.9, 1.2]
 *
 * === DEMAND CAPS (simulation.js) ===
 * resCap: resPop > 500 && stadiumPop === 0  → valve clamped to 0
 * indCap: indPop > 70 && seaportPop === 0
 * comCap: comPop > 100 && airportPop === 0
 *
 * === VALVE ACCUMULATION (valves.js) ===
 * employment = (comHist10[1] + indHist10[1]) / (resPop/8)  ← LAGGED data
 * migration = normalizedResPop * (employment - 1)
 * births = normalizedResPop * 0.02
 * resRatio = (projectedResPop / normalizedResPop - 1) * 600 + taxTable[z]
 * Valve += round(ratio), clamped to ±2000/±1500
 *
 * === LAND VALUE (blockMapUtils.js) ===
 * landValue = (34 - cityCentreDistance/2) * 4 + terrainDensity - pollution
 * Parks boost terrainDensity → higher land value → more revenue per capita
 * Crime > 190 → landValue -= 20
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
var TILES_PER_ZONE = 12;
var PLANT_OVERHEAD = 16;
var POWER_BUILD_THRESHOLD = 0.80;

// Employment balance targets
var EMPLOYMENT_LOW = 0.8;
var EMPLOYMENT_HIGH = 1.3;
var NUCLEAR_MIN_ZONES = 80;

// Exact tax table from valves.js — the AI knows the source code
var TAX_TABLE = [
  200, 150, 120, 100, 80, 50, 30, 0, -10, -40, -100,
  -150, -200, -250, -300, -350, -400, -450, -500, -550, -600
];

// Revenue multipliers by difficulty from budget.js
var F_LEVELS = [1.4, 1.2, 0.8];
// Road maintenance multipliers by difficulty
var R_LEVELS = [0.7, 0.9, 1.2];

function AIAdvisor(simulation, gameMap, blockMaps) {
  this.simulation = simulation;
  this.map = gameMap;
  this.blockMaps = blockMaps;

  this._plan = {
    initialized: false,
    gridOriginX: 0,
    gridOriginY: 0
  };

  // Track growth trends for predictive decisions
  this._lastTotalPop = 0;
  this._popGrowthRate = 0;
  this._ticksSinceSpecialCheck = 0;
}


// ---- Source-code-aware helper methods ----

// Get game difficulty level (0=Easy, 1=Medium, 2=Hard)
AIAdvisor.prototype._getGameLevel = function() {
  return this.simulation._gameLevel || 0;
};

// The EXACT neutral tax point where valve bonus = 0
// From valves.js: index = min(cityTax + gameLevel, 20), neutral is index 7
AIAdvisor.prototype._getNeutralTax = function() {
  return Math.max(0, 7 - this._getGameLevel());
};

// Get the valve growth bonus/penalty for a given tax rate
// This is what gets added to EVERY valve EVERY cycle
AIAdvisor.prototype._getTaxValveEffect = function(taxRate) {
  var index = Math.min(taxRate + this._getGameLevel(), 20);
  return TAX_TABLE[index];
};

// Project annual revenue at a given tax rate
// From budget.js: taxFund = floor(totalPop * landValueAvg / 120) * cityTax * FLevels
AIAdvisor.prototype._projectRevenue = function(taxRate) {
  var census = this.simulation._census;
  var level = this._getGameLevel();
  return Math.floor(Math.floor(census.totalPop * census.landValueAverage / 120) * taxRate * F_LEVELS[level]);
};

// Project total annual maintenance costs
AIAdvisor.prototype._projectMaintenance = function() {
  var census = this.simulation._census;
  var level = this._getGameLevel();
  var roadCost = (census.roadTotal * 1 + census.railTotal * 2) * R_LEVELS[level];
  var serviceCost = (census.policeStationPop + census.fireStationPop) * 100;
  return Math.floor(roadCost) + serviceCost;
};

// Calculate the score impact of current tax rate (from evaluation.js)
// problemData[TAXES] = cityTax * 10, plus score -= cityTax at end
AIAdvisor.prototype._getTaxScoreCost = function(taxRate) {
  // Tax contributes taxRate*10 to problem sum, which feeds into:
  // baseScore = (250 - min(sum/3, 250)) * 4
  // So each tax point costs ~10/3*4 = ~13.3 score points from problems
  // Plus score -= cityTax directly at the end
  // Total: ~14.3 score points per tax level
  return taxRate * 10 / 3 * 4 + taxRate;
};

// Estimate growth probability for a zone given current valve + location score
// From residential.js: P(growth) = (zoneScore + 6388) / 65536 when > -350
AIAdvisor.prototype._estimateGrowthProb = function(valve, locationScore) {
  var zoneScore = valve + locationScore;
  if (zoneScore <= -350) return 0;
  return Math.max(0, (zoneScore + 6388) / 65536);
};

// ---- City plan management ----

AIAdvisor.prototype._getPhase = function() {
  var census = this.simulation._census;
  var budget = this.simulation.budget;
  var totalZones = census.poweredZoneCount + census.unpoweredZoneCount;
  if (totalZones === 0) return 'bootstrap';
  if (census.totalPop < 50) return 'early';
  // Stay in growth longer if we have money to invest
  if (census.totalPop < 500 || (census.totalPop < 1000 && budget.totalFunds > 5000)) return 'growth';
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
  recommendations = recommendations.concat(this._analyzeParks(census, budget));
  recommendations = recommendations.concat(this._analyzeScoreOptimization(census, budget, valves));
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


// ---- Budget actions (FREE — always check first) ----
//
// The OLD AI used a naive tax=7/9/6 heuristic. The NEW AI knows:
// 1. Neutral tax depends on game level (7 on Easy, 6 on Medium, 5 on Hard)
// 2. Lower tax = valve growth bonus = faster zone development
// 3. Tax contributes ~14 score points per level (tax*10/3*4 + tax)
// 4. Revenue = pop * landValue / 120 * tax * FLevels[level]
// 5. Fast growth at low tax can yield MORE total revenue than slow growth at high tax
//
// Strategy: Use low taxes during growth (invest reserves in growth speed),
// raise to neutral once cash flow is needed, never go above neutral+2 even in emergency.

AIAdvisor.prototype._analyzeBudgetActions = function(budget, census) {
  var recs = [];
  var phase = this._getPhase();
  var neutralTax = this._getNeutralTax();

  // --- Smart tax calculation ---
  var optimalTax = neutralTax; // Default: neutral (zero valve effect)
  var maintenance = this._projectMaintenance();

  if (phase === 'bootstrap' || phase === 'early') {
    // Growth investment: low tax to maximize valve accumulation
    // Tax 0 on Easy = +200/cycle bonus to all valves!
    // We have starting funds ($20k) to burn through
    if (budget.totalFunds > 8000) {
      optimalTax = Math.max(0, neutralTax - 4); // Aggressive growth
    } else if (budget.totalFunds > 4000) {
      optimalTax = Math.max(0, neutralTax - 2); // Moderate growth
    } else {
      optimalTax = neutralTax; // Preserve funds
    }
  } else if (phase === 'growth') {
    // Balance growth speed vs revenue need
    var annualRevenue = this._projectRevenue(neutralTax);
    var surplus = annualRevenue - maintenance;

    if (budget.totalFunds > 10000 && surplus > 0) {
      // Flush with cash and profitable — invest in growth
      optimalTax = Math.max(0, neutralTax - 3);
    } else if (budget.totalFunds > 5000 && surplus > -200) {
      optimalTax = Math.max(0, neutralTax - 2);
    } else if (budget.totalFunds > 2000) {
      optimalTax = Math.max(0, neutralTax - 1);
    } else if (budget.totalFunds < 500) {
      // Emergency: go above neutral but not too far (score penalty)
      optimalTax = Math.min(neutralTax + 2, 10);
    }
  } else {
    // Metro phase: optimize for score + sustainability
    var annualRevenue = this._projectRevenue(neutralTax);
    var surplus = annualRevenue - maintenance;

    if (budget.totalFunds < 1000 || surplus < -500) {
      // Need cash, but cap at neutral+2 to limit score damage
      optimalTax = Math.min(neutralTax + 2, 10);
    } else if (budget.totalFunds > 20000 && surplus > 1000) {
      // Rich city — lower tax for score bonus and continued growth
      optimalTax = Math.max(0, neutralTax - 2);
    } else if (budget.totalFunds > 8000) {
      optimalTax = Math.max(0, neutralTax - 1);
    }
    // else stay at neutral
  }

  // Clamp to valid range
  optimalTax = Math.max(0, Math.min(optimalTax, 20));

  if (budget.cityTax !== optimalTax) {
    var effect = this._getTaxValveEffect(optimalTax);
    var effectStr = effect > 0 ? '+' + effect : '' + effect;
    recs.push({
      priority: PRIORITIES.BUDGET_ADJUST,
      message: 'Tax ' + budget.cityTax + '% -> ' + optimalTax + '% (valve: ' + effectStr + '/cycle, ' +
        'score cost: ' + Math.round(this._getTaxScoreCost(optimalTax)) + ').',
      action: { type: 'set_tax', value: optimalTax }
    });
  }

  // --- Service funding optimization ---
  var totalMaintenance = budget.roadMaintenanceBudget + budget.fireMaintenanceBudget + budget.policeMaintenanceBudget;
  if (totalMaintenance > 0 && budget.totalFunds < totalMaintenance && census.totalPop > 0) {
    // Triage: roads first (score penalty for degradation), then fire, then police
    var targetRoad = Math.min(1.0, budget.totalFunds / Math.max(1, budget.roadMaintenanceBudget));
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

  // OLD AI waited for positive cash flow in early phase — WRONG.
  // With low taxes and $20k starting funds, we should INVEST in growth.
  // The faster zones develop, the sooner we get tax revenue.
  // Only stall if we're truly broke.
  if (phase === 'early' && budget.totalFunds < 800) {
    recs.push({
      priority: PRIORITIES.BUDGET_INFO,
      message: 'Low funds ($' + budget.totalFunds + '). Waiting for revenue.'
    });
    return recs;
  }

  // Phase-dependent reserve — more aggressive in early/growth phases
  // because growth speed compounds: more zones → more pop → more revenue
  var buildReserve = phase === 'early' ? 1000 :
                     phase === 'growth' ? 1500 :
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


// ---- Services (block-map-aware coverage analysis) ----
//
// From blockMapUtils.js:
//   crimeScore = (128 - landValue) + populationDensity - policeStationEffect
//   Police effect map smoothed 3x → effective radius ~15-20 tiles
//   Each station costs $100/yr maintenance — must justify with score benefit
//
// From evaluation.js:
//   problemData[CRIME] = crimeAverage (0-250)
//   Crime contributes crimeAvg/3*4 ≈ crimeAvg*1.33 to score penalty
//   So reducing crime average by 30 → ~40 point score improvement
//
// Strategy: Build first police/fire early (at pop 40+ instead of 60+),
// add more based on actual coverage gaps in high-density areas.

AIAdvisor.prototype._analyzeServices = function(census, budget) {
  var recs = [];
  var totalPop = census.totalPop;
  var phase = this._getPhase();
  var canAfford = budget.totalFunds >= 500 + MIN_RESERVE;

  // --- First police station: build earlier than old AI ---
  // Crime reduces land value → reduces revenue. Early station pays for itself.
  if (totalPop > 40 && census.policeStationPop === 0 && canAfford) {
    recs.push({
      priority: PRIORITIES.SERVICES + 12,
      message: 'Building first police station — crime prevention boosts land value.',
      action: { type: 'build', tool: 'police' }
    });
  }

  // --- First fire station: build proactively ---
  if (totalPop > 40 && census.fireStationPop === 0 && canAfford) {
    recs.push({
      priority: PRIORITIES.SERVICES + 11,
      message: 'Building first fire station — prevents catastrophic fire damage.',
      action: { type: 'build', tool: 'fire' }
    });
  }

  // --- Additional police based on actual coverage gaps ---
  // policeStationEffect map: 0=no coverage, 1000=max coverage
  // Crime contributes to score penalty AND reduces land value AND degrades zones
  if (census.crimeAverage > 80 && canAfford && census.policeStationPop > 0) {
    // Check if there are high-density areas with poor police coverage
    var worstCoverage = this._findWorstServiceCoverage('police');
    if (worstCoverage && worstCoverage.gap > 500) {
      recs.push({
        priority: PRIORITIES.SERVICES + 8,
        message: 'Crime high (avg ' + census.crimeAverage + '). Coverage gap at (' +
          worstCoverage.x + ',' + worstCoverage.y + '). Adding police.',
        action: { type: 'build', tool: 'police' }
      });
    }
  }

  // --- Active fire emergency ---
  if (census.firePop > 0) {
    if (census.fireStationPop === 0 && canAfford) {
      recs.push({
        priority: PRIORITIES.SERVICES + 15,
        message: census.firePop + ' active fires! Need fire station urgently.',
        action: { type: 'build', tool: 'fire' }
      });
    }
  }

  // --- Additional fire stations for coverage ---
  if (phase === 'metro' && canAfford && census.fireStationPop > 0) {
    var worstFire = this._findWorstServiceCoverage('fire');
    if (worstFire && worstFire.gap > 600) {
      recs.push({
        priority: PRIORITIES.SERVICES + 5,
        message: 'Fire coverage gap detected. Adding fire station.',
        action: { type: 'build', tool: 'fire' }
      });
    }
  }

  return recs;
};

// Find highest-population area with worst service coverage
AIAdvisor.prototype._findWorstServiceCoverage = function(serviceType) {
  var blockMaps = this.blockMaps;
  var effectMap = serviceType === 'police' ? blockMaps.policeStationEffectMap : blockMaps.fireStationEffectMap;
  var popMap = blockMaps.populationDensityMap;
  var worstScore = -Infinity;
  var result = null;

  for (var y = 4; y < this.map.height - 4; y += 8) {
    for (var x = 4; x < this.map.width - 4; x += 8) {
      var pop = this._safeBlockGet(popMap, x, y);
      if (pop < 20) continue; // Only care about populated areas
      var effect = this._safeBlockGet(effectMap, x, y);
      var gap = 1000 - effect; // 0=full coverage, 1000=no coverage
      var score = gap + pop * 2; // Weight by population
      if (score > worstScore) {
        worstScore = score;
        result = { x: x, y: y, gap: gap, pop: pop };
      }
    }
  }

  return result;
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


// ---- Special buildings (PROACTIVE — source-code-aware cap thresholds) ----
//
// From simulation.js:
//   resCap: resPop > 500 && stadiumPop === 0  → valve forced to 0, score ×0.85
//   indCap: indPop > 70  && seaportPop === 0  → valve forced to 0, score ×0.85
//   comCap: comPop > 100 && airportPop === 0  → valve forced to 0, score ×0.85
//
// OLD AI: build only AFTER cap hits. NEW AI: build BEFORE cap hits.
// Each cap costs 15% of score. Building early prevents lost growth cycles.

AIAdvisor.prototype._analyzeSpecialBuildings = function(census, budget) {
  var recs = [];
  var valves = this.simulation._valves;

  // --- Stadium: resPop threshold is 500 ---
  if (census.stadiumPop === 0) {
    if (census.resPop > 500) {
      // CAP IS ACTIVE — urgent, growth is being blocked right now
      if (budget.totalFunds >= 5000 + MIN_RESERVE) {
        recs.push({
          priority: PRIORITIES.SPECIAL_BUILDINGS + 20,
          message: 'URGENT: Res growth CAPPED (resPop ' + census.resPop + '/500). Stadium needed NOW.',
          action: { type: 'build', tool: 'stadium' }
        });
      } else {
        recs.push({
          priority: PRIORITIES.SPECIAL_BUILDINGS + 15,
          message: 'Res growth CAPPED! Saving for stadium ($5000). Have $' + budget.totalFunds + '.'
        });
      }
    } else if (census.resPop > 350) {
      // Approaching cap — start saving / build preemptively
      if (budget.totalFunds >= 5000 + COMFORTABLE_FUNDS) {
        recs.push({
          priority: PRIORITIES.SPECIAL_BUILDINGS + 10,
          message: 'Res approaching cap (' + census.resPop + '/500). Building stadium early.',
          action: { type: 'build', tool: 'stadium' }
        });
      } else {
        recs.push({
          priority: PRIORITIES.BUDGET_INFO + 5,
          message: 'Save for stadium! Res at ' + census.resPop + '/500 cap. Need $5000.'
        });
      }
    }
  }

  // --- Seaport: indPop threshold is 70 ---
  if (census.seaportPop === 0) {
    if (census.indPop > 70) {
      if (budget.totalFunds >= 3000 + MIN_RESERVE) {
        recs.push({
          priority: PRIORITIES.SPECIAL_BUILDINGS + 20,
          message: 'URGENT: Ind growth CAPPED (indPop ' + census.indPop + '/70). Seaport needed NOW.',
          action: { type: 'build', tool: 'port' }
        });
      } else {
        recs.push({
          priority: PRIORITIES.SPECIAL_BUILDINGS + 15,
          message: 'Ind growth CAPPED! Saving for seaport ($3000).'
        });
      }
    } else if (census.indPop > 45) {
      if (budget.totalFunds >= 3000 + COMFORTABLE_FUNDS) {
        recs.push({
          priority: PRIORITIES.SPECIAL_BUILDINGS + 8,
          message: 'Ind approaching cap (' + census.indPop + '/70). Building seaport early.',
          action: { type: 'build', tool: 'port' }
        });
      }
    }
  }

  // --- Airport: comPop threshold is 100 ---
  if (census.airportPop === 0) {
    if (census.comPop > 100) {
      if (budget.totalFunds >= 10000 + MIN_RESERVE) {
        recs.push({
          priority: PRIORITIES.SPECIAL_BUILDINGS + 20,
          message: 'URGENT: Com growth CAPPED (comPop ' + census.comPop + '/100). Airport needed NOW.',
          action: { type: 'build', tool: 'airport' }
        });
      } else {
        recs.push({
          priority: PRIORITIES.SPECIAL_BUILDINGS + 15,
          message: 'Com growth CAPPED! Saving for airport ($10000).'
        });
      }
    } else if (census.comPop > 65) {
      if (budget.totalFunds >= 10000 + COMFORTABLE_FUNDS) {
        recs.push({
          priority: PRIORITIES.SPECIAL_BUILDINGS + 8,
          message: 'Com approaching cap (' + census.comPop + '/100). Building airport early.',
          action: { type: 'build', tool: 'airport' }
        });
      } else {
        recs.push({
          priority: PRIORITIES.BUDGET_INFO + 5,
          message: 'Save for airport! Com at ' + census.comPop + '/100 cap. Need $10000.'
        });
      }
    }
  }

  return recs;
};


// ---- Strategic park placement (land value → revenue feedback loop) ----
//
// From blockMapUtils.js:
//   landValue = (34 - dist/2)*4 + terrainDensity - pollution
//   Parks increase terrainDensity at their location
// From budget.js:
//   taxFund = floor(totalPop * landValueAvg / 120) * cityTax * FLevels
// So parks → higher landValueAvg → more revenue per capita.
// At $25/park with no maintenance, parks have infinite ROI.
//
// From evaluation.js:
//   problemData[HOUSING] = landValueAverage * 7/10
// WARNING: Higher land value = MORE housing complaints!
// But the revenue benefit outweighs this — housing problem is low-weight.

AIAdvisor.prototype._analyzeParks = function(census, budget) {
  var recs = [];
  var phase = this._getPhase();

  // Only recommend parks when we have surplus funds
  if (phase === 'bootstrap' || phase === 'early') return recs;
  if (budget.totalFunds < 2000) return recs;

  // Parks are most valuable in metro phase for revenue optimization
  var priority = phase === 'metro' ? PRIORITIES.PARKS + 10 : PRIORITIES.PARKS;

  // Find best park location: high population density + near roads + low existing terrain
  var bestScore = -Infinity;
  var bestX = -1, bestY = -1;
  var map = this.map;
  var blockMaps = this.blockMaps;

  for (var y = 2; y < map.height - 2; y += 3) {
    for (var x = 2; x < map.width - 2; x += 3) {
      if (map.getTileValue(x, y) !== 0) continue; // Must be empty dirt

      var pop = this._safeBlockGet(blockMaps.populationDensityMap, x, y);
      if (pop < 10) continue;

      var score = pop * 2;
      if (this._hasNearbyRoad(x, y, 2)) score += 30;
      else continue; // Parks without road access don't help much
      if (this._hasNearbyResidential(x, y, 4)) score += 40;

      // Prefer areas with lower existing land value (more room to improve)
      var lv = this._safeBlockGet(blockMaps.landValueMap, x, y);
      if (lv < 100) score += 20;

      if (score > bestScore) {
        bestScore = score;
        bestX = x;
        bestY = y;
      }
    }
  }

  if (bestX !== -1) {
    recs.push({
      priority: priority,
      message: 'Strategic park placement — boosts land value and revenue.',
      action: { type: 'build_park', x: bestX, y: bestY }
    });
  }

  return recs;
};


// ---- Score optimization engine (direct problem-score reasoning) ----
//
// From evaluation.js, score is dominated by 7 problem categories:
//   CRIME: crimeAverage (0-250)        → ~1.33 score per point
//   POLLUTION: pollutionAverage (0-255) → ~1.33 score per point
//   HOUSING: landValueAvg * 0.7         → ~0.93 score per point
//   TAXES: cityTax * 10                 → ~1.33 score per tax level
//   TRAFFIC: trafficAvg * 2.4           → ~3.2 score per traffic point
//   UNEMPLOYMENT: complex formula       → ~1.33 score per point
//   FIRE: firePop * 5                   → ~6.67 score per fire
//
// Plus multiplicative penalties:
//   ×0.85 per demand cap (up to 3 = ×0.614)
//   ×0.85 per valve < -1000 (up to 3 = ×0.614)
//   Score -= fireSeverity + cityTax (raw subtraction)
//   Score × powered_ratio

AIAdvisor.prototype._analyzeScoreOptimization = function(census, budget, valves) {
  var recs = [];
  var eval_ = this.simulation.evaluation;
  if (!eval_ || census.totalPop < 100) return recs;

  // Identify the biggest score drains and recommend specific fixes

  // Check for valve collapse penalties (×0.85 each, devastating)
  if (valves.resValve < -1000) {
    recs.push({
      priority: PRIORITIES.BUDGET_INFO + 10,
      message: 'SCORE DRAIN: Res valve collapsed (' + valves.resValve +
        '). -15% score! Build commercial/industrial for jobs.'
    });
  }
  if (valves.comValve < -1000) {
    recs.push({
      priority: PRIORITIES.BUDGET_INFO + 10,
      message: 'SCORE DRAIN: Com valve collapsed (' + valves.comValve +
        '). -15% score! Build residential for workers.'
    });
  }
  if (valves.indValve < -1000) {
    recs.push({
      priority: PRIORITIES.BUDGET_INFO + 10,
      message: 'SCORE DRAIN: Ind valve collapsed (' + valves.indValve +
        '). -15% score! Build residential for workers.'
    });
  }

  // Check unpowered zone ratio — score multiplied by powered/(powered+unpowered)
  if (census.unpoweredZoneCount > 2) {
    var total = census.poweredZoneCount + census.unpoweredZoneCount;
    var ratio = census.poweredZoneCount / total;
    if (ratio < 0.95) {
      var scoreLoss = Math.round((1 - ratio) * 100);
      recs.push({
        priority: PRIORITIES.WIRE_CONNECT + 5,
        message: 'SCORE DRAIN: ' + census.unpoweredZoneCount + ' unpowered zones = -' +
          scoreLoss + '% score. Fix power connections!',
        action: { type: 'wire_connect' }
      });
    }
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


// ---- Zone scoring (source-code-aware growth probability) ----
//
// Key insight from residential.js:
//   locationScore = min((landValue - pollution) * 32, 6000) - 3000
//   zoneScore = valve + locationScore
//   P(growth) = (zoneScore + 6388) / 65536 when zoneScore > -350
//
// So the AI should pick locations that maximize actual growth probability,
// not just abstract "desirability". A zone with P(growth)=15% develops
// 50% faster than one with P(growth)=10%.
//
// From blockMapUtils.js:
//   landValue = (34 - cityCentreDistance/2) * 4 + terrainDensity - pollution
// So distance from center and pollution are the dominant land value factors.

AIAdvisor.prototype._scoreZoneLocation = function(x, y, toolName) {
  var score = 0;
  var blockMaps = this.blockMaps;

  // Road adjacency is critical — from simulation source:
  // zones without road access fail traffic check → DEGRADE
  if (this._hasNearbyRoad(x, y, 2)) score += 150;
  else if (this._hasNearbyRoad(x, y, 4)) score += 60;
  else if (this._hasNearbyRoad(x, y, 8)) score += 10;
  else return -9999;

  // Power connectivity — unpowered zones get -500 to zoneScore
  // which drops growth probability significantly
  if (this._hasNearbyPower(x, y, 4)) score += 50;
  else if (this._hasNearbyPower(x, y, 8)) score += 20;
  else score -= 30; // Will need wire run, slight penalty

  // Grid alignment bonus
  if (this._isGridAligned(x, y)) score += 40;

  var landValue = this._safeBlockGet(blockMaps.landValueMap, x, y);
  var pollution = this._safeBlockGet(blockMaps.pollutionDensityMap, x, y);
  var crime = this._safeBlockGet(blockMaps.crimeRateMap, x, y);
  var traffic = this._safeBlockGet(blockMaps.trafficDensityMap, x, y);
  var popDensity = this._safeBlockGet(blockMaps.populationDensityMap, x, y);

  // HARD POSITIONAL DISTRICT RULES
  if (this._plan.initialized) {
    var gridY = this._plan.gridOriginY;
    if (toolName === 'residential' && y > gridY) return -9999;
    if (toolName === 'industrial' && y <= gridY) return -9999;
  }

  switch (toolName) {
    case 'residential':
      // From residential.js: pollution > 128 = zone CANNOT grow at all
      // Use 80 threshold for safety margin (pollution can spread)
      if (pollution > 80) return -9999;
      if (this._hasNearbyIndustrial(x, y, DISTRICT_RADIUS)) return -9999;

      // Compute actual locationScore from source code formula:
      // evalResidential = min((landValue - pollution) * 32, 6000) - 3000
      var netValue = landValue - pollution;
      if (netValue < 0) netValue = 0;
      var locationScore = Math.min(netValue * 32, 6000) - 3000;

      // Factor in actual growth probability
      var resValve = this.simulation._valves.resValve;
      var growthProb = this._estimateGrowthProb(resValve, locationScore);
      // Scale: 10% prob → +100 score, 15% → +150, etc
      score += Math.round(growthProb * 1000);

      score -= crime * 2;
      score -= traffic;
      if (this._hasNearbyResidential(x, y, 6)) score += 80;
      // Traffic routing: must reach jobs within ~30 tiles
      if (this._hasNearbyCommercial(x, y, 15) || this._hasNearbyIndustrial(x, y, 25)) score += 30;
      else score -= 50; // Will fail traffic check → degradation
      break;

    case 'commercial':
      // Commercial uses cityCentreDistScoreMap as locationScore (-64 to 64)
      if (pollution > 128) return -9999;
      score += landValue * 3;
      score -= pollution * 2;
      if (this._hasNearbyResidential(x, y, 10)) score += 50;
      else score -= 40;
      if (this._hasNearbyCommercial(x, y, 6)) score += 60;
      // Commercial locationScore is distance-based — closer to center is better
      var cdx = x - this.map.cityCentreX;
      var cdy = y - this.map.cityCentreY;
      var dist = Math.sqrt(cdx * cdx + cdy * cdy);
      score += Math.max(0, 64 - Math.floor(dist)); // Mirror cityCentreDistScoreMap
      if (this._plan.initialized) {
        score -= Math.abs(y - this._plan.gridOriginY) * 3;
      }
      break;

    case 'industrial':
      if (this._hasNearbyResidential(x, y, DISTRICT_RADIUS)) return -9999;
      // Industrial doesn't care about land value or pollution
      // but must be reachable from residential for traffic routing
      score -= landValue; // Prefer cheap land
      score += 30;
      if (this._hasNearbyIndustrial(x, y, 6)) score += 80;
      if (this._hasNearbyResidential(x, y, 25)) score += 20;
      else score -= 30; // Traffic routing will fail
      break;

    case 'police':
      // Place where coverage gap × population is highest
      var policeEffect = this._safeBlockGet(blockMaps.policeStationEffectMap, x, y);
      score += (1000 - policeEffect);
      score += crime * 3; // Weight crime more — direct score impact
      score += popDensity * 2;
      if (this._hasNearbyBuilding(x, y, TileValues.POLICESTATION, 15)) score -= 400;
      break;

    case 'fire':
      var fireEffect = this._safeBlockGet(blockMaps.fireStationEffectMap, x, y);
      score += (1000 - fireEffect);
      score += popDensity * 2;
      if (this._hasNearbyBuilding(x, y, TileValues.FIRESTATION, 15)) score -= 400;
      break;
  }

  // Prefer closer to city center — from blockMapUtils.js:
  // landValue = (34 - cityCentreDistance/2) * 4 + terrain - pollution
  // So center proximity is already baked into land value, but add small bonus
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
