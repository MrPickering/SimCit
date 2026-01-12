/* micropolisJS. Adapted by Graeme McCutcheon from Micropolis.
 *
 * This code is released under the GNU GPL v3, with some additional terms.
 * Please see the files LICENSE and COPYING for details. Alternatively,
 * consult http://micropolisjs.graememcc.co.uk/LICENSE and
 * http://micropolisjs.graememcc.co.uk/COPYING
 *
 * The name/term "MICROPOLIS" is a registered trademark of Micropolis (https://www.micropolis.com) GmbH
 * (Micropolis Corporation, the "licensor") and is licensed here to the authors/publishers of the "Micropolis"
 * city simulation game and its source code (the project or "licensee(s)") as a courtesy of the owner.
 *
 */

import { MiscUtils } from './miscUtils.js';

// A very thin wrapper around localStorage, in case we wish to move to some other storage mechanism
// (such as indexedDB) in the future

var getSavedGame = function() {
  var savedGame = window.localStorage.getItem(this.KEY);

  if (savedGame !== null) {
    savedGame = JSON.parse(savedGame);

    if (savedGame.version !== this.CURRENT_VERSION)
      this.transitionOldSave(savedGame);

    // Flag as a saved game for Game/Simulation etc...
    savedGame.isSavedGame = true;
  }

  return savedGame;
};


var saveGame = function(gameData) {
  gameData.version = this.CURRENT_VERSION;
  gameData = JSON.stringify(gameData);

  window.localStorage.setItem(this.KEY, gameData);
};


var transitionOldSave = function(savedGame) {
  switch (savedGame.version) {
    case 1:
      savedGame.everClicked = false;

      /* falls through */
    case 2:
      savedGame.pollutionMaxX = Math.floor(savedGame.width / 2);
      savedGame.pollutionMaxY = Math.floor(savedGame.height / 2);
      savedGame.cityCentreX = Math.floor(savedGame.width / 2);
      savedGame.cityCentreY = Math.floor(savedGame.height / 2);

      break;

    default:
      throw new Error('Unknown save version!');
  }
};


// Cloud storage functions
var saveToCloud = async function(saveId, gameData) {
  gameData.version = this.CURRENT_VERSION;

  const response = await fetch('/api/save', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ saveId, gameData }),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to save to cloud');
  }

  return response.json();
};


var loadFromCloud = async function(saveId) {
  const response = await fetch(`/api/load?saveId=${encodeURIComponent(saveId)}`);

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to load from cloud');
  }

  const result = await response.json();
  var savedGame = result.gameData;

  if (savedGame.version !== this.CURRENT_VERSION)
    this.transitionOldSave(savedGame);

  savedGame.isSavedGame = true;
  return savedGame;
};


var listCloudSaves = async function() {
  const response = await fetch('/api/list');

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to list cloud saves');
  }

  const result = await response.json();
  return result.saves;
};


var Storage = {
  getSavedGame: getSavedGame,
  saveGame: saveGame,
  transitionOldSave: transitionOldSave,
  saveToCloud: saveToCloud,
  loadFromCloud: loadFromCloud,
  listCloudSaves: listCloudSaves
};


Object.defineProperty(Storage, 'CURRENT_VERSION', MiscUtils.makeConstantDescriptor(3));
Object.defineProperty(Storage, 'KEY', MiscUtils.makeConstantDescriptor('micropolisJSGame'));
Object.defineProperty(Storage, 'canStore', MiscUtils.makeConstantDescriptor(window.localStorage !== undefined));


export { Storage };
