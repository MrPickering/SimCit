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
// Mirrors traffic.js's own MAX_TRAFFIC_DISTANCE: the engine's traffic routing gives
// up searching for a job/destination beyond this many tiles, so a residential zone
// further than this from any job zone can never actually grow.
var MAX_TRAFFIC_DISTANCE = 30;

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

  // Need area for T-grid: 15 wide x 15 tall (x: gx-7..gx+7, y: gy-3..gy+11 — the
  // coal plant lands as far out as gy+9, occupying up to roughly gy+11 as a 4x4).
  // There used to be a "smaller fallback" here checking only 13x12 (x: gx-6..gx+6,
  // y: gy-3..gy+8) — narrower AND shorter than what _buildStarterCity actually
  // builds. It never built a correspondingly smaller city; it just let the same
  // fixed offsets (including the coal plant at gy+9, past the fallback's verified
  // gy+8 edge) place tools on unverified — sometimes out-of-bounds — tiles. On a
  // small (60x50) map, confirmed this crashes the whole simulation (GameMap.getTile
  // reading a corrupted/undefined tile in a later mapScan pass). Removed: if the
  // full 15x15 footprint doesn't fit anywhere near centre, there's no safe smaller
  // plan to fall back to with these fixed offsets, so return null and let the AI
  // wait/retry rather than build somewhere it can't actually verify is safe.
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


// ---- Budget actions (FREE) ----

AIAdvisor.prototype._analyzeBudgetActions = function(budget, census) {
  var recs = [];

  // NOTE: tried escalating tax rate up to 18% in response to sustained negative
  // cashFlow (on the theory that a structural deficit needs more revenue, not just
  // waiting it out at the 9% low-funds tier). Verified in testing this is actively
  // harmful and reverted: SimCity's RCI demand valves are very sensitive to tax rate,
  // so pushing tax that high suppresses growth hard enough to crash population
  // (dropped a CITY-class city back to TOWN class, oscillating with permanent
  // negative cashflow for the rest of a 500-year run) — the tax hike caused the very
  // revenue collapse it was meant to fix. A commercial-oversupply/negative-cashflow
  // situation needs to be fixed on the spending or zoning side, not by taxing the
  // remaining tax base into leaving.
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
  //
  // The valve thresholds here used to require > 100 before building anything, which
  // sounds like a reasonable "wait for real demand" guard but in practice caused
  // growth to freeze solid for hundreds of simulated years: confirmed in testing that
  // the simulation's own RCI valves settle into an equilibrium well under 100 for
  // long stretches even with abundant unused funds (tens of thousands of dollars
  // sitting idle) and plenty of open, buildable land — the valve model just doesn't
  // reliably spike above 100 once a city reaches a certain size and tax rate. Any
  // positive valve at all (still gated by the employment-ratio checks above and the
  // reserve/power checks below, so this can't overspend or outrun infrastructure) is
  // a genuine, if modest, demand signal worth acting on rather than sitting idle.
  var buildChoices = [];

  if (valves.resValve > 0) {
    buildChoices.push({ tool: 'residential', priority: valves.resValve / 100 });
  }
  if (valves.comValve > 0) {
    buildChoices.push({ tool: 'commercial', priority: valves.comValve / 75 });
  }
  if (valves.indValve > 0) {
    buildChoices.push({ tool: 'industrial', priority: valves.indValve / 75 });
  }

  // Surplus-funds fallback: if no valve is even modestly positive but cash is piling
  // up well beyond the reserve (nothing productive to spend it on), that's the city
  // sitting idle rather than growing — pick whichever zone type is least oversupplied
  // and try it anyway. An idle treasury is worse than a slightly-early zone.
  if (buildChoices.length === 0 && budget.totalFunds > buildReserve * 5) {
    var candidates = [
      { tool: 'residential', valve: valves.resValve },
      { tool: 'commercial', valve: valves.comValve },
      { tool: 'industrial', valve: valves.indValve }
    ];
    candidates.sort(function(a, b) { return b.valve - a.valve; });
    if (candidates[0].valve > -500) {
      buildChoices.push({ tool: candidates[0].tool, priority: 0.5 });
    }
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

  // Zero coverage gets a much higher priority than routine services maintenance
  // (PRIORITIES.SERVICES + 10, below ZONE_DEMAND/ROAD_CONNECT/WIRE_CONNECT) — that
  // tier meant this recommendation, however urgent-sounding, would only ever get
  // tried on a tick where zone-building, road-connecting, AND wire-connecting all
  // failed, which in a healthy growing city is close to never. Confirmed in testing:
  // policeStationPop/fireStationPop stayed at 0 for 200+ simulated years despite
  // funds being ample and findBestZoneLocation('police') returning a perfectly good
  // spot every time it was checked — the recommendation was correct, it just never
  // got a turn. Crime directly reduces land value (see blockMapUtils.js's
  // pollutionTerrainLandValueScan, -20 for high crime), and land value is what
  // gates zone growth (residential.js's growZone), so going without ANY police/fire
  // coverage for centuries was quietly capping how big the city could ever get.
  if (totalPop > 60 && census.policeStationPop === 0 && canAfford) {
    recs.push({
      priority: PRIORITIES.ROAD_CONNECT + 5,
      message: 'No police! Crime rising. Building station ($500).',
      action: { type: 'build', tool: 'police' }
    });
  }

  if (totalPop > 60 && census.fireStationPop === 0 && canAfford) {
    recs.push({
      priority: PRIORITIES.ROAD_CONNECT + 5,
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


// Find road positions to extend the network into open territory, creating fresh
// buildable frontier once the easily-reachable area near the existing grid fills up.
// The old version only ever tried two fixed offsets relative to the original starter
// grid's exact origin, so it stopped working the moment those two specific slots were
// taken or blocked by terrain — in practice it succeeded well under 1% of the time and
// zone building would permanently stall once the initial grid was full. This instead
// scans the whole map for ANY existing road tile with a run of open ground extending
// outward from it in a cardinal direction, so it keeps working regardless of terrain
// or however organically the city has actually grown. It still prefers extending on
// the district-correct side of the main road (north for residential, south for
// industrial) when a grid orientation is known, but that's a scoring preference, not
// a hard requirement, so it degrades gracefully instead of failing outright.
AIAdvisor.prototype.findGridExpansionRoads = function(zoneType) {
  var map = this.map;
  var width = map.width;
  var height = map.height;
  var gy = this._plan.initialized ? this._plan.gridOriginY : null;
  var dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  var STUB_LENGTH = 10;
  var CROSS_LENGTH = 6;

  // Includes open water: roadTool can lay a bridge one tile at a time as long as
  // the neighboring tile is already a placed road — this function already builds
  // sequentially outward from a known existing road (step 1, 2, 3, ... in order,
  // and _expandGrid places them in that same order), so unlike the reconnection
  // pathfinders (findRoadPath etc.) no reordering is needed here for the bridge
  // mechanic to work. Without this, a land pocket separated from the rest of a map
  // by even a single river tile was permanently unreachable for NEW zone building —
  // confirmed via a terrain census showing 40%+ of some maps sitting unused, split
  // off by water, while the AI's own connected territory had fully saturated.
  var isBuildable = function(x, y) {
    if (x < 2 || y < 2 || x >= width - 2 || y >= height - 2) return false;
    var tv = map.getTileValue(x, y);
    return tv === TileValues.DIRT || TileUtils.canBulldoze(tv) ||
      (tv >= TileValues.WATER_LOW && tv <= TileValues.WATER_HIGH);
  };

  var extendLine = function(fromX, fromY, dx, dy, length) {
    var line = [];
    for (var step = 1; step <= length; step++) {
      var nx = fromX + dx * step;
      var ny = fromY + dy * step;
      if (!isBuildable(nx, ny)) break;
      line.push({ x: nx, y: ny });
    }
    return line;
  };

  var best = null;
  var bestScore = -Infinity;

  for (var y = 2; y < height - 2; y++) {
    for (var x = 2; x < width - 2; x++) {
      if (!TileUtils.isRoad(map.getTileValue(x, y))) continue;

      for (var d = 0; d < dirs.length; d++) {
        var dx = dirs[d][0];
        var dy = dirs[d][1];
        var stub = extendLine(x, y, dx, dy, STUB_LENGTH);
        if (stub.length < 4) continue;

        // If the stub is still over water at its far end, it's a bridge that
        // doesn't reach anywhere useful yet (no shore to build zones on within the
        // length budget) — skip it rather than spend the cost on a dead-end pier.
        var lastTv = map.getTileValue(stub[stub.length - 1].x, stub[stub.length - 1].y);
        if (lastTv >= TileValues.WATER_LOW && lastTv <= TileValues.WATER_HIGH) continue;

        // Require genuine lateral clearance at the midpoint, not just a 1-tile-wide
        // corridor: a thin gap between two existing buildings can easily satisfy "4
        // consecutive open tiles" without ever having room for an actual 3x3 zone
        // next to it. Without this check the search kept finding and re-stubbing
        // those dead corridors near the centre (where "prefer closer to centre"
        // scoring wants to build) instead of ever reaching a spot with real room —
        // confirmed in testing this caused zone building to freeze solid for 100+
        // simulated years with over half the map still open. Checking for open
        // ground on both sides of the midpoint is what actually distinguishes a
        // buildable pocket from a dead-end sliver, which is a more direct fix than
        // avoiding the city centre altogether (land value in this engine decays with
        // distance from the map's centre point, so pushing expansion away from it —
        // which an earlier version of this function did — quietly caps how much any
        // zone built out there can ever grow).
        // Only one side needs to be open (a zone can back onto the existing road's
        // other neighbor or an already-built structure on the far side) — requiring
        // both sides turned out to reject essentially every candidate on the whole
        // map once the city was reasonably built up, freezing expansion entirely.
        var mid = stub[Math.floor(stub.length / 2)];
        if (!isBuildable(mid.x + dy, mid.y + dx) && !isBuildable(mid.x - dy, mid.y - dx)) {
          continue;
        }

        // Don't push the residential frontier out past commuting range: findBestZoneLocation
        // hard-rejects any residential candidate beyond MAX_TRAFFIC_DISTANCE from a job
        // zone, so a stub built further out than that is land nothing can ever actually
        // be placed on — confirmed in testing to create a permanent deadlock where
        // expansion keeps "succeeding" by building road into the distance while zone
        // placement keeps failing on that same land forever, each reinforcing the other.
        if (zoneType === 'residential') {
          var endPos = stub[stub.length - 1];
          var hasJobsAlready = this.simulation._census.comZonePop > 0 || this.simulation._census.indZonePop > 0;
          if (hasJobsAlready &&
              !this._hasNearbyCommercial(endPos.x, endPos.y, MAX_TRAFFIC_DISTANCE) &&
              !this._hasNearbyIndustrial(endPos.x, endPos.y, MAX_TRAFFIC_DISTANCE)) {
            continue;
          }
        }

        var score = 0;
        var endY = stub[stub.length - 1].y;
        if (gy !== null) {
          if (zoneType === 'residential' && endY <= gy) score += 100;
          if (zoneType === 'industrial' && endY > gy) score += 100;
        }
        // No distance-from-centre term here, deliberately, after testing both
        // directions found a real conflict with no clean winner: land value decays
        // with distance from map.cityCentreX/Y (blockMapUtils.js's
        // pollutionTerrainLandValueScan), so "prefer closer" grows each zone denser,
        // but cityPop sums population across ALL zones (not an average), so "prefer
        // farther" reaches more total zones' worth of land on a large map. Testing
        // showed farther expansion also strains the power grid harder — the
        // engine's power-flood algorithm (powerManager.js) has its own tile-traversal
        // budget independent of plant capacity, and a more spread-out, farther-flung
        // road/wire network hits that ceiling sooner, leaving a larger fraction of
        // zones permanently unpowered (confirmed up to 41% in one run) — which then
        // barely contribute anything anyway (growZone hard-penalizes unpowered
        // zones). Neither extreme reliably won across test runs, so the distance
        // term is left out; the lateral-clearance check above (not distance) is what
        // actually prevents re-stubbing the same dead corridor forever.

        if (score > bestScore) {
          bestScore = score;
          // A single one-tile-wide stub only ever exposes one new road-adjacent edge
          // — barely enough for a single zone slot before the frontier is used up
          // again. Cap the far end with a perpendicular cross-road in both
          // directions so one successful expansion opens up a proper block (3 new
          // road edges instead of 1), roughly matching what the original starter
          // grid gave the AI for free — this is what actually keeps zone-building
          // supplied with fresh slots instead of stalling out once the easily
          // reachable land near the existing roads is used up.
          var end = stub[stub.length - 1];
          var perp1 = extendLine(end.x, end.y, dy, dx, CROSS_LENGTH);
          var perp2 = extendLine(end.x, end.y, -dy, -dx, CROSS_LENGTH);
          best = stub.concat(perp1, perp2);
        }
      }
    }
  }

  return best;
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


// Generic breadth-first search over the tile grid. `canTraverse(tv, tile)` gates
// which tiles the search is allowed to step through; `isGoal(x, y, tv, tile)` decides
// when we've arrived (checked on every neighbor, even ones canTraverse rejects, so a
// goal tile that fails canTraverse — e.g. an existing road when we're routing wire
// through dirt/road tiles only — still terminates the search). Unlike the old greedy
// steppers (move toward target, give up on the first double-blocked tile), this finds
// an actual shortest path or correctly reports "unreachable" — needed because real
// city layouts are full of dead ends a straight-line walk can't route around.
// Returns an array of {x, y} steps from just after the start through the goal
// (exclusive of the start tile itself), or null if no goal was reached within
// maxNodes expansions.
AIAdvisor.prototype._bfsPath = function(startX, startY, canTraverse, isGoal, maxNodes) {
  // Default to full map coverage: a sprawling city can easily have a genuinely
  // reachable connection point 60+ tiles away, and an artificially low cap makes a
  // solvable case look "unreachable". Dictionary-based BFS over even the largest map
  // size here (240x200 = 48000 tiles) is still cheap — this only runs when the AI is
  // actually trying to fix a specific disconnected zone, not on every tick.
  maxNodes = maxNodes || (this.map.width * this.map.height);
  var map = this.map;
  var visited = {};
  visited[startX + ',' + startY] = true;
  var queue = [{ x: startX, y: startY, prev: null }];
  var dirs = [[0, -1], [1, 0], [0, 1], [-1, 0]];

  for (var head = 0; head < queue.length && head < maxNodes; head++) {
    var node = queue[head];

    for (var d = 0; d < dirs.length; d++) {
      var nx = node.x + dirs[d][0];
      var ny = node.y + dirs[d][1];
      if (nx < 0 || ny < 0 || nx >= map.width || ny >= map.height) continue;

      var key = nx + ',' + ny;
      if (visited[key]) continue;
      visited[key] = true;

      var ntv = map.getTileValue(nx, ny);
      var ntile = map.getTile(nx, ny);
      var next = { x: nx, y: ny, prev: node };

      if (isGoal(nx, ny, ntv, ntile)) {
        var path = [];
        for (var cur = next; cur; cur = cur.prev) {
          if (cur.x === startX && cur.y === startY) break;
          path.unshift({ x: cur.x, y: cur.y });
        }
        return path;
      }

      if (canTraverse(ntv, ntile)) queue.push(next);
    }
  }

  return null;
};


// Includes open water: roadTool.layRoad can lay a bridge over water (see
// roadTool.js), one tile at a time, as long as the tile on one side is already a
// placed road/bridge — so water is traversable for pathfinding purposes, it just
// needs the resulting path built in the right order (see findRoadPath below).
// Without this, a land pocket separated from the rest of the city by so much as a
// single river tile was permanently unreachable — confirmed in testing this leaves
// large stretches of a map (sometimes 40%+ of all open land) forever unused even
// with abundant funds and zone demand, because the AI never even considered
// building the bridge that would have connected it.
var isOpenRoadOrWater = function(tv) {
  return tv === TileValues.DIRT || TileUtils.canBulldoze(tv) || TileUtils.isRoad(tv) ||
    (tv >= TileValues.WATER_LOW && tv <= TileValues.WATER_HIGH);
};


AIAdvisor.prototype.findRoadPath = function(fromX, fromY, toX, toY) {
  var map = this.map;
  var isGoal = function(x, y, tv) {
    return (x === toX && y === toY) || TileUtils.isRoad(tv);
  };
  var path = this._bfsPath(fromX, fromY, function(tv) { return isOpenRoadOrWater(tv); }, isGoal);
  if (!path) return [];
  // roadTool's bridge mechanic only succeeds if the tile on one side is already a
  // placed road — path[] runs from the disconnected point to the existing road, so
  // building in that order tries to bridge outward from open water into nothing.
  // Reversed, each new tile (working backward from the existing road toward the
  // disconnected point) always has a just-placed road neighbor behind it.
  path.reverse();
  // Only the tiles that actually need a road laid — drop any pre-existing road
  // (typically the goal itself, when we routed toward an existing junction).
  return path.filter(function(pos) {
    return !TileUtils.isRoad(map.getTileValue(pos.x, pos.y));
  });
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

      var path = this._bfsPath(x, y,
        function(tv) { return isOpenRoadOrWater(tv); },
        function(nx, ny, tv) { return TileUtils.isRoad(tv); });
      // See findRoadPath: a bridge can only be placed one tile at a time working
      // outward from an already-placed road, so build in that order (from the
      // existing road back toward the disconnected zone), not the BFS discovery order.
      if (path && path.length > 0) return path.reverse();
    }
  }

  return null;
};


// Find wire path to connect unpowered zones. The goal is "any tile that is actually
// powered" (not merely conductive) — a conductive tile can belong to a dead wire
// island that never made it back to a plant, and routing to one of those would just
// extend the same disconnected island instead of fixing anything.
AIAdvisor.prototype.findWireToConnect = function() {
  var map = this.map;
  var width = map.width;
  var height = map.height;

  for (var y = 1; y < height - 1; y++) {
    for (var x = 1; x < width - 1; x++) {
      var tile = map.getTile(x, y);
      if (!tile.isZone()) continue;
      if (tile.isPowered()) continue;

      var path = this._findWirePath(x, y);
      if (path && path.length > 0) return path;
    }
  }

  return null;
};


// BFS to the nearest tile that is actually powered, over dirt/road/conductive tiles
// (routing back through existing — even dead — wire is fine; it just means that
// segment needs no new wire, filtered out below). Returns only the tiles that still
// need wire laid, or [] if the nearest powered tile needs no new wire at all (already
// fully conductive right up to it), or null if unreachable.
AIAdvisor.prototype._findWirePath = function(fromX, fromY) {
  var map = this.map;
  var canTraverse = function(tv, tile) {
    return isOpenRoadOrWater(tv) || tile.isConductive();
  };
  var isGoal = function(x, y, tv, tile) {
    return tile.isPowered();
  };
  var path = this._bfsPath(fromX, fromY, canTraverse, isGoal);
  if (!path) return null;
  // Same reasoning as findRoadPath: wireTool's water-crossing case also needs an
  // already-conductive neighbor to place the next tile, so build outward from the
  // powered end (path.length-1) back toward the zone, not BFS discovery order.
  path.reverse();
  return path.filter(function(pos) {
    return !map.getTile(pos.x, pos.y).isConductive();
  });
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

  // Local separation (the per-tool DISTRICT_RADIUS hard-reject below, plus the
  // residential job-distance hard-reject above) is what keeps industrial pollution
  // away from housing — not a single global north/south line through the original
  // starter grid's position. That absolute rule used to hard-reject any residential
  // zone south of the starter grid's exact Y coordinate (and any industrial zone
  // north of it) regardless of how far away or how the city had actually grown,
  // which caps total city size at whatever fits in one fixed-width band through the
  // starter location — confirmed in testing: growth consistently plateaued in the
  // low hundreds of zones on maps with room for a thousand-plus, because the AI
  // could never start a second residential/industrial cluster anywhere else on the
  // map. Local radius checks scale with the city instead of a single starting point.

  switch (toolName) {
    case 'residential':
      // HARD REJECT: pollution kills residential (degrades at > 128)
      if (pollution > 100) return -9999;
      // HARD REJECT: industrial within district radius
      if (this._hasNearbyIndustrial(x, y, DISTRICT_RADIUS)) return -9999;
      // HARD REJECT: no jobs within the engine's own traffic routing radius
      // (MAX_TRAFFIC_DISTANCE in traffic.js) means commuters can never actually reach
      // work from here, so the zone will sit at minimum population forever no matter
      // how good it otherwise scores. Exempt while the city has no jobs anywhere yet,
      // so the very first residential zones aren't stuck waiting on a chicken-and-egg
      // industrial zone that itself wants residential nearby. This is what keeps a
      // sprawling city's outskirts from filling up with permanently-stunted housing
      // that only ever reaches the base tile stage.
      var hasAnyJobsYet = this.simulation._census.comZonePop > 0 || this.simulation._census.indZonePop > 0;
      if (hasAnyJobsYet && !this._hasNearbyCommercial(x, y, MAX_TRAFFIC_DISTANCE) &&
          !this._hasNearbyIndustrial(x, y, MAX_TRAFFIC_DISTANCE)) {
        return -9999;
      }
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
      var x = startX + dx;
      var y = startY + dy;
      var tileValue = map.getTileValue(x, y);
      if (tileValue !== TileValues.DIRT && !TileUtils.canBulldoze(tileValue))
        return false;
      // canBulldoze() is true for standalone wire tiles (LHPOWER..LVPOWER10 — wire
      // laid over bare dirt rather than on a road), so without this check the AI
      // would happily pave a brand new zone right over a wire segment another zone
      // depends on for power, severing it. Never treat conductive ground as "clear".
      if (map.getTile(x, y).isConductive()) return false;
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


// Deliberately checks isPowered(), not isConductive(): a conductive tile can belong
// to a wire island that never made it back to any plant (a stub built alongside a
// prior zone but never stitched into the main grid). Scoring on conductivity alone
// rewards leapfrogging next to those dead stubs, which only grows the fragmentation.
AIAdvisor.prototype._hasNearbyPower = function(x, y, radius) {
  var map = this.map;
  for (var dy = -radius; dy <= radius; dy++) {
    for (var dx = -radius; dx <= radius; dx++) {
      var nx = x + dx;
      var ny = y + dy;
      if (nx >= 0 && ny >= 0 && nx < map.width && ny < map.height) {
        if (map.getTile(nx, ny).isPowered()) return true;
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


AIAdvisor.prototype._safeBlockGet = function(blockMap, x, y) {
  try {
    return blockMap.worldGet(x, y) || 0;
  } catch (e) {
    return 0;
  }
};


export { AIAdvisor };
