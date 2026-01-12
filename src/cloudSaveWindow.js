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

import $ from "jquery";

import { CLOUD_SAVE_WINDOW_CLOSED } from './messages.ts';
import { ModalWindow } from './modalWindow.js';
import { Storage } from './storage.js';

var CloudSaveWindow = ModalWindow(function() {
  $(cloudSaveFormID).on('submit', submit.bind(this));
  $(cloudSaveCancelID).on('click', cancel.bind(this));
});


var cloudSaveFormID = '#cloudSaveForm';
var cloudSaveInputID = '#cloudSaveId';
var cloudSaveStatusID = '#cloudSaveStatus';
var cloudSaveOKID = '#cloudSaveOK';
var cloudSaveCancelID = '#cloudSaveCancel';


var submit = async function(e) {
  e.preventDefault();

  var saveId = $(cloudSaveInputID).val().trim();
  if (!saveId) {
    $(cloudSaveStatusID).text('Please enter a save name').css('color', 'red');
    return;
  }

  $(cloudSaveStatusID).text('Saving to cloud...').css('color', 'black');
  $(cloudSaveOKID).prop('disabled', true);

  try {
    var gameData = this._getGameData();
    await Storage.saveToCloud(saveId, gameData);
    $(cloudSaveStatusID).text('Saved successfully!').css('color', 'green');
    setTimeout(function() {
      this.close(true);
    }.bind(this), 1000);
  } catch (error) {
    $(cloudSaveStatusID).text('Error: ' + error.message).css('color', 'red');
    $(cloudSaveOKID).prop('disabled', false);
  }
};


var cancel = function(e) {
  e.preventDefault();
  this.close(false);
};


CloudSaveWindow.prototype.close = function(success) {
  $(cloudSaveInputID).val('');
  $(cloudSaveStatusID).text('');
  $(cloudSaveOKID).prop('disabled', false);
  this._toggleDisplay();
  this._emitEvent(CLOUD_SAVE_WINDOW_CLOSED, { success: success });
};


CloudSaveWindow.prototype.open = function(getGameDataFn) {
  this._getGameData = getGameDataFn;
  this._toggleDisplay();
  $(cloudSaveInputID).focus();
};


export { CloudSaveWindow };
