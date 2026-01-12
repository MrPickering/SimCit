/* SimCit Undo Manager
 * Tracks tile changes and allows undoing placement mistakes
 */

import { Tile } from "./tile.ts";

var MAX_UNDO_STACK = 50; // Maximum number of undo actions to keep

function UndoManager(map) {
  this._map = map;
  this._undoStack = [];
  this._enabled = true;
}

// Capture the current state of tiles that will be modified
// Returns an action object that can be passed to recordAction
UndoManager.prototype.captureState = function(worldEffects) {
  if (!this._enabled) return null;

  var action = {
    tiles: [],
    timestamp: Date.now()
  };

  // Get all the coordinates that will be modified
  var keys = Object.keys(worldEffects._data);

  for (var i = 0; i < keys.length; i++) {
    var key = keys[i];
    var coords = key.split(',');
    var x = parseInt(coords[0], 10);
    var y = parseInt(coords[1], 10);

    // Get the ORIGINAL tile value from the map (not from worldEffects)
    var originalTile = this._map.getTile(x, y);

    action.tiles.push({
      x: x,
      y: y,
      tile: new Tile(originalTile.getValue(), originalTile.getFlags())
    });
  }

  return action;
};

// Record an action after it has been applied
UndoManager.prototype.recordAction = function(action) {
  if (!this._enabled || !action || action.tiles.length === 0) return;

  this._undoStack.push(action);

  // Trim stack if it's too large
  while (this._undoStack.length > MAX_UNDO_STACK) {
    this._undoStack.shift();
  }
};

// Undo the last action
UndoManager.prototype.undo = function() {
  if (this._undoStack.length === 0) return false;

  var action = this._undoStack.pop();

  // Restore all tiles to their original state
  for (var i = 0; i < action.tiles.length; i++) {
    var tileData = action.tiles[i];
    this._map.setTo({ x: tileData.x, y: tileData.y }, tileData.tile);
  }

  return true;
};

// Check if undo is available
UndoManager.prototype.canUndo = function() {
  return this._undoStack.length > 0;
};

// Get the number of available undo actions
UndoManager.prototype.getUndoCount = function() {
  return this._undoStack.length;
};

// Clear all undo history
UndoManager.prototype.clear = function() {
  this._undoStack = [];
};

// Enable/disable undo tracking
UndoManager.prototype.setEnabled = function(enabled) {
  this._enabled = enabled;
};

export { UndoManager };
