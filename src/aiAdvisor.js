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
  POWER: 110,
  // Infrastructure MUST be fixed before building new zones.
  // Old ordering had WIRE_CONNECT=75 < ZONE_DEMAND=80, so the AI
  // kept building new zones instead of powering existing ones.
  // Fix: infrastructure > zone demand. Always.
  WIRE_CONNECT: 105,       // Was 75 — unpowered zones are BROKEN zones
  ROAD_CONNECT: 100,       // Was 90 — disconnected zones degrade immediately
  BUDGET_ADJUST: 95,
  ZONE_DEMAND: 80,
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

// External market competition multipliers from valves.js
var EXT_MARKET_PARAM_TABLE = [1.2, 1.1, 0.98];

// ---- Proactive environmental model constants ----
// From blockMapUtils.js getPollutionValue(): exact pollution emissions per tile type
var POLLUTION_INDUSTRIAL = 50;  // Industrial zones (POWERBASE to PORTBASE)
var POLLUTION_COAL_PLANT = 100; // Coal power plants (to LASTPOWERPLANT)
var POLLUTION_HEAVY_TRAFFIC = 75; // Heavy traffic roads (HTRFBASE+)
var POLLUTION_LOW_TRAFFIC = 50;   // Low traffic roads (LTRFBASE to HTRFBASE)
var POLLUTION_FIRE = 90;         // Active fires
var POLLUTION_RADIATION = 255;   // Nuclear meltdown radiation

// From blockMapUtils.js: pollution map uses 2-pass smoothing with block size 2.
// Each smoothing pass: avg = (center + N + S + E + W) >> 2
// After 2 passes, pollution at distance d from source ≈ source * 0.25^(d/2)
// This means: industrial (50) at distance 4 → ~3 pollution, safe for residential.
// Coal (100) at distance 6 → ~6 pollution, safe. Distance 2 → ~25, concerning.
var SAFE_RESIDENTIAL_POLLUTION = 96;  // Hard block at 128. In compact cities, 60-100 is normal.
                                      // 96 gives 32-point safety margin while not blocking ALL placement.
var MIN_INDUSTRY_RESIDENTIAL_GAP = 6; // Tiles between industry and residential (was 8, too restrictive for compact cities)
var MIN_POWER_PLANT_RESIDENTIAL_GAP = 6; // Coal/nuclear gap (was 10 → 21x21 exclusion zone killed all placement)

// From blockMapUtils.js: crime = (128 - landValue) + populationDensity - policeEffect
// Crime > 190 → additional -20 land value penalty (vicious cycle)
var CRIME_THRESHOLD_SEVERE = 190;
var CRIME_THRESHOLD_BUILD_POLICE = 80;

// From traffic.js: MAX_TRAFFIC_DISTANCE = 30
// Zones MUST have complementary zones within 30 tiles or traffic check fails → degradation
var MAX_TRAFFIC_DISTANCE = 30;

// From commercial.js: commercial growth capped by population > (landValue >> 5)
// landValue 0-31 → cap at 0 (can't grow), 32-63 → cap at 1, 64-95 → cap 2, etc.
// Commercial zones need landValue ≥ 160 to reach max population 5
var COMMERCIAL_LV_FOR_MAX_POP = 160;

// From blockMapUtils.js: landValue = (34 - cityCentreDistance/2) * 4 + terrain - pollution
// Parks add to terrainDensityMap (15 points per undeveloped tile in 4x4 block)
// At city center (dist=0): base landValue = 136, at dist=20: base = 96
var LAND_VALUE_CENTER_BASE = 136;
var LAND_VALUE_PER_DISTANCE = 2; // Lose 2 landValue per tile from center

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

  // Closed-loop diagnostic state
  this._stallCycles = 0;
  this._lastActionType = null;
  this._lastActionTime = 0;
  this._lastZoneBuildType = null;
  this._growthHistory = []; // Rolling window of pop deltas
  this._lastValvePrediction = null;
  this._lastScoreBreakdown = null;
  this._lastStallDiagnosis = null;

  // Road network connectivity map — rebuilt every analyze() cycle.
  // Contains all road tiles reachable from the main road network.
  // Prevents the AI from placing zones near disconnected road fragments.
  this._connectedRoads = null;

  // Performance tracking — fed by aiHelper action outcomes
  this._recentOutcomes = []; // Rolling window of {result, timestamp}
  this._strategyOverride = null; // 'cautious' when failing too much
  this._previousValvePrediction = null; // For prediction accuracy tracking
  this._predictionHits = 0;
  this._predictionTotal = 0;

  // === ZONE HEALTH AUDIT ===
  // The AI equivalent of "looking at the screenshot" — periodically scans
  // every zone on the map, diagnoses ALL health conditions, and queues fixes.
  // This is what makes the AI as smart as a human who can see the game state.
  this._zoneHealthIssues = [];    // Current list of sick zones + diagnoses
  this._blacklistedLocations = {}; // {x,y} → expiry tick. Locations where zones failed.
  this._auditTick = 0;            // Increments each action cycle
}


// ---- Road network connectivity (BFS flood-fill) ----
//
// THE CORE FIX: The AI was checking "is there a road within N tiles?" but
// NEVER checking "is that road connected to the main road network?"
// Result: zones placed next to disconnected road fragments, then degrading.
//
// Solution: BFS from a known-good seed (grid origin or powered road) to find
// ALL road tiles connected to the main network. Store in a Set for O(1) lookup.
// Rebuilt every analyze() cycle (~200-500 road tiles, very fast).

AIAdvisor.prototype._buildRoadNetworkMap = function() {
  var map = this.map;
  var network = {};
  var seedX = -1, seedY = -1;

  // Strategy 1: Start from grid origin — the starter city main road
  if (this._plan.initialized) {
    var gx = this._plan.gridOriginX;
    var gy = this._plan.gridOriginY;
    if (gx >= 0 && gy >= 0 && gx < map.width && gy < map.height &&
        TileUtils.isRoad(map.getTileValue(gx, gy))) {
      seedX = gx; seedY = gy;
    }
  }

  // Strategy 2: Find any powered road tile (connected to working infrastructure)
  if (seedX === -1) {
    for (var sy = 0; sy < map.height && seedX === -1; sy += 2) {
      for (var sx = 0; sx < map.width; sx += 2) {
        if (TileUtils.isRoad(map.getTileValue(sx, sy)) && map.getTile(sx, sy).isPowered()) {
          seedX = sx; seedY = sy; break;
        }
      }
    }
  }

  // Strategy 3: Find any road tile at all
  if (seedX === -1) {
    for (var sy2 = 0; sy2 < map.height && seedX === -1; sy2++) {
      for (var sx2 = 0; sx2 < map.width; sx2++) {
        if (TileUtils.isRoad(map.getTileValue(sx2, sy2))) {
          seedX = sx2; seedY = sy2; break;
        }
      }
    }
  }

  if (seedX === -1) {
    this._connectedRoads = network; // No roads on map
    return;
  }

  // BFS from seed — find all connected road tiles
  var queue = [[seedX, seedY]];
  network[seedX + ',' + seedY] = true;

  while (queue.length > 0) {
    var pos = queue.shift();
    var cx = pos[0], cy = pos[1];
    var neighbors = [[cx-1,cy],[cx+1,cy],[cx,cy-1],[cx,cy+1]];
    for (var i = 0; i < neighbors.length; i++) {
      var nx = neighbors[i][0], ny = neighbors[i][1];
      if (nx < 0 || ny < 0 || nx >= map.width || ny >= map.height) continue;
      var nkey = nx + ',' + ny;
      if (network[nkey]) continue;
      if (TileUtils.isRoad(map.getTileValue(nx, ny))) {
        network[nkey] = true;
        queue.push([nx, ny]);
      }
    }
  }

  this._connectedRoads = network;
};


// Check if a specific road tile is part of the connected main network.
AIAdvisor.prototype._isRoadConnected = function(x, y) {
  if (!this._connectedRoads) return false;
  return !!this._connectedRoads[x + ',' + y];
};


// Find a CONNECTED road within radius — replaces _hasNearbyRoad for zone scoring.
// This is the key difference: _hasNearbyRoad found ANY road (including fragments),
// this only finds roads that are part of the actual working network.
AIAdvisor.prototype._hasNearbyConnectedRoad = function(x, y, radius) {
  if (!this._connectedRoads) return false;
  var map = this.map;
  for (var dy = -radius; dy <= radius; dy++) {
    for (var dx = -radius; dx <= radius; dx++) {
      var nx = x + dx;
      var ny = y + dy;
      if (nx >= 0 && ny >= 0 && nx < map.width && ny < map.height) {
        if (TileUtils.isRoad(map.getTileValue(nx, ny)) &&
            this._connectedRoads[nx + ',' + ny]) {
          return true;
        }
      }
    }
  }
  return false;
};


// Find the nearest road tile that's part of the connected network.
// Used by _ensureRoadAccess to build toward the REAL network, not fragments.
AIAdvisor.prototype._findNearestConnectedRoad = function(x, y) {
  if (!this._connectedRoads) return null;
  var map = this.map;
  for (var radius = 1; radius < 30; radius++) {
    for (var dy = -radius; dy <= radius; dy++) {
      for (var dx = -radius; dx <= radius; dx++) {
        if (Math.abs(dx) !== radius && Math.abs(dy) !== radius) continue;
        var nx = x + dx;
        var ny = y + dy;
        if (nx >= 0 && ny >= 0 && nx < map.width && ny < map.height) {
          if (TileUtils.isRoad(map.getTileValue(nx, ny)) &&
              this._connectedRoads[nx + ',' + ny]) {
            return { x: nx, y: ny };
          }
        }
      }
    }
  }
  return null;
};


// Find an abandoned zone that should be bulldozed.
// Zones are "abandoned" when they have no chance of recovering:
//   1. No adjacent road AND far from connected network → unreachable
//   2. Residential with pollution > 128 → growth permanently blocked
//   3. Unpowered AND no road → double broken, will only degrade
AIAdvisor.prototype.findAbandonedZone = function() {
  var map = this.map;
  var blockMaps = this.blockMaps;
  var worst = null;
  var worstScore = 0;

  for (var y = 1; y < map.height - 1; y += 2) {
    for (var x = 1; x < map.width - 1; x += 2) {
      var tile = map.getTile(x, y);
      if (!tile.isZone()) continue;

      var score = 0;
      var tv = map.getTileValue(x, y);
      var hasConnectedRoad = this._hasAdjacentConnectedRoad(x, y);
      var hasAnyRoad = hasConnectedRoad || this._hasAdjacentRoad(x, y);
      var hasPower = tile.isPowered();
      var pollution = this._safeBlockGet(blockMaps.pollutionDensityMap, x, y);

      // Residential in lethal pollution zone — will NEVER grow
      if (TileUtils.isResidential(tv) && pollution > 128) {
        score += 100;
      }

      // No adjacent CONNECTED road — zone can't route traffic, degrades immediately.
      // A disconnected road fragment next to the zone is just as bad as no road.
      if (!hasConnectedRoad) {
        if (!this._hasNearbyConnectedRoad(x, y, 8)) {
          score += 200; // Far from network — unreachable, must bulldoze
        } else if (!hasAnyRoad) {
          score += 150; // No road at all, but near network — could be fixed
        } else {
          score += 100; // Has disconnected road fragment — still broken
        }
      }

      // Unpowered — all zone types need power to grow
      if (!hasPower) {
        score += 30;
      }

      // Both broken — definitely dead
      if (!hasConnectedRoad && !hasPower) {
        score += 100;
      }

      if (score > worstScore) {
        worstScore = score;
        worst = { x: x, y: y, score: score, hasRoad: hasConnectedRoad, hasPower: hasPower };
      }
    }
  }

  // Only return zones that are truly abandoned (high score = multiple problems)
  if (worst && worst.score >= 100) return worst;
  return null;
};


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

// ---- Closed-loop diagnostics: trend tracking ----
//
// Called every analyze() cycle to track population trends and detect stalls.
// Growth stall detection triggers root-cause diagnosis so the AI can
// identify and fix the SPECIFIC bottleneck instead of blindly building zones.

AIAdvisor.prototype._updateTrends = function() {
  var census = this.simulation._census;
  var currentPop = census.totalPop;

  // Calculate growth delta
  if (this._lastTotalPop > 0) {
    this._popGrowthRate = currentPop - this._lastTotalPop;
  }
  this._lastTotalPop = currentPop;

  // Rolling growth history (last 10 samples)
  this._growthHistory.push(this._popGrowthRate);
  if (this._growthHistory.length > 10) this._growthHistory.shift();

  // Stall detection: consecutive cycles with zero or negative growth
  if (this._popGrowthRate <= 0 && currentPop > 50) {
    this._stallCycles++;
  } else {
    this._stallCycles = 0;
  }

  this._ticksSinceSpecialCheck++;

  // Refresh predictions periodically (every 3 cycles to avoid overhead)
  if (this._ticksSinceSpecialCheck % 3 === 0) {
    this._lastValvePrediction = this._predictValves();
    this._lastScoreBreakdown = this._calculateScoreBreakdown();
  }

  // Trigger stall diagnosis when growth has stalled for 5+ cycles
  if (this._stallCycles >= 5) {
    this._lastStallDiagnosis = this._diagnoseGrowthStall();
  } else {
    this._lastStallDiagnosis = null;
  }
};


// ---- Growth stall diagnosis ----
//
// When population growth stalls, identify the ROOT CAUSE.
// The AI checks every possible bottleneck from source code knowledge:
//   1. Demand caps (resPop>500/indPop>70/comPop>100 without special buildings)
//   2. All valves negative (tax too high or employment imbalanced)
//   3. Unpowered zones (commercial REQUIRES power to grow — line 126 commercial.js)
//   4. Employment imbalance (uses LAGGED comHist10[1]+indHist10[1])
//   5. Tax killing growth (valve effect < -50/cycle)
//   6. Pollution blocking residential (hard block at >128)
//   7. Crime destroying land value (>190 = landValue -20)
//   8. Traffic routing failures (no path to complementary zones)
//   9. Bankruptcy (can't build anything)
//  10. Zone pacing (built too fast, waiting for development)
//
// Returns array sorted by severity (5=critical, 1=minor).

AIAdvisor.prototype._diagnoseGrowthStall = function() {
  var census = this.simulation._census;
  var budget = this.simulation.budget;
  var valves = this.simulation._valves;
  var causes = [];

  // 1. Demand caps — each costs 15% score AND blocks valve from going positive
  if (valves.resCap) {
    causes.push({cause: 'RES_CAP', severity: 5,
      detail: 'Residential CAPPED (resPop ' + census.resPop + '/500). Stadium needed.',
      fix: 'build_stadium'});
  }
  if (valves.indCap) {
    causes.push({cause: 'IND_CAP', severity: 5,
      detail: 'Industrial CAPPED (indPop ' + census.indPop + '/70). Seaport needed.',
      fix: 'build_seaport'});
  }
  if (valves.comCap) {
    causes.push({cause: 'COM_CAP', severity: 5,
      detail: 'Commercial CAPPED (comPop ' + census.comPop + '/100). Airport needed.',
      fix: 'build_airport'});
  }

  // 2. All valves negative → systemic demand problem
  if (valves.resValve < 0 && valves.comValve < 0 && valves.indValve < 0) {
    var taxEffect = this._getTaxValveEffect(budget.cityTax);
    if (taxEffect < -30) {
      causes.push({cause: 'TAX_KILLING_GROWTH', severity: 4,
        detail: 'Tax ' + budget.cityTax + '% = ' + taxEffect + '/cycle valve penalty. All demand suppressed.',
        fix: 'lower_tax'});
    } else {
      causes.push({cause: 'ALL_VALVES_NEGATIVE', severity: 3,
        detail: 'R:' + valves.resValve + ' C:' + valves.comValve + ' I:' + valves.indValve + '. Employment or pacing issue.',
        fix: 'rebalance'});
    }
  }

  // 3. Unpowered zones — CRITICAL for commercial (requires power to grow, line 126 commercial.js)
  var totalZones = census.unpoweredZoneCount + census.poweredZoneCount;
  var unpoweredRatio = totalZones > 0 ? census.unpoweredZoneCount / totalZones : 0;
  if (unpoweredRatio > 0.05 && census.unpoweredZoneCount > 1) {
    causes.push({cause: 'POWER_DEFICIT', severity: 4,
      detail: census.unpoweredZoneCount + ' unpowered zones (' + Math.round(unpoweredRatio * 100) + '%). Commercial CANNOT grow without power.',
      fix: 'wire_connect'});
  }

  // 4. Employment imbalance — uses LAGGED data from comHist10[1]+indHist10[1]
  var normalizedResPop = census.resPop / 8;
  if (normalizedResPop > 2) {
    var employment = (census.comPop + census.indPop) / normalizedResPop;
    if (employment < 0.5) {
      causes.push({cause: 'NO_JOBS', severity: 4,
        detail: 'Employment ' + Math.round(employment * 100) + '% — need C/I zones for jobs.',
        fix: 'build_jobs'});
    } else if (employment > 2.0) {
      causes.push({cause: 'NO_WORKERS', severity: 4,
        detail: 'Employment ' + Math.round(employment * 100) + '% — need R zones for workers.',
        fix: 'build_residential'});
    }
  }

  // 5. Pollution blocking residential growth (hard block at >128 in residential.js:121)
  if (census.pollutionAverage > 60) {
    var pollSeverity = census.pollutionAverage > 100 ? 5 : (census.pollutionAverage > 80 ? 4 : 3);
    causes.push({cause: 'POLLUTION_BLOCK', severity: pollSeverity,
      detail: 'Pollution avg ' + census.pollutionAverage + '. Residential HARD BLOCKS at 128. Industrial/coal too close.',
      fix: 'reduce_pollution'});
  }

  // 6. Crime destroying land value (crime > 190 = landValue -20 in blockMapUtils)
  if (census.crimeAverage > 120) {
    causes.push({cause: 'CRIME_CRISIS', severity: 3,
      detail: 'Crime avg ' + census.crimeAverage + '. Land value dropping → revenue dropping.',
      fix: 'build_police'});
  }

  // 7. Traffic gridlock — zones degrade when traffic routing fails
  if ((census.trafficAverage || 0) > 100) {
    causes.push({cause: 'TRAFFIC_GRIDLOCK', severity: 3,
      detail: 'Traffic avg ' + Math.round(census.trafficAverage) + '. Zones degrading from routing failures.',
      fix: 'build_roads'});
  }

  // 8. Bankruptcy
  if (budget.totalFunds < 500 && budget.cashFlow < 0) {
    causes.push({cause: 'BROKE', severity: 4,
      detail: 'Funds $' + budget.totalFunds + ', cash flow $' + budget.cashFlow + '/yr.',
      fix: 'raise_tax'});
  }

  // 9. Road funding degradation — score penalty from evaluation.js
  if (budget.roadEffect < Math.floor(budget.MAX_ROAD_EFFECT / 2) && census.roadTotal > 20) {
    causes.push({cause: 'ROAD_DECAY', severity: 2,
      detail: 'Road effect ' + budget.roadEffect + '/' + budget.MAX_ROAD_EFFECT + '. Score penalty active.',
      fix: 'fund_roads'});
  }

  // 10. Valve trajectory heading negative — predict problems before they hit
  var prediction = this._lastValvePrediction || this._predictValves();
  if (prediction.resDelta < -100 && valves.resValve > 0 && prediction.resToZero !== null && prediction.resToZero < 5) {
    causes.push({cause: 'RES_VALVE_CRASHING', severity: 2,
      detail: 'Res valve ' + valves.resValve + ' dropping ' + prediction.resDelta + '/cycle. Hits 0 in ~' + prediction.resToZero + ' cycles.',
      fix: 'build_jobs'});
  }

  causes.sort(function(a, b) { return b.severity - a.severity; });
  return causes;
};


// ---- Valve trajectory prediction (exact valves.js formula) ----
//
// Replicates the EXACT setValves() calculation from valves.js to predict
// what valve values will be on the next cycle. This lets the AI:
//   - Anticipate demand changes before they happen
//   - Pre-build zones before demand peaks
//   - Avoid building into a collapsing valve
//   - Predict how many cycles until a valve hits zero/cap

AIAdvisor.prototype._predictValves = function() {
  var census = this.simulation._census;
  var budget = this.simulation.budget;
  var gameLevel = this._getGameLevel();
  var valves = this.simulation._valves;

  var normalizedResPop = census.resPop / 8;

  // Employment uses LAGGED historical data — this is key
  var employment;
  if (census.resPop > 0)
    employment = (census.comHist10[1] + census.indHist10[1]) / normalizedResPop;
  else
    employment = 1;

  var migration = normalizedResPop * (employment - 1);
  var births = normalizedResPop * 0.02;
  var projectedResPop = normalizedResPop + migration + births;

  var labourBase = (census.comHist10[1] + census.indHist10[1]);
  if (labourBase > 0)
    labourBase = census.resHist10[1] / labourBase;
  else
    labourBase = 1;
  labourBase = Math.max(0, Math.min(labourBase, 1.3));

  var internalMarket = (normalizedResPop + census.comPop + census.indPop) / 3.7;
  var projectedComPop = internalMarket * labourBase;
  var projectedIndPop = census.indPop * labourBase * EXT_MARKET_PARAM_TABLE[gameLevel];
  projectedIndPop = Math.max(projectedIndPop, 5.0);

  var resRatio = normalizedResPop > 0 ? projectedResPop / normalizedResPop : 1.3;
  var comRatio = census.comPop > 0 ? projectedComPop / census.comPop : projectedComPop;
  var indRatio = census.indPop > 0 ? projectedIndPop / census.indPop : projectedIndPop;

  resRatio = Math.min(resRatio, 2);
  comRatio = Math.min(comRatio, 2);
  indRatio = Math.min(indRatio, 2);

  var z = Math.min(budget.cityTax + gameLevel, 20);
  var resDelta = Math.round((resRatio - 1) * 600 + TAX_TABLE[z]);
  var comDelta = Math.round((comRatio - 1) * 600 + TAX_TABLE[z]);
  var indDelta = Math.round((indRatio - 1) * 600 + TAX_TABLE[z]);

  var nextRes = Math.max(-2000, Math.min(2000, valves.resValve + resDelta));
  var nextCom = Math.max(-1500, Math.min(1500, valves.comValve + comDelta));
  var nextInd = Math.max(-1500, Math.min(1500, valves.indValve + indDelta));

  if (valves.resCap && nextRes > 0) nextRes = 0;
  if (valves.comCap && nextCom > 0) nextCom = 0;
  if (valves.indCap && nextInd > 0) nextInd = 0;

  return {
    resDelta: resDelta, comDelta: comDelta, indDelta: indDelta,
    nextRes: nextRes, nextCom: nextCom, nextInd: nextInd,
    employment: employment,
    laggedComInd: census.comHist10[1] + census.indHist10[1],
    // Predict cycles until valve reaches zero (negative delta on positive valve)
    resToZero: resDelta < 0 && valves.resValve > 0 ? Math.ceil(valves.resValve / Math.abs(resDelta)) : null,
    comToZero: comDelta < 0 && valves.comValve > 0 ? Math.ceil(valves.comValve / Math.abs(comDelta)) : null,
    indToZero: indDelta < 0 && valves.indValve > 0 ? Math.ceil(valves.indValve / Math.abs(indDelta)) : null
  };
};


// ---- Score breakdown (exact evaluation.js decomposition) ----
//
// Calculates the EXACT contribution of each of the 7 problem categories
// to identify the biggest score drains. Also computes multiplicative
// penalties from demand caps and valve collapses.
//
// This lets the AI make targeted fixes instead of generic improvements:
//   "Crime is costing 133 score points — build police" vs just "score is low"

AIAdvisor.prototype._calculateScoreBreakdown = function() {
  var census = this.simulation._census;
  var budget = this.simulation.budget;
  var valves = this.simulation._valves;
  var blockMaps = this.blockMaps;

  // Replicate traffic average calculation from evaluation.js:166
  var trafficTotal = 0;
  var trafficCount = 1;
  var tdMap = blockMaps.trafficDensityMap;
  var lvMap = blockMaps.landValueMap;
  for (var x = 0; x < lvMap.gameMapWidth; x += lvMap.blockSize) {
    for (var y = 0; y < lvMap.gameMapHeight; y += lvMap.blockSize) {
      if (lvMap.worldGet(x, y) > 0) {
        trafficTotal += tdMap.worldGet(x, y);
        trafficCount++;
      }
    }
  }
  var trafficAvg = Math.floor(trafficTotal / trafficCount) * 2.4;

  // Unemployment from evaluation.js:188
  var b = (census.comPop + census.indPop) * 8;
  var unemployment = 0;
  if (b > 0) {
    var r = census.resPop / b;
    unemployment = Math.min(Math.max(Math.round((r - 1) * 255), 0), 255);
  }

  var fireSeverity = Math.min(census.firePop * 5, 255);

  // Problem values (same as evaluation.js:208-214)
  var problems = {
    crime: census.crimeAverage,
    pollution: census.pollutionAverage,
    housing: Math.round(census.landValueAverage * 0.7),
    taxes: budget.cityTax * 10,
    traffic: Math.round(trafficAvg),
    unemployment: unemployment,
    fire: fireSeverity
  };

  var totalProblemValue = 0;
  var problemScoreCosts = {};
  for (var key in problems) {
    totalProblemValue += problems[key];
    // Each point contributes to: baseScore = (250 - min(sum/3, 250)) * 4
    // Marginal cost ≈ value/3 * 4 = value * 1.333
    problemScoreCosts[key] = Math.round(problems[key] * 1.333);
  }

  var baseScore = (250 - Math.min(Math.floor(totalProblemValue / 3), 250)) * 4;

  // Multiplicative penalties
  var multiplier = 1.0;
  var penalties = [];
  if (valves.resCap) { multiplier *= 0.85; penalties.push('resCap'); }
  if (valves.comCap) { multiplier *= 0.85; penalties.push('comCap'); }
  if (valves.indCap) { multiplier *= 0.85; penalties.push('indCap'); }
  if (valves.resValve < -1000) { multiplier *= 0.85; penalties.push('resCollapse'); }
  if (valves.comValve < -1000) { multiplier *= 0.85; penalties.push('comCollapse'); }
  if (valves.indValve < -1000) { multiplier *= 0.85; penalties.push('indCollapse'); }

  var totalZones = census.unpoweredZoneCount + census.poweredZoneCount;
  var powerRatio = totalZones > 0 ? census.poweredZoneCount / totalZones : 1;

  // Find biggest problem
  var biggestProblem = '';
  var biggestCost = 0;
  for (key in problemScoreCosts) {
    if (problemScoreCosts[key] > biggestCost) {
      biggestCost = problemScoreCosts[key];
      biggestProblem = key;
    }
  }

  return {
    problems: problems,
    problemScoreCosts: problemScoreCosts,
    baseScore: baseScore,
    multiplier: multiplier,
    penalties: penalties,
    powerRatio: powerRatio,
    fireSeverityPenalty: fireSeverity,
    taxDirectPenalty: budget.cityTax,
    estimatedScore: Math.round(baseScore * multiplier * powerRatio - fireSeverity - budget.cityTax),
    biggestProblem: biggestProblem,
    biggestProblemCost: biggestCost
  };
};


// ---- Fund reservation system ----
//
// Predicts upcoming large expenses (special buildings, power plants) and
// reserves funds so zone building doesn't drain the treasury right before
// a critical purchase is needed. Without this, the AI would spend $4900
// on zones and then not have $5000 for the stadium when resPop hits 500.

AIAdvisor.prototype._shouldReserveFunds = function() {
  var census = this.simulation._census;
  var budget = this.simulation.budget;
  var reservations = [];

  // Stadium: reserve when resPop > 250 (well before 500 cap)
  if (census.stadiumPop === 0 && census.resPop > 250) {
    var resUrgency = census.resPop > 400 ? 'critical' : 'approaching';
    reservations.push({building: 'stadium', cost: 5000, urgency: resUrgency});
  }

  // Seaport: reserve when indPop > 35 (well before 70 cap)
  if (census.seaportPop === 0 && census.indPop > 35) {
    var indUrgency = census.indPop > 55 ? 'critical' : 'approaching';
    reservations.push({building: 'seaport', cost: 3000, urgency: indUrgency});
  }

  // Airport: reserve when comPop > 50 (well before 100 cap)
  if (census.airportPop === 0 && census.comPop > 50) {
    var comUrgency = census.comPop > 80 ? 'critical' : 'approaching';
    reservations.push({building: 'airport', cost: 10000, urgency: comUrgency});
  }

  // Power plant: reserve when capacity > 70% (use map-based counts to avoid census lag)
  var zc = this._zoneCounts || {};
  var mapCoal = zc.coalPlants || 0;
  var mapNuclear = zc.nuclearPlants || 0;
  var maxPower = mapCoal * COAL_CAPACITY + mapNuclear * NUCLEAR_CAPACITY;
  var totalZones = census.poweredZoneCount + census.unpoweredZoneCount;
  var estConsumption = totalZones * TILES_PER_ZONE + (mapCoal + mapNuclear) * PLANT_OVERHEAD;
  if (maxPower > 0 && estConsumption / maxPower > 0.70) {
    var powerUrgency = estConsumption / maxPower > 0.85 ? 'critical' : 'approaching';
    reservations.push({building: 'power plant', cost: 3000, urgency: powerUrgency});
  }

  // Sum critical reservations
  var totalReserved = 0;
  for (var i = 0; i < reservations.length; i++) {
    if (reservations[i].urgency === 'critical') {
      totalReserved += reservations[i].cost;
    }
  }

  return {
    reservations: reservations,
    totalReserved: totalReserved,
    canSpendOnZones: budget.totalFunds - totalReserved > 1000
  };
};


// ---- Fund depletion prediction ----
//
// Projects when funds will hit zero at current income/expense rate.
// Uses the EXACT budget.js formulas for revenue and maintenance.

AIAdvisor.prototype._predictFundDepletion = function() {
  var budget = this.simulation.budget;
  var totalMaint = budget.roadMaintenanceBudget + budget.fireMaintenanceBudget + budget.policeMaintenanceBudget;
  var revenue = this._projectRevenue(budget.cityTax);
  var netFlow = revenue - totalMaint;

  if (netFlow >= 0) return {cyclesUntilBroke: Infinity, netFlow: netFlow, revenue: revenue, maintenance: totalMaint};

  // TAX_FREQUENCY = 48 cityTime, so each "tax cycle" we lose |netFlow|
  var cyclesUntilBroke = Math.floor(budget.totalFunds / Math.abs(netFlow));

  return {
    cyclesUntilBroke: cyclesUntilBroke,
    netFlow: netFlow,
    revenue: revenue,
    maintenance: totalMaint
  };
};


// ---- Proactive environmental prediction ----
//
// These methods let the AI PREDICT consequences BEFORE acting, not just react.
// The AI should know from tile #1 that placing industrial near residential
// will cause pollution that blocks growth. It should know that commercial
// zones in low-landvalue areas will never reach max population.
//
// Key insight: some penalties are ACCEPTABLE trade-offs for faster growth.
// The AI computes cost/benefit to decide when to accept vs avoid a penalty.

// Predict pollution at a given location from all nearby sources.
// Uses the EXACT emission values from blockMapUtils.js getPollutionValue()
// and approximates 2-pass smoothing dispersion.
//
// After 2 passes of SMOOTH_ALL_THEN_CLAMP:
//   pollution(dist) ≈ source_value × decay^dist
//   where decay ≈ 0.4 per tile for 2-pass smoothing on blockSize=2 map
//
// This is an ESTIMATE — actual smoothing is more complex (5-point stencil)
// but this approximation catches the big problems.
AIAdvisor.prototype._predictPollutionAt = function(x, y) {
  var map = this.map;
  var totalPollution = 0;
  var scanRadius = 12; // Beyond this, pollution contribution is negligible

  for (var dy = -scanRadius; dy <= scanRadius; dy++) {
    for (var dx = -scanRadius; dx <= scanRadius; dx++) {
      var nx = x + dx;
      var ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= map.width || ny >= map.height) continue;

      var tv = map.getTileValue(nx, ny);
      var emission = 0;

      // Check tile type pollution emissions (from blockMapUtils.js:43-68)
      if (TileUtils.isIndustrial(tv)) {
        emission = POLLUTION_INDUSTRIAL;
      } else if (tv >= TileValues.POWERBASE && tv <= TileValues.LASTPOWERPLANT) {
        emission = POLLUTION_COAL_PLANT;
      } else if (tv === TileValues.RADTILE) {
        emission = POLLUTION_RADIATION;
      }
      // Skip traffic pollution — it's transient and hard to predict statically

      if (emission === 0) continue;

      // Approximate dispersion after 2-pass smoothing
      var dist = Math.abs(dx) + Math.abs(dy); // Manhattan distance
      // Each smoothing pass roughly halves the value per 2 tiles
      // After 2 passes: roughly emission × 0.6^dist (empirical fit)
      var dispersed = emission * Math.pow(0.6, dist);
      totalPollution += dispersed;
    }
  }

  return Math.round(Math.min(totalPollution, 255));
};


// Predict what land value WOULD be at a location, using the EXACT formula
// from blockMapUtils.js:244-260:
//   landValue = (34 - cityCentreDistance/2) * 4 + terrain - pollution
//   if crime > 190: landValue -= 20
//
// This lets the AI choose placement spots that maximize land value → revenue.
AIAdvisor.prototype._predictLandValueAt = function(x, y) {
  var map = this.map;
  var blockMaps = this.blockMaps;

  // City centre distance component
  var cdx = Math.abs(x - map.cityCentreX);
  var cdy = Math.abs(y - map.cityCentreY);
  var dist = Math.min(cdx + cdy, 64); // Clamped to 64
  var distComponent = (34 - Math.floor(dist / 2)) * 4; // Range 8-136

  // Terrain density (from terrainDensityMap, block size 4)
  var terrain = this._safeBlockGet(blockMaps.terrainDensityMap, x, y);

  // Pollution (use predicted if no blockMap data yet, or current data)
  var pollution = this._safeBlockGet(blockMaps.pollutionDensityMap, x, y);

  // Crime penalty
  var crime = this._safeBlockGet(blockMaps.crimeRateMap, x, y);
  var crimePenalty = crime > CRIME_THRESHOLD_SEVERE ? 20 : 0;

  var lv = distComponent + terrain - pollution - crimePenalty;
  return Math.max(1, Math.min(lv, 250));
};


// Check if placing a zone at (x,y) would cause traffic routing problems.
// From traffic.js: each zone type routes to its complement within 30 tiles:
//   Residential → Commercial (for shopping)
//   Commercial → Industrial (for goods)
//   Industrial → Residential (for workers)
//
// Returns true if the placement is safe (complement zone reachable).
AIAdvisor.prototype._hasTrafficRouteTarget = function(x, y, zoneType) {
  var targetCheck;
  // Use a SHORTER radius than the game engine's MAX_TRAFFIC_DISTANCE (30).
  // The game engine uses RANDOM WALKS along roads, not straight-line distance.
  // A zone 25 tiles away in straight line might be 40+ road-walk steps away.
  // Random walks are ~50% efficient, so effective range ≈ MAX_TRAFFIC_DISTANCE / 1.5.
  // Use 18 tiles to be realistic about what the random walk can actually reach.
  var searchRadius = 18;

  switch (zoneType) {
    case 'residential':
      // Residential routes to commercial
      targetCheck = function(tv) { return TileUtils.isCommercial(tv); };
      break;
    case 'commercial':
      // Commercial routes to industrial
      targetCheck = function(tv) { return TileUtils.isIndustrial(tv); };
      break;
    case 'industrial':
      // Industrial routes to residential
      targetCheck = function(tv) { return TileUtils.isResidential(tv); };
      break;
    default:
      return true;
  }

  // Search within MAX_TRAFFIC_DISTANCE for target zone type
  var map = this.map;
  for (var dy = -searchRadius; dy <= searchRadius; dy++) {
    for (var dx = -searchRadius; dx <= searchRadius; dx++) {
      if (Math.abs(dx) + Math.abs(dy) > searchRadius) continue;
      var nx = x + dx;
      var ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= map.width || ny >= map.height) continue;
      if (targetCheck(map.getTileValue(nx, ny))) return true;
    }
  }
  return false;
};


// Compute the maximum commercial population a zone can reach at a location.
// From commercial.js:48: `if (population > landValue) return;`
// where landValue = blockMaps.landValueMap.worldGet(x,y) >> 5
// So max commercial pop = floor(landValue / 32), capped at 5.
//
// This tells the AI: don't place commercial where landValue < 32 (waste of
// money), and prefer landValue ≥ 160 for max growth potential.
AIAdvisor.prototype._maxCommercialPopAt = function(x, y) {
  var lv = this._safeBlockGet(this.blockMaps.landValueMap, x, y);
  // Use predicted value if blockMap is empty (early game)
  if (lv === 0) lv = this._predictLandValueAt(x, y);
  return Math.min(lv >> 5, 5);
};


// Compute whether a penalty is an acceptable trade-off for growth speed.
// The AI deliberately accepts some penalties when the growth benefit outweighs
// the score cost, and rejects others that would cascade into permanent damage.
//
// Examples:
//   - High tax in bootstrap: ACCEPT (score cost < 14 pts but revenue enables building)
//   - Pollution near residential: REJECT (blocks growth entirely at >128)
//   - No police early: ACCEPT (crime avg ~50 = ~67 score cost, but saves $500+$100/yr)
//   - Demand cap without special building: REJECT (-15% multiplicative = ~150 score cost)
//   - Slight traffic: ACCEPT (traffic < 60 avg has minimal score impact)
AIAdvisor.prototype._isPenaltyAcceptable = function(penaltyType, currentValue) {
  var phase = this._getPhase();

  switch (penaltyType) {
    case 'pollution_near_residential':
      // NEVER acceptable — hard blocks growth at 128, cascading land value destruction
      return false;

    case 'no_traffic_route':
      // NEVER acceptable — zone will degrade, wasting the building cost entirely
      return false;

    case 'demand_cap':
      // NEVER acceptable — -15% multiplicative penalty is devastating
      return false;

    case 'high_tax':
      // Acceptable in bootstrap/early when we need revenue to build
      // Each tax point costs ~14 score (10 from problem + cityTax direct)
      if (phase === 'bootstrap' || phase === 'early') return true;
      // In growth: only if very low crime/pollution offset the cost
      if (phase === 'growth' && currentValue <= 8) return true;
      return false;

    case 'no_police':
      // Acceptable in bootstrap/early — crime takes time to build up
      // By pop ~40 we should have one; score cost accelerates after that
      if (phase === 'bootstrap') return true;
      if (phase === 'early' && (this.simulation._census.totalPop < 40)) return true;
      return false;

    case 'no_fire_station':
      // Acceptable early — fires are random events, expected cost is low
      // Fire penalty = firePop * 5, unlikely to happen without disaster
      if (phase === 'bootstrap') return true;
      if (phase === 'early' && (this.simulation._census.totalPop < 40)) return true;
      return false;

    case 'low_road_funding':
      // Acceptable temporarily if saving for a critical purchase
      // Roads degrade slowly (1/512 chance per tile per cycle)
      if (this._shouldReserveFunds().totalReserved > 0) return true;
      return false;

    case 'slight_traffic':
      // Traffic avg < 60 → minimal score impact (~80 problem points → ~107 score cost)
      // vs building roads that could fund zones instead
      return currentValue < 60;

    case 'industrial_pollution':
      // Industrial pollution (50/tile) is acceptable if industrial zones are
      // placed far enough from residential (≥6 tiles, pollution disperses to ~3)
      return true; // Always acceptable IF district rules are followed

    default:
      return false;
  }
};


// Compute the score ROI of building a specific structure.
// Returns estimated score points gained per $1000 spent (including maintenance).
// The AI uses this to prioritize which buildings give the most score improvement.
AIAdvisor.prototype._computeBuildingROI = function(buildingType) {
  var census = this.simulation._census;

  switch (buildingType) {
    case 'police':
      // Cost: $500 build + $100/yr maintenance
      // Benefit: reduces crimeAverage → score improvement ≈ crimeReduction * 1.333
      // First station in high-crime city: reduces avg by ~30-60
      // Score gain: ~40-80 points
      var crimeAvg = census.crimeAverage || 0;
      if (census.policeStationPop === 0 && crimeAvg > 40) {
        return Math.round(crimeAvg * 1.333 * 0.5 / 0.6); // ~50% reduction, $600 annual cost
      }
      return Math.round(Math.max(crimeAvg - 60, 0) * 0.3);

    case 'fire':
      // Cost: $500 build + $100/yr maintenance
      // Benefit: prevents fire damage (firePop * 5 score penalty)
      // Also: fire coverage boosts score multiplier (up to 10%)
      // ROI depends on whether fires are happening
      if (census.firePop > 0) return 200; // Active fires = critical
      return Math.round((100 - census.fireStationPop * 20) * 0.5);

    case 'stadium':
      // Cost: $5000 build + $0/yr maintenance
      // Benefit: removes resCap → +15% score (multiplicative!)
      // At score 500, that's +75 points = 15 ROI per $1000
      if (this.simulation._valves.resCap) return 150;
      return 0;

    case 'seaport':
      // Cost: $3000 build
      // Benefit: removes indCap → +15% score
      if (this.simulation._valves.indCap) return 200;
      return 0;

    case 'airport':
      // Cost: $10000 build
      // Benefit: removes comCap → +15% score
      if (this.simulation._valves.comCap) return 75;
      return 0;

    default:
      return 0;
  }
};


// ---- City plan management ----

AIAdvisor.prototype._getPhase = function() {
  var census = this.simulation._census;
  var budget = this.simulation.budget;
  var totalZones = census.poweredZoneCount + census.unpoweredZoneCount;
  if (totalZones === 0) return 'bootstrap';
  // Early: zones exist but city hasn't developed yet
  if (totalZones < 6 && census.totalPop < 100) return 'early';
  // Growth: city is developing, invest aggressively
  // Stay in growth with funds to invest — faster zones → more pop → more revenue
  if (census.totalPop < 2000 || (census.totalPop < 5000 && budget.totalFunds > 5000)) return 'growth';
  // Metro: large enough to focus on optimization and score
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

  // === ROAD NETWORK: Rebuild connected road map every cycle ===
  // This BFS identifies which roads are actually connected to the main network
  // so zone scoring rejects locations near disconnected road fragments.
  this._buildRoadNetworkMap();

  // === ZONE COUNTS: Count R/C/I zones for balance enforcement ===
  this._countZoneTypes();

  // === CLOSED-LOOP: Update trends and predictions FIRST ===
  this._updateTrends();

  // Budget adjustments are FREE - always check first
  var budgetActions = this._analyzeBudgetActions(budget, census);
  recommendations = recommendations.concat(budgetActions);

  // Emergency mode — but check fund depletion prediction first
  var isEmergency = budget.totalFunds < MIN_RESERVE && census.totalPop > 0;
  if (isEmergency) {
    var depletion = this._predictFundDepletion();
    var depletionMsg = depletion.netFlow < 0 ?
      ' Bankrupt in ~' + depletion.cyclesUntilBroke + ' tax cycles.' : '';
    recommendations.push({
      priority: PRIORITIES.EMERGENCY,
      message: 'EMERGENCY: Funds at $' + budget.totalFunds + '.' + depletionMsg + ' Halting construction.'
    });
    recommendations.sort(function(a, b) { return b.priority - a.priority; });
    return recommendations;
  }

  // === CLOSED-LOOP: Growth stall diagnosis ===
  // When stall detected, inject specific fix recommendations at HIGH priority
  // CRITICAL: Stall fixes must include ACTIONS, not just messages.
  if (this._lastStallDiagnosis && this._lastStallDiagnosis.length > 0) {
    var topCause = this._lastStallDiagnosis[0];
    var stallRec = {
      priority: PRIORITIES.EMERGENCY - 10,
      message: 'GROWTH STALL (' + this._stallCycles + ' cycles): ' + topCause.detail
    };
    // Convert diagnosis fix into an actual action the AI can execute
    switch (topCause.fix) {
      case 'reduce_pollution':
        stallRec.action = { type: 'reduce_pollution' };
        break;
      case 'build_stadium':
        stallRec.action = { type: 'build', tool: 'stadium' };
        break;
      case 'build_seaport':
        stallRec.action = { type: 'build', tool: 'port' };
        break;
      case 'build_airport':
        stallRec.action = { type: 'build', tool: 'airport' };
        break;
      case 'build_police':
        stallRec.action = { type: 'build', tool: 'police' };
        break;
      case 'wire_connect':
        stallRec.action = { type: 'wire_connect' };
        break;
      case 'lower_tax':
        var neutralTax = this._getNeutralTax();
        stallRec.action = { type: 'set_tax', value: Math.max(0, neutralTax - 3) };
        break;
      case 'raise_tax':
        var neutralTax2 = this._getNeutralTax();
        stallRec.action = { type: 'set_tax', value: Math.min(neutralTax2 + 2, 10) };
        break;
      case 'build_jobs':
        stallRec.action = { type: 'build', tool: valves.comValve > valves.indValve ? 'commercial' : 'industrial' };
        break;
      case 'build_residential':
        stallRec.action = { type: 'build', tool: 'residential' };
        break;
    }
    recommendations.push(stallRec);
    // Add second cause if exists — often multiple bottlenecks compound
    if (this._lastStallDiagnosis.length > 1) {
      var secondCause = this._lastStallDiagnosis[1];
      recommendations.push({
        priority: PRIORITIES.EMERGENCY - 15,
        message: 'ALSO: ' + secondCause.detail
      });
    }
  }

  // === CLOSED-LOOP: Valve trajectory warnings ===
  var prediction = this._lastValvePrediction;
  if (prediction) {
    // Warn if a positive valve is crashing toward zero
    if (prediction.resToZero !== null && prediction.resToZero < 4 && valves.resValve > 200) {
      recommendations.push({
        priority: PRIORITIES.BUDGET_INFO + 15,
        message: 'Res demand crashing (' + prediction.resDelta + '/cycle). Hits 0 in ~' + prediction.resToZero +
          ' cycles. Build C/I for employment.'
      });
    }
    if (prediction.comToZero !== null && prediction.comToZero < 4 && valves.comValve > 200) {
      recommendations.push({
        priority: PRIORITIES.BUDGET_INFO + 15,
        message: 'Com demand crashing (' + prediction.comDelta + '/cycle). Build R for workers.'
      });
    }
  }

  recommendations = recommendations.concat(this._analyzePower(census, budget));
  recommendations = recommendations.concat(this._analyzePollution(census, budget));
  recommendations = recommendations.concat(this._analyzeAbandonedZones(budget));
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
    // Use valve prediction to decide: if all valves trending positive,
    // we can afford higher tax for score benefit. If crashing, lower tax.
    var annualRevenue = this._projectRevenue(neutralTax);
    var surplus = annualRevenue - maintenance;
    var prediction = this._lastValvePrediction;

    if (budget.totalFunds < 1000 || surplus < -500) {
      // Need cash, but cap at neutral+2 to limit score damage
      optimalTax = Math.min(neutralTax + 2, 10);
    } else if (budget.totalFunds > 20000 && surplus > 1000) {
      // Rich city — lower tax for score bonus and continued growth
      optimalTax = Math.max(0, neutralTax - 2);
    } else if (budget.totalFunds > 8000) {
      // Use valve trajectory: if all deltas are strongly positive,
      // we can afford slightly higher tax for the score benefit.
      // If deltas are negative, lower tax to boost growth.
      if (prediction && prediction.resDelta > 100 && prediction.comDelta > 50) {
        // Valves growing strong — can sustain neutral tax
        optimalTax = neutralTax;
      } else if (prediction && prediction.resDelta < -50) {
        // Valves crashing — lower tax to boost
        optimalTax = Math.max(0, neutralTax - 2);
      } else {
        optimalTax = Math.max(0, neutralTax - 1);
      }
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
  // USE MAP-BASED COUNTS, not census. Census lags 1 cycle after building.
  // Without this, the AI builds DUPLICATE coal plants: it places one, census
  // hasn't updated yet, reads coalPowerPop=0, and builds another.
  var zc = this._zoneCounts || {};
  var coalPlants = zc.coalPlants || 0;
  var nuclearPlants = zc.nuclearPlants || 0;
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
          zonesUntilFull + ' zones left). Building coal plant.',
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

  // NOTE: "cautious mode" self-correction was removed. It suppressed ALL zone
  // building when >40% of recent actions failed, creating a deadlock:
  // bad scoring → failures → cautious → no building → no successes → stays cautious.
  // The proper fix is better scoring (pollution/sprawl/power constraints),
  // not suppressing all building. The score threshold (> -100) in findBestZoneLocation
  // is sufficient quality control.

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

  // === INFRASTRUCTURE GATE ===
  // HARD RULE: Do NOT build new zones if existing zones are broken.
  // Check BOTH power and road connectivity — zones need both to function.
  // OLD: Only checked unpowered zones (missed zones with disconnected roads).
  // NEW: Also count zones without CONNECTED road access.
  var unpowered = census.unpoweredZoneCount;
  var totalZoneCount = census.poweredZoneCount + unpowered;
  var disconnected = this._countDisconnectedZones(); // Uses _hasAdjacentConnectedRoad

  if ((unpowered > 2 || disconnected > 1) && totalZoneCount > 6) {
    // Broken zones exist — fix them before building more.
    // Road disconnection is the ROOT CAUSE in most cases (no road → no power either).
    if (disconnected > 0) {
      recs.push({
        priority: PRIORITIES.ROAD_CONNECT + 5,
        message: 'INFRA HALT: ' + disconnected + ' zones without connected road. Fixing first.',
        action: { type: 'build_roads' }
      });
    }
    if (unpowered > 2) {
      recs.push({
        priority: PRIORITIES.WIRE_CONNECT + 5,
        message: unpowered + ' unpowered zones. Connecting power.',
        action: { type: 'wire_connect' }
      });
    }
    return recs; // STOP — no new zones until infrastructure is fixed
  }

  // === CLOSED-LOOP: Fund reservation for upcoming special buildings ===
  // Don't spend on zones when we need to save for stadium/seaport/airport/power
  var fundReservation = this._shouldReserveFunds();

  // Phase-dependent reserve — more aggressive in early/growth phases
  // because growth speed compounds: more zones → more pop → more revenue
  var buildReserve = phase === 'early' ? 1000 :
                     phase === 'growth' ? 1500 :
                     phase === 'metro' ? 5000 : MIN_RESERVE;

  // Add critical fund reservations on top of base reserve
  buildReserve += fundReservation.totalReserved;

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

  // Don't build zones if power can't handle more.
  // NO ACTION here — _analyzePower() handles power plant builds at higher priority (115 vs 85).
  // This gate only prevents wasting money on zones that can't be powered.
  // Uses map-based counts (not census) to avoid census lag issues.
  var zc = this._zoneCounts || {};
  var mapCoal = zc.coalPlants || 0;
  var mapNuclear = zc.nuclearPlants || 0;
  var maxPower = mapCoal * COAL_CAPACITY + mapNuclear * NUCLEAR_CAPACITY;
  var estConsumption = totalZones * TILES_PER_ZONE +
    (mapCoal + mapNuclear) * PLANT_OVERHEAD;
  if (maxPower > 0 && estConsumption > maxPower * 0.90) {
    recs.push({
      priority: PRIORITIES.ZONE_DEMAND + 5,
      message: 'Power near capacity (' + Math.round(estConsumption / maxPower * 100) +
        '%). Need plant before adding zones.'
    });
    return recs;
  }

  // === ZONE BALANCE ENFORCEMENT ===
  // In SimCity, residential NEEDS commercial to route traffic to.
  // Without enough commercial, residential zones fail traffic check → degrade.
  // Similarly, commercial needs industrial. The game engine checks traffic
  // routing via random walks, so zones MUST be within road-reach of targets.
  //
  // RULE: Enforce minimum zone ratios BEFORE employment check.
  // The employment ratio can be misleading (high employment = few residents),
  // which causes the AI to keep building residential while ignoring commercial.
  var zc = this._zoneCounts || { res: 0, com: 0, ind: 0, total: 0 };
  if (zc.total > 6) {
    // Need at least 1 commercial per 3 residential for traffic routing
    var minCom = Math.max(1, Math.floor(zc.res / 3));
    if (zc.com < minCom) {
      var loc = this.findBestZoneLocation('commercial');
      if (loc && loc.score > -100) {
        recs.push({
          priority: PRIORITIES.ZONE_DEMAND + 20, // HIGHEST zone priority
          message: 'Commercial deficit (' + zc.com + 'C for ' + zc.res + 'R). ' +
            'Residential needs commercial for traffic routing.',
          action: { type: 'build', tool: 'commercial' }
        });
        return recs;
      }
    }
    // Need at least 1 industrial per 3 residential for jobs
    var minInd = Math.max(1, Math.floor(zc.res / 3));
    if (zc.ind < minInd) {
      var loc = this.findBestZoneLocation('industrial');
      if (loc && loc.score > -100) {
        recs.push({
          priority: PRIORITIES.ZONE_DEMAND + 18,
          message: 'Industrial deficit (' + zc.ind + 'I for ' + zc.res + 'R). ' +
            'Building industrial for employment balance.',
          action: { type: 'build', tool: 'industrial' }
        });
        return recs;
      }
    }
    // Don't let residential grow beyond 2x commercial+industrial
    if (zc.res > (zc.com + zc.ind) * 2 && (zc.com + zc.ind) > 0) {
      // Residential is oversupplied — build C or I based on valve
      var tool = valves.comValve >= valves.indValve ? 'commercial' : 'industrial';
      var loc = this.findBestZoneLocation(tool);
      if (loc && loc.score > -100) {
        recs.push({
          priority: PRIORITIES.ZONE_DEMAND + 16,
          message: 'Residential oversaturated (' + zc.res + 'R vs ' + zc.com +
            'C+' + zc.ind + 'I). Building ' + tool + '.',
          action: { type: 'build', tool: tool }
        });
        return recs;
      }
    }
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
  // But ONLY if zone balance is OK (checked above).
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
  // === CLOSED-LOOP: Use valve predictions to build AHEAD of demand ===
  // If valve is currently low but trending up strongly, start building now
  // rather than waiting for demand to peak and then scrambling.
  var prediction = this._lastValvePrediction;
  var buildChoices = [];

  if (valves.resValve > 100) {
    buildChoices.push({ tool: 'residential', priority: valves.resValve / 100 });
  } else if (prediction && prediction.resDelta > 150 && valves.resValve > -200) {
    // Valve is trending up strongly — pre-build residential
    buildChoices.push({ tool: 'residential', priority: 1.5 });
  }
  if (valves.comValve > 100) {
    buildChoices.push({ tool: 'commercial', priority: valves.comValve / 75 });
  } else if (prediction && prediction.comDelta > 100 && valves.comValve > -200) {
    buildChoices.push({ tool: 'commercial', priority: 1.2 });
  }
  if (valves.indValve > 100) {
    buildChoices.push({ tool: 'industrial', priority: valves.indValve / 75 });
  } else if (prediction && prediction.indDelta > 100 && valves.indValve > -200) {
    buildChoices.push({ tool: 'industrial', priority: 1.2 });
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

  // --- First police station: ROI-driven timing ---
  // Crime formula: (128 - landValue) + popDensity - policeEffect
  // Each crime avg point costs ~1.333 score points.
  // Police station costs $500 + $100/yr, but prevents crime→landValue→crime spiral.
  // In early game, crime is low (few people = low density), so delay is ACCEPTABLE.
  // But once crimeAverage > 40, the ROI is clearly positive.
  // Use map-based counts (not census) to prevent census-lag duplicate builds.
  var zc = this._zoneCounts || {};
  var mapPolice = zc.policeStations || 0;
  var mapFire = zc.fireStations || 0;

  if (mapPolice === 0 && canAfford) {
    var policeROI = this._computeBuildingROI('police');
    var crimeAcceptable = this._isPenaltyAcceptable('no_police', census.crimeAverage);
    if (!crimeAcceptable || policeROI > 30) {
      recs.push({
        priority: PRIORITIES.SERVICES + 12,
        message: 'Building police station (ROI=' + policeROI + '). Crime avg ' +
          Math.round(census.crimeAverage) + ' costing ~' +
          Math.round(census.crimeAverage * 1.333) + ' score pts.',
        action: { type: 'build', tool: 'police' }
      });
    }
  }

  // --- First fire station: ROI-driven timing ---
  // Fire penalty = firePop * 5, direct score subtraction.
  // Station costs $500 + $100/yr. Also: fire coverage boosts score multiplier (up to 10%).
  // In early game, fires are rare (random events), so delay is ACCEPTABLE.
  // But the station pays for itself via the coverage score multiplier once pop > 40.
  if (mapFire === 0 && canAfford) {
    var fireROI = this._computeBuildingROI('fire');
    var fireAcceptable = this._isPenaltyAcceptable('no_fire_station', census.firePop);
    if (!fireAcceptable || fireROI > 20 || census.firePop > 0) {
      recs.push({
        priority: census.firePop > 0 ? PRIORITIES.SERVICES + 15 : PRIORITIES.SERVICES + 11,
        message: census.firePop > 0 ?
          census.firePop + ' active fires! Score penalty -' + (census.firePop * 5) + '. Build fire station NOW.' :
          'Building fire station (ROI=' + fireROI + '). Coverage boosts score multiplier.',
        action: { type: 'build', tool: 'fire' }
      });
    }
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
    if (mapFire === 0 && canAfford) {
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


// ---- Active pollution remediation ----
//
// The AI must not just AVOID pollution — it must DETECT and FIX it when it occurs.
// From residential.js:121: pollution > 128 = zone CANNOT grow.
// From evaluation.js: pollutionAverage * 1.333 = direct score cost.
// From blockMapUtils.js: pollution sources are industrial (50), coal (100), traffic (50-75).
//
// Remediation strategies (in priority order):
//   1. Stop building industrial/coal near residential (prevention — handled by scoring)
//   2. Bulldoze abandoned zones in heavily polluted residential areas (they're dead weight)
//   3. Build parks near residential to boost land value (offsets pollution in landValue formula)
//   4. If pollution is severe: prioritize parks over new zones
//
// This method generates ACTIONABLE recommendations with real actions the AI can execute.

AIAdvisor.prototype._analyzePollution = function(census, budget) {
  var recs = [];

  // Only analyze pollution when it's actually a problem
  if (census.pollutionAverage < 40 && census.totalPop < 100) return recs;

  var breakdown = this._lastScoreBreakdown || this._calculateScoreBreakdown();

  // === CRITICAL: Pollution is the #1 score problem ===
  if (breakdown.biggestProblem === 'pollution' && breakdown.biggestProblemCost > 60) {
    var pollutedRes = this.findPollutedResidentialZone();
    if (pollutedRes) {
      recs.push({
        priority: PRIORITIES.ZONE_DEMAND + 15,
        message: 'POLLUTION CRISIS (-' + breakdown.biggestProblemCost + ' score pts). ' +
          'Residential at (' + pollutedRes.x + ',' + pollutedRes.y + ') has pollution ' +
          pollutedRes.pollution + '/128. Remediating.',
        action: { type: 'reduce_pollution' }
      });
    }
  }

  // === HIGH: Pollution average threatening residential zones ===
  if (census.pollutionAverage > 60) {
    // Check if any residential zones are being blocked
    var blockedCount = this._countBlockedResidentialZones();
    if (blockedCount > 0) {
      recs.push({
        priority: PRIORITIES.ZONE_DEMAND + 10,
        message: blockedCount + ' residential zones blocked by pollution (>128). ' +
          'Avg pollution: ' + census.pollutionAverage + '. Building parks to offset.',
        action: { type: 'reduce_pollution' }
      });
    }
  }

  return recs;
};


// Find a residential zone in a high-pollution area that should be bulldozed
// (pollution > 128 means it can NEVER grow — it's wasted space)
AIAdvisor.prototype.findPollutedResidentialZone = function() {
  var map = this.map;
  var blockMaps = this.blockMaps;
  var worst = null;
  var worstPollution = 0;

  for (var y = 2; y < map.height - 2; y += 2) {
    for (var x = 2; x < map.width - 2; x += 2) {
      var tv = map.getTileValue(x, y);
      if (!TileUtils.isResidential(tv)) continue;

      var pollution = this._safeBlockGet(blockMaps.pollutionDensityMap, x, y);
      if (pollution > worstPollution) {
        worstPollution = pollution;
        worst = { x: x, y: y, pollution: pollution };
      }
    }
  }

  return worst;
};


// Count residential zones with pollution > 128 (growth-blocked)
AIAdvisor.prototype._countBlockedResidentialZones = function() {
  var map = this.map;
  var blockMaps = this.blockMaps;
  var count = 0;

  for (var y = 2; y < map.height - 2; y += 3) {
    for (var x = 2; x < map.width - 2; x += 3) {
      var tv = map.getTileValue(x, y);
      if (!TileUtils.isResidential(tv)) continue;
      if (this._safeBlockGet(blockMaps.pollutionDensityMap, x, y) > 128) count++;
    }
  }

  return count;
};


// Find the best location for a park that would help residential zones
// near pollution sources. Parks boost terrainDensity → higher landValue.
// From: landValue = (34 - dist/2)*4 + terrainDensity - pollution
// So parks don't directly reduce pollution but boost the net landValue for
// nearby residential zones, partially compensating for pollution damage.
AIAdvisor.prototype.findPollutionParkLocation = function() {
  var map = this.map;
  var blockMaps = this.blockMaps;
  var bestScore = -Infinity;
  var bestX = -1, bestY = -1;

  for (var y = 2; y < map.height - 2; y += 2) {
    for (var x = 2; x < map.width - 2; x += 2) {
      if (map.getTileValue(x, y) !== 0) continue; // Must be empty

      // Score: near residential + in polluted area + near road
      var score = 0;
      var pollution = this._safeBlockGet(blockMaps.pollutionDensityMap, x, y);
      if (pollution < 20) continue; // Only place anti-pollution parks in polluted areas

      score += pollution; // More polluted = more benefit from park
      if (this._hasNearbyResidential(x, y, 4)) score += 100;
      else if (this._hasNearbyResidential(x, y, 8)) score += 40;
      else continue; // Must be near residential to help
      if (this._hasNearbyRoad(x, y, 2)) score += 30;
      else continue; // Parks without road access don't register

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


// ---- Abandoned zone cleanup ----
//
// Zones become "abandoned" when they lose road access, power, or are in
// lethal pollution zones. These dead zones waste map space, contribute to
// pollution (industrial), and drag down the score. The AI should detect
// and bulldoze them so the space can be reused productively.

AIAdvisor.prototype._analyzeAbandonedZones = function(budget) {
  var recs = [];
  if (budget.totalFunds < 200) return recs;

  var abandoned = this.findAbandonedZone();
  if (abandoned) {
    recs.push({
      priority: PRIORITIES.WIRE_CONNECT - 1, // Just below infrastructure fixes
      message: 'Abandoned zone at (' + abandoned.x + ',' + abandoned.y + ')' +
        (!abandoned.hasRoad ? ' — no road access' : '') +
        (!abandoned.hasPower ? ' — no power' : '') +
        '. Bulldozing to free space.',
      action: { type: 'cleanup_abandoned' }
    });
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

  // === CLOSED-LOOP: Use exact score breakdown for targeted fixes ===
  var breakdown = this._lastScoreBreakdown || this._calculateScoreBreakdown();

  // Identify the single biggest score drain and recommend the specific fix
  if (breakdown.biggestProblem && breakdown.biggestProblemCost > 50) {
    var fix = '';
    switch (breakdown.biggestProblem) {
      case 'crime':
        fix = 'Build police stations in high-crime areas.';
        break;
      case 'pollution':
        fix = 'Move industry away from residential. Parks help marginally.';
        break;
      case 'traffic':
        fix = 'Build parallel roads to reduce congestion.';
        break;
      case 'taxes':
        fix = 'Lower tax rate (each point = ~14 score).';
        break;
      case 'unemployment':
        fix = 'Balance R:(C+I) ratio for employment.';
        break;
      case 'fire':
        fix = 'Build fire stations to prevent fires.';
        break;
      case 'housing':
        // Housing score increases with land value — this is a GOOD problem to have
        fix = '(High land value = more revenue. Acceptable trade-off.)';
        break;
    }
    recs.push({
      priority: PRIORITIES.BUDGET_INFO + 8,
      message: 'Biggest score drain: ' + breakdown.biggestProblem +
        ' (-' + breakdown.biggestProblemCost + ' pts). ' + fix
    });
  }

  // Report multiplicative penalties — each -15% is devastating
  if (breakdown.penalties.length > 0) {
    var penaltyStr = breakdown.penalties.join(', ');
    var totalPenalty = Math.round((1 - breakdown.multiplier) * 100);
    recs.push({
      priority: PRIORITIES.BUDGET_INFO + 12,
      message: 'SCORE MULTIPLIER: -' + totalPenalty + '% from ' + penaltyStr +
        '. Fix these FIRST — multiplicative penalty on entire score!'
    });
  }

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

  // Fund depletion warning
  var depletion = this._predictFundDepletion();
  if (depletion.cyclesUntilBroke < 5 && depletion.cyclesUntilBroke !== Infinity) {
    recs.push({
      priority: PRIORITIES.BUDGET_INFO + 20,
      message: 'BANKRUPT in ~' + depletion.cyclesUntilBroke + ' tax cycles! Net $' +
        depletion.netFlow + '/yr (rev $' + depletion.revenue + ' - maint $' + depletion.maintenance + ').'
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

  // Step=1 to check EVERY position. Step=2 missed all grid-aligned positions
  // when gx was odd (scan hit only even x, grid positions were all odd).
  // Cost: ~12k positions vs ~3k, but _isAreaClear rejects most in 9 tile reads. <1ms.
  for (var y = 1; y < map.height - 1; y++) {
    for (var x = 1; x < map.width - 1; x++) {
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
    // CRITICAL: Always add vertical connectors between main road and parallel
    // road, otherwise the parallel road is DISCONNECTED from the network.
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
      // Add vertical connector from main road to parallel road
      if (gy - 4 >= 0) {
        for (var ry = gy - 1; ry >= gy - 4; ry--) {
          path.push({ x: extendX, y: ry });
        }
        // Add parallel road north at gy-4 for new zone slots
        for (var rx2 = extendX + 1; rx2 < extendX + 4 && rx2 < map.width; rx2++) {
          path.push({ x: rx2, y: gy - 4 });
        }
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
      // Add vertical connector for west extension too
      if (gy - 4 >= 0) {
        for (var ry = gy - 1; ry >= gy - 4; ry--) {
          path.push({ x: extendX, y: ry });
        }
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
      // Use CONNECTED road check — a disconnected fragment is not "connected"
      if (this._hasAdjacentConnectedRoad(x, y)) continue;

      // Build toward the CONNECTED network, not any random road fragment.
      // Old code used _findNearestRoad which found disconnected fragments,
      // creating MORE disconnected infrastructure.
      var roadTarget = this._findNearestConnectedRoad(x, y);
      if (!roadTarget) {
        // No connected network yet — fall back to any road
        roadTarget = this._findNearestRoad(x, y);
      }
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
// === COMMERCIAL POWER PRIORITY (closed-loop fix) ===
// From commercial.js line 126: `if (zonePower && zoneScore > -350 ...)`
// Commercial zones REQUIRE power to grow but can degrade WITHOUT power.
// This means unpowered commercial zones are actively losing population
// while gaining nothing. Prioritize wiring commercial zones first.
AIAdvisor.prototype.findWireToConnect = function() {
  var map = this.map;
  var width = map.width;
  var height = map.height;

  // Two passes: first commercial (power-critical), then everything else
  for (var pass = 0; pass < 2; pass++) {
    for (var y = 1; y < height - 1; y++) {
      for (var x = 1; x < width - 1; x++) {
        var tile = map.getTile(x, y);
        if (!tile.isZone()) continue;
        if (tile.isPowered()) continue;

        // Pass 0: only commercial. Pass 1: everything else.
        var tv = map.getTileValue(x, y);
        var isCommercialZone = TileUtils.isCommercial(tv);
        if (pass === 0 && !isCommercialZone) continue;
        if (pass === 1 && isCommercialZone) continue;

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
  // === BLACKLIST CHECK ===
  // If the AI previously placed a zone here and it failed, avoid repeating the mistake.
  if (this.isLocationBlacklisted(x, y)) return -9999;

  var score = 0;
  var blockMaps = this.blockMaps;

  // Road adjacency is critical — from simulation source:
  // zones without road access fail traffic check → DEGRADE
  // MUST use connected road check — disconnected fragments don't count!
  if (this._hasNearbyConnectedRoad(x, y, 2)) score += 150;
  else if (this._hasNearbyConnectedRoad(x, y, 4)) score += 60;
  else if (this._hasNearbyConnectedRoad(x, y, 8)) score += 10;
  else return -9999;

  // === COMPACTNESS BONUS (DOMINANT FACTOR) ===
  // A compact city EXPONENTIALLY outperforms a sprawling one:
  // - Traffic routes complete in fewer steps → zones don't degrade
  // - Power plants cover more zones → fewer plants needed
  // - Police/fire stations cover more zones → less maintenance
  // - Land value rises faster with nearby development
  // - Roads serve more zones → less road maintenance per zone
  // Count existing zone centers within 6 tiles. Each nearby zone = +40 score.
  // In a compact city (4-tile spacing), a location has ~4-6 neighbors → +160-240.
  // An isolated location has 0 neighbors → +0. Difference: +160-240.
  // This MUST dominate other factors to prevent sprawl.
  var nearbyZones = this._countNearbyZones(x, y, 6);
  score += nearbyZones * 40;

  // === SPRAWL PENALTY (ZONE-TYPE AWARE) ===
  // Penalize locations far from the grid origin (starter city center).
  // Industrial zones get SOFTER penalty — they naturally go south of core (further away)
  // and need more space. Residential/commercial get stronger penalty for compactness.
  if (this._plan.initialized) {
    var gx = this._plan.gridOriginX;
    var gy = this._plan.gridOriginY;
    var distFromCore = Math.abs(x - gx) + Math.abs(y - gy);
    var isIndustrial = (toolName === 'industrial');
    // Industrial: softer penalty (1.5/tile vs 3/tile) and wider limits
    var basePenalty = isIndustrial ? 1.5 : 3;
    var accelPenalty = isIndustrial ? 3 : 6;
    var accelThreshold = isIndustrial ? 25 : 20;
    var hardCap = isIndustrial ? 45 : 35;
    score -= distFromCore * basePenalty;
    if (distFromCore > accelThreshold) score -= (distFromCore - accelThreshold) * accelPenalty;
    if (distFromCore > hardCap) return -9999;
  }

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

  // DISTRICT RULES — residential north, industrial south of main road.
  // Residential: STRONG penalty south of main road (pollution from industry),
  // but allow a small buffer zone (up to 4 tiles south) for expansion flexibility.
  // Industrial: HARD reject north of main road (would pollute residential).
  if (this._plan.initialized) {
    var gridY = this._plan.gridOriginY;
    if (toolName === 'residential' && y > gridY) {
      var southOverlap = y - gridY;
      if (southOverlap > 4) return -9999; // Too far into industrial zone
      score -= southOverlap * 80; // Strong penalty but not hard reject
    }
    if (toolName === 'industrial' && y <= gridY) return -9999;
  }

  switch (toolName) {
    case 'residential':
      // === POLLUTION CHECK ===
      // From residential.js:121: pollution > 128 = zone CANNOT grow AT ALL.
      // Hard gate: use ACTUAL blockMap pollution (game engine truth).
      // The prediction model overestimates by 2-5x (exponential decay doesn't match
      // the game's 2-pass block smoothing), so using it for the hard gate
      // rejects valid locations. Use prediction only as a soft penalty.
      if (pollution > SAFE_RESIDENTIAL_POLLUTION) return -9999;
      // Soft penalty for predicted future pollution risk
      var predictedPollution = this._predictPollutionAt(x, y);
      if (predictedPollution > pollution) {
        score -= (predictedPollution - pollution) * 2;
      }
      if (this._hasNearbyIndustrial(x, y, MIN_INDUSTRY_RESIDENTIAL_GAP)) return -9999;

      // === HARD GATE: TRAFFIC ROUTING CHECK ===
      // From traffic.js: residential routes to COMMERCIAL within 30 tiles.
      // If no commercial zone reachable → traffic check WILL fail → zone degrades.
      // This is wasted money. NEVER place without a route target.
      if (!this._hasTrafficRouteTarget(x, y, 'residential')) {
        return -9999; // HARD GATE — zone WILL degrade from routing failure
      }

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

      // Crime degrades land value → suppresses growth → cascading penalty
      score -= crime * 2;
      score -= traffic;
      if (this._hasNearbyResidential(x, y, 6)) score += 80;
      if (this._hasNearbyCommercial(x, y, 15) || this._hasNearbyIndustrial(x, y, 25)) score += 30;
      else score -= 50;
      break;

    case 'commercial':
      // === PROACTIVE: Commercial REQUIRES power to grow (commercial.js:126) ===
      // But can degrade without power. Unpowered commercial = actively losing money.
      if (!this._hasNearbyPower(x, y, 6)) score -= 100;

      // === PROACTIVE: Commercial growth cap = landValue >> 5 ===
      // From commercial.js:48: growth stops when population > (landValue >> 5)
      // Don't waste money placing commercial where it can't fully develop.
      var maxComPop = this._maxCommercialPopAt(x, y);
      if (maxComPop < 1) return -9999; // Land value too low — zone will NEVER grow
      if (maxComPop < 3) score -= 60;  // Will be stunted
      score += maxComPop * 20;         // Bonus for high growth potential

      // === PROACTIVE: Commercial locationScore = cityCentreDistScore (-64 to 64) ===
      // Commercial benefits enormously from center proximity
      if (pollution > 128) return -9999;

      // === HARD GATE: Commercial routes to INDUSTRIAL ===
      if (!this._hasTrafficRouteTarget(x, y, 'commercial')) {
        return -9999; // HARD GATE — zone WILL degrade from routing failure
      }

      score += landValue * 3;
      score -= pollution * 2;
      if (this._hasNearbyResidential(x, y, 10)) score += 50;
      else score -= 40;
      if (this._hasNearbyCommercial(x, y, 6)) score += 60;
      // Commercial locationScore is distance-based — closer to center is better
      var cdx = x - this.map.cityCentreX;
      var cdy = y - this.map.cityCentreY;
      var dist = Math.sqrt(cdx * cdx + cdy * cdy);
      score += Math.max(0, 64 - Math.floor(dist));
      // === DISTRICT RULE: Commercial belongs NORTH (residential side) ===
      // Commercial customers are residential. Place near them for land value,
      // traffic routing success, and logical district separation.
      // Without this, commercial freely scores well in the industrial zone
      // south of the main road due to +60 center bonus dwarfing the old -3/tile.
      if (this._plan.initialized) {
        var gridY = this._plan.gridOriginY;
        if (y > gridY) {
          // South of main road — strong penalty, hard reject past 6 tiles
          var southDist = y - gridY;
          score -= southDist * 30;
          if (southDist > 6) return -9999;
        } else {
          // North of main road — bonus for being near residential
          score += 30;
        }
      }
      break;

    case 'industrial':
      // HARD GATE: Never place industrial within MIN_INDUSTRY_RESIDENTIAL_GAP of residential
      if (this._hasNearbyResidential(x, y, MIN_INDUSTRY_RESIDENTIAL_GAP)) return -9999;

      // === PROACTIVE: Industrial pollutes (50/tile) ===
      // After smoothing: 50 * 0.6^d at distance d. Cumulative with other sources.
      // Even at safe gap distance, check if adding 50 base here would compound
      // with existing pollution to push nearby residential over threshold.
      if (this._hasNearbyResidential(x, y, 12)) {
        var nearResPollution = this._checkNearbyResidentialPollution(x, y, 12);
        if (nearResPollution > 50) {
          return -9999; // HARD GATE: residential already at risk, don't add more pollution
        }
        if (nearResPollution > 30) {
          score -= 300; // Strong penalty — getting close to danger zone
        }
      }

      // === HARD GATE: Industrial routes to RESIDENTIAL ===
      if (!this._hasTrafficRouteTarget(x, y, 'industrial')) {
        return -9999; // HARD GATE — zone WILL degrade from routing failure
      }

      // Industrial doesn't care about land value or pollution
      score -= landValue; // Prefer cheap land (saves land value for res/com)
      score += 30;
      if (this._hasNearbyIndustrial(x, y, 6)) score += 80;
      if (this._hasNearbyResidential(x, y, 25)) score += 20;
      else score -= 30;
      break;

    case 'police':
      // === PROACTIVE: Police coverage radius ~8-10 tiles after 3 smoothing passes ===
      // Crime formula: (128 - landValue) + popDensity - policeEffect
      // Score cost: crimeAvg * 1.333 points. Each station saves ~40-80 score points.
      var policeEffect = this._safeBlockGet(blockMaps.policeStationEffectMap, x, y);
      score += (1000 - policeEffect);
      score += crime * 3;
      score += popDensity * 2;
      // Don't place within another station's radius — coverage overlaps waste money
      if (this._hasNearbyBuilding(x, y, TileValues.POLICESTATION, 15)) score -= 400;
      // === PROACTIVE: Prefer placement that covers highest landValue areas ===
      // Protecting high landValue prevents the crime→landValue→crime death spiral
      score += landValue;
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
  // Center proximity matters for commercial especially.
  var dx = x - this.map.cityCentreX;
  var dy = y - this.map.cityCentreY;
  score -= Math.sqrt(dx * dx + dy * dy) * 0.5;

  return score;
};


AIAdvisor.prototype._scoreLargeLocation = function(x, y, toolName) {
  var score = 0;

  // SPRAWL PENALTY for large buildings — but NOT for coal/nuclear power plants.
  // Coal/nuclear MUST be far from residential (MIN_POWER_PLANT_RESIDENTIAL_GAP).
  // Penalizing distance-from-core conflicts with that requirement because
  // residential IS at the core. Power plants are exempt by design.
  // Stadiums, ports, airports still get sprawl penalty.
  if (this._plan.initialized && toolName !== 'coal' && toolName !== 'nuclear') {
    var gx = this._plan.gridOriginX;
    var gy = this._plan.gridOriginY;
    var distFromCore = Math.abs(x - gx) + Math.abs(y - gy);
    score -= distFromCore * 2;
    if (distFromCore > 30) score -= (distFromCore - 30) * 4;
  }
  var blockMaps = this.blockMaps;

  // Must be near CONNECTED road network — disconnected fragments don't count
  if (this._hasNearbyConnectedRoad(x, y, 4)) score += 80;
  else if (this._hasNearbyConnectedRoad(x, y, 8)) score += 20;
  else return -9999; // Too far from connected road network

  if (this._hasNearbyPower(x, y, 6)) score += 40;

  var landValue = this._safeBlockGet(blockMaps.landValueMap, x, y);

  switch (toolName) {
    case 'coal':
    case 'nuclear':
      // === PROACTIVE: Coal/nuclear emit 100 pollution per tile ===
      // After 2-pass smoothing: 100 * 0.6^d pollution at distance d.
      //   d=4 → 13 pollution, d=6 → 5, d=8 → 2, d=10 → 0.6
      // HARD GATE: NEVER place within MIN_POWER_PLANT_RESIDENTIAL_GAP of residential.
      // Coal/nuclear at distance 6 from residential adds ~5 pollution but CUMULATIVE
      // with existing sources (industry, traffic) can push over 128 threshold.
      if (this._hasNearbyResidential(x, y, MIN_POWER_PLANT_RESIDENTIAL_GAP)) return -9999;
      // Strong bonus for being far from residential
      if (!this._hasNearbyResidential(x, y, 15)) score += 150;
      else if (!this._hasNearbyResidential(x, y, 12)) score += 80;
      // Check if this would push any nearby residential over pollution threshold
      var nearResPollution = this._checkNearbyResidentialPollution(x, y, 15);
      if (nearResPollution > 30) score -= 300; // Existing pollution + coal = danger
      // Prefer near industrial (already polluted area, no downside)
      if (this._hasNearbyIndustrial(x, y, 10)) score += 50;
      // Prefer edges of map (away from everything)
      var edgeBonus = Math.min(x, y, this.map.width - x, this.map.height - y);
      if (edgeBonus < 15) score += 30;
      score -= landValue; // Prefer cheap land
      break;

    case 'stadium':
      // Stadium removes resCap (+15% score). Place near high-density residential.
      var popDensity = this._safeBlockGet(blockMaps.populationDensityMap, x, y);
      score += popDensity * 2;
      score += landValue;
      // Prefer residential side of city (north of main road in our layout)
      if (this._plan.initialized && y < this._plan.gridOriginY) score += 30;
      break;

    case 'port':
      // Seaport MUST be near water — no exceptions
      if (this._hasNearbyWater(x, y, 3)) score += 150;
      else score -= 500;
      // Prefer industrial side (south) — seaport serves industry
      if (this._plan.initialized && y > this._plan.gridOriginY) score += 20;
      break;

    case 'airport':
      // Airport is 6x6 — needs lots of space. Prefer outskirts.
      // Also generates some pollution from traffic, keep from residential.
      score -= landValue;
      if (!this._hasNearbyResidential(x, y, 8)) score += 30;
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


// Check if zone has an adjacent road that's part of the CONNECTED network.
// This is the critical distinction: _hasAdjacentRoad finds ANY road (including
// disconnected fragments), but zones need roads connected to the MAIN network
// to route traffic. Without a connected road, traffic check fails → zone degrades.
AIAdvisor.prototype._hasAdjacentConnectedRoad = function(x, y) {
  if (!this._connectedRoads) return false;
  var map = this.map;
  var checks = [[-1,0],[1,0],[0,-1],[0,1],[-2,0],[2,0],[0,-2],[0,2]];
  for (var i = 0; i < checks.length; i++) {
    var nx = x + checks[i][0];
    var ny = y + checks[i][1];
    if (nx >= 0 && ny >= 0 && nx < map.width && ny < map.height) {
      if (TileUtils.isRoad(map.getTileValue(nx, ny)) &&
          this._connectedRoads[nx + ',' + ny]) {
        return true;
      }
    }
  }
  return false;
};


// Count zones that have NO adjacent CONNECTED road — these are completely broken
// and will fail every traffic check, degrading immediately.
// Uses _hasAdjacentConnectedRoad instead of _hasAdjacentRoad so zones with
// disconnected road fragments are correctly identified as broken.
AIAdvisor.prototype._countDisconnectedZones = function() {
  var map = this.map;
  var count = 0;
  for (var y = 1; y < map.height - 1; y++) {
    for (var x = 1; x < map.width - 1; x++) {
      if (!map.getTile(x, y).isZone()) continue;
      if (!this._hasAdjacentConnectedRoad(x, y)) count++;
    }
  }
  return count;
};


// Count existing zone centers within radius of a location.
// Used for COMPACTNESS scoring — a location surrounded by existing zones
// is FAR better than an isolated location in the middle of nowhere.
// In SimCity, compact cities outperform sprawling ones in every metric:
// traffic routing, power coverage, police/fire coverage, land value.
AIAdvisor.prototype._countNearbyZones = function(x, y, radius) {
  var map = this.map;
  var count = 0;
  for (var dy = -radius; dy <= radius; dy++) {
    for (var dx = -radius; dx <= radius; dx++) {
      var nx = x + dx;
      var ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= map.width || ny >= map.height) continue;
      if (map.getTile(nx, ny).isZone()) count++;
    }
  }
  return count;
};


// Count zone types on the map. Called once per analyze() cycle.
// Results cached in this._zoneCounts for zone balance enforcement.
AIAdvisor.prototype._countZoneTypes = function() {
  var map = this.map;
  var res = 0, com = 0, ind = 0;
  // Map-based counting: always accurate, unlike census which lags 1 cycle.
  // Prevents duplicate builds (e.g., 2 coal plants) when census hasn't updated yet.
  var coal = 0, nuclear = 0, fire = 0, police = 0;
  for (var y = 1; y < map.height - 1; y++) {
    for (var x = 1; x < map.width - 1; x++) {
      var tv = map.getTileValue(x, y);
      if (TileUtils.isResidential(tv)) res++;
      else if (TileUtils.isCommercial(tv)) com++;
      else if (TileUtils.isIndustrial(tv)) ind++;
      // Power plants and services: zone center tiles (from tileValues.ts)
      else if (tv === 750) coal++;          // POWERPLANT zone center
      else if (tv === 816) nuclear++;       // NUCLEAR zone center
      else if (tv === 765) fire++;          // FIRESTATION zone center
      else if (tv === 774) police++;        // POLICESTATION zone center
    }
  }
  this._zoneCounts = {
    res: res, com: com, ind: ind, total: res + com + ind,
    coalPlants: coal, nuclearPlants: nuclear,
    fireStations: fire, policeStations: police
  };
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


// Check the maximum pollution at any nearby residential zone.
// Used by industrial placement to avoid pushing residential zones
// over the fatal 128 pollution threshold.
AIAdvisor.prototype._checkNearbyResidentialPollution = function(x, y, radius) {
  var map = this.map;
  var maxPollution = 0;
  for (var dy = -radius; dy <= radius; dy++) {
    for (var dx = -radius; dx <= radius; dx++) {
      var nx = x + dx;
      var ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= map.width || ny >= map.height) continue;
      if (TileUtils.isResidential(map.getTileValue(nx, ny))) {
        var p = this._safeBlockGet(this.blockMaps.pollutionDensityMap, nx, ny);
        if (p > maxPollution) maxPollution = p;
      }
    }
  }
  return maxPollution;
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


// ---- Performance tracking & self-assessment ----

// Record the outcome of an action (called by aiHelper after each action)
AIAdvisor.prototype._recordOutcome = function(result) {
  this._recentOutcomes.push({ result: result, time: Date.now() });
  if (this._recentOutcomes.length > 20) this._recentOutcomes.shift();

  // Track failure rate for diagnostics (shown in AI panel) but do NOT
  // suppress zone building. Cautious mode created deadlocks — see _analyzeZoneDemand.
  this._strategyOverride = null; // Always null — cautious mode removed
};


// Check prediction accuracy — compare previous valve predictions against actual values
AIAdvisor.prototype._checkPredictionAccuracy = function() {
  var prev = this._previousValvePrediction;
  var valves = this.simulation._valves;
  if (!prev) return;

  // Direction accuracy: did we correctly predict which way each valve moved?
  var checks = [
    { predicted: prev.nextRes, actual: valves.resValve, prevActual: prev.actualRes },
    { predicted: prev.nextCom, actual: valves.comValve, prevActual: prev.actualCom },
    { predicted: prev.nextInd, actual: valves.indValve, prevActual: prev.actualInd }
  ];

  for (var i = 0; i < checks.length; i++) {
    var c = checks[i];
    if (c.prevActual === undefined) continue;
    var predictedDir = c.predicted > c.prevActual ? 1 : (c.predicted < c.prevActual ? -1 : 0);
    var actualDir = c.actual > c.prevActual ? 1 : (c.actual < c.prevActual ? -1 : 0);
    this._predictionTotal++;
    if (predictedDir === actualDir) this._predictionHits++;
  }
};


// Get phase-appropriate goals
AIAdvisor.prototype._getPhaseGoals = function() {
  var phase = this._getPhase();
  var census = this.simulation._census;
  var eval_ = this.simulation.evaluation;
  var budget = this.simulation.budget;
  var valves = this.simulation._valves;
  var goals = [];

  switch (phase) {
    case 'bootstrap':
      goals.push({
        label: 'Starter city built',
        met: (census.poweredZoneCount + census.unpoweredZoneCount) >= 3
      });
      goals.push({
        label: 'Power plant placed',
        met: census.coalPowerPop > 0 || census.nuclearPowerPop > 0
      });
      break;

    case 'early':
      goals.push({
        label: 'Pop > 50',
        met: census.totalPop > 50
      });
      goals.push({
        label: 'All zones powered',
        met: census.unpoweredZoneCount === 0
      });
      goals.push({
        label: 'Score > 400',
        met: eval_.cityScore > 400
      });
      break;

    case 'growth':
      goals.push({
        label: 'Reach Town (2k)',
        met: census.totalPop >= 2000
      });
      goals.push({
        label: 'Score > 500',
        met: eval_.cityScore > 500
      });
      goals.push({
        label: 'Positive cash flow',
        met: this._projectRevenue(budget.cityTax) > this._projectMaintenance()
      });
      goals.push({
        label: 'No demand caps',
        met: !valves.resCap && !valves.comCap && !valves.indCap
      });
      break;

    case 'metro':
      goals.push({
        label: 'Reach City (10k)',
        met: census.totalPop >= 10000
      });
      goals.push({
        label: 'Score > 700',
        met: eval_.cityScore > 700
      });
      goals.push({
        label: 'Growing pop',
        met: this._popGrowthRate > 0
      });
      goals.push({
        label: 'No demand caps',
        met: !valves.resCap && !valves.comCap && !valves.indCap
      });
      break;
  }

  return goals;
};


// Compute letter grade from multiple signals
AIAdvisor.prototype._computeGrade = function(successRate, trend, goals, score) {
  // Weighted: success rate 40%, trend 20%, goals 20%, absolute score 20%
  var successScore = successRate; // 0-100

  var trendScore;
  if (trend === 'improving') trendScore = 100;
  else if (trend === 'stable') trendScore = 60;
  else trendScore = 20; // declining

  var goalsMet = 0;
  var goalsTotal = goals.length || 1;
  for (var i = 0; i < goals.length; i++) {
    if (goals[i].met) goalsMet++;
  }
  var goalsScore = (goalsMet / goalsTotal) * 100;

  var absScore = Math.min(score / 7, 100); // score 700 = 100%

  var weighted = successScore * 0.4 + trendScore * 0.2 + goalsScore * 0.2 + absScore * 0.2;

  if (weighted >= 85) return 'A';
  if (weighted >= 70) return 'B';
  if (weighted >= 50) return 'C';
  if (weighted >= 30) return 'D';
  return 'F';
};


// Main performance metrics getter — called by aiHelper for UI updates
AIAdvisor.prototype.getPerformanceMetrics = function(successCount, failCount, neutralCount, totalActions) {
  var census = this.simulation._census;
  var eval_ = this.simulation.evaluation;

  // Success rate
  var totalOutcomes = successCount + failCount + neutralCount;
  var successRate = totalOutcomes > 0 ? Math.round(successCount / totalOutcomes * 100) : 0;

  // Growth trend from _growthHistory
  var trend = 'stable';
  if (this._growthHistory.length >= 3) {
    var recent = this._growthHistory.slice(-3);
    var positiveCount = 0;
    var negativeCount = 0;
    for (var i = 0; i < recent.length; i++) {
      if (recent[i] > 0) positiveCount++;
      if (recent[i] < 0) negativeCount++;
    }
    if (positiveCount >= 2) trend = 'improving';
    else if (negativeCount >= 2) trend = 'declining';
  }

  // Check prediction accuracy
  this._checkPredictionAccuracy();
  // Store current valve state for next comparison
  if (this._lastValvePrediction) {
    this._previousValvePrediction = {
      nextRes: this._lastValvePrediction.nextRes,
      nextCom: this._lastValvePrediction.nextCom,
      nextInd: this._lastValvePrediction.nextInd,
      actualRes: this.simulation._valves.resValve,
      actualCom: this.simulation._valves.comValve,
      actualInd: this.simulation._valves.indValve
    };
  }
  var predictionAccuracy = this._predictionTotal > 0 ?
    Math.round(this._predictionHits / this._predictionTotal * 100) : null;

  // Phase goals
  var goals = this._getPhaseGoals();

  // Grade
  var grade = this._computeGrade(successRate, trend, goals, eval_.cityScore);

  return {
    grade: grade,
    successRate: successRate,
    trend: trend,
    goals: goals,
    predictionAccuracy: predictionAccuracy,
    totalActions: totalActions,
    phase: this._getPhase(),
    strategyOverride: this._strategyOverride
  };
};


// === ZONE HEALTH AUDIT ===
//
// The AI equivalent of a human looking at the game and saying:
// "That zone has a red X — it has no road. That commercial zone is in the
// wrong place. That residential zone is choking on pollution."
//
// Scans EVERY zone on the map and checks ALL conditions the game engine
// requires for growth (from residential.js, commercial.js, industrial.js):
//   1. Road connectivity to the main network
//   2. Power access (critical for commercial)
//   3. Traffic routing to complementary zone type
//   4. Pollution level (lethal for residential > 128)
//   5. Land value (commercial growth capped by landValue >> 5)
//
// Returns a prioritized list of sick zones with specific diagnoses and fixes.

AIAdvisor.prototype.auditAllZones = function() {
  var map = this.map;
  var blockMaps = this.blockMaps;
  var issues = [];

  // Rebuild road network for fresh connectivity data
  this._buildRoadNetworkMap();

  for (var y = 1; y < map.height - 1; y++) {
    for (var x = 1; x < map.width - 1; x++) {
      var tile = map.getTile(x, y);
      if (!tile.isZone()) continue;

      var tv = map.getTileValue(x, y);
      var isRes = TileUtils.isResidential(tv);
      var isCom = TileUtils.isCommercial(tv);
      var isInd = TileUtils.isIndustrial(tv);
      if (!isRes && !isCom && !isInd) continue; // Skip non-RCI zones (power plants, etc.)

      var zoneType = isRes ? 'residential' : (isCom ? 'commercial' : 'industrial');
      var pollution = this._safeBlockGet(blockMaps.pollutionDensityMap, x, y);
      var hasRoad = this._hasAdjacentConnectedRoad(x, y);
      var hasPower = tile.isPowered();
      var problems = [];

      // 1. ROAD CONNECTIVITY — zone degrades immediately without connected road
      if (!hasRoad) {
        var nearNetwork = this._hasNearbyConnectedRoad(x, y, 8);
        problems.push({
          type: 'no_road',
          severity: nearNetwork ? 3 : 5,
          fix: nearNetwork ? 'build_road' : 'bulldoze'
        });
      }

      // 2. POWER — commercial REQUIRES power (commercial.js:126), others degrade
      if (!hasPower) {
        problems.push({
          type: 'no_power',
          severity: isCom ? 4 : 2,
          fix: 'wire_power'
        });
      }

      // 3. TRAFFIC ROUTING — zone MUST route to complementary type within 30 tiles
      // Only meaningful if zone has road (needs road to route traffic)
      if (hasRoad && !this._hasTrafficRouteTarget(x, y, zoneType)) {
        var target = isRes ? 'commercial' : (isCom ? 'industrial' : 'residential');
        problems.push({
          type: 'no_traffic_route',
          severity: 4,
          fix: 'build_complementary',
          targetType: target
        });
      }

      // 4. POLLUTION — residential hard-blocked at 128 (residential.js:121)
      if (isRes && pollution > 128) {
        problems.push({
          type: 'lethal_pollution',
          severity: 5,
          fix: 'bulldoze'
        });
      } else if (isRes && pollution > SAFE_RESIDENTIAL_POLLUTION) {
        // Not lethal yet but growth severely impaired
        problems.push({
          type: 'high_pollution',
          severity: 2,
          fix: 'build_park'
        });
      }

      // 5. LAND VALUE — commercial growth cap = landValue >> 5 (commercial.js:48)
      if (isCom) {
        var maxPop = this._maxCommercialPopAt(x, y);
        if (maxPop < 1) {
          problems.push({
            type: 'low_land_value',
            severity: 3,
            fix: 'build_park'
          });
        }
      }

      // 6. BOTH BROKEN — no road AND no power = definitely dead
      if (!hasRoad && !hasPower) {
        // Compound severity — this zone is hopeless unless very close to network
        var anyNearby = this._hasNearbyConnectedRoad(x, y, 5);
        if (!anyNearby) {
          problems.push({
            type: 'completely_stranded',
            severity: 5,
            fix: 'bulldoze'
          });
        }
      }

      if (problems.length > 0) {
        problems.sort(function(a, b) { return b.severity - a.severity; });
        issues.push({
          x: x, y: y,
          zoneType: zoneType,
          problems: problems,
          worstSeverity: problems[0].severity,
          topFix: problems[0].fix,
          targetType: problems[0].targetType || null
        });
      }
    }
  }

  // Sort by worst severity descending — fix the most critical zones first
  issues.sort(function(a, b) { return b.worstSeverity - a.worstSeverity; });
  this._zoneHealthIssues = issues;
  return issues;
};


// Convert the top zone health issue into an actionable recommendation.
// This is what gets injected into decideBestAction() at high priority.
AIAdvisor.prototype.getTopHealthAction = function() {
  var issues = this._zoneHealthIssues;
  if (!issues || issues.length === 0) return null;

  var top = issues[0];
  if (top.worstSeverity < 2) return null; // Minor issues don't warrant immediate action

  switch (top.topFix) {
    case 'bulldoze':
      return {
        priority: PRIORITIES.ROAD_CONNECT + 5, // Higher than normal infrastructure
        message: 'HEALTH AUDIT: ' + top.zoneType + ' at (' + top.x + ',' + top.y +
          ') is dead (' + top.problems[0].type + '). Bulldozing.',
        action: { type: 'cleanup_abandoned' }
      };

    case 'build_road':
      return {
        priority: PRIORITIES.ROAD_CONNECT,
        message: 'HEALTH AUDIT: ' + top.zoneType + ' at (' + top.x + ',' + top.y +
          ') has no connected road. Building road to network.',
        action: { type: 'build_roads' }
      };

    case 'wire_power':
      return {
        priority: PRIORITIES.WIRE_CONNECT,
        message: 'HEALTH AUDIT: ' + top.zoneType + ' at (' + top.x + ',' + top.y +
          ') is unpowered' + (top.zoneType === 'commercial' ? ' (CANNOT grow)' : '') + '.',
        action: { type: 'wire_connect' }
      };

    case 'build_complementary':
      // Zone exists but has no traffic route target — need to build the missing type
      var tool = top.targetType;
      return {
        priority: PRIORITIES.ZONE_DEMAND + 10, // Slightly above normal demand
        message: 'HEALTH AUDIT: ' + top.zoneType + ' at (' + top.x + ',' + top.y +
          ') cannot route traffic. Need ' + tool + ' within 18 tiles.',
        action: { type: 'build', tool: tool }
      };

    case 'build_park':
      return {
        priority: PRIORITIES.PARKS + 10,
        message: 'HEALTH AUDIT: ' + top.zoneType + ' at (' + top.x + ',' + top.y +
          ') needs land value boost. Building park.',
        action: { type: 'build_park', x: top.x, y: top.y - 2 } // Park near zone
      };

    default:
      return null;
  }
};


// Blacklist a location where a zone failed. Prevents the AI from
// repeating the same mistake at the same spot.
AIAdvisor.prototype.blacklistLocation = function(x, y) {
  // Blacklist expires after 50 audit ticks (~150 action cycles)
  // so locations become available again as city infrastructure grows.
  this._blacklistedLocations[x + ',' + y] = this._auditTick + 50;
};

AIAdvisor.prototype.isLocationBlacklisted = function(x, y) {
  var key = x + ',' + y;
  var expiry = this._blacklistedLocations[key];
  if (!expiry) return false;
  if (this._auditTick > expiry) {
    delete this._blacklistedLocations[key];
    return false;
  }
  return true;
};


export { AIAdvisor };
