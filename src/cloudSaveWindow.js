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
var cloudSaveStatusID = '#cloudSaveStatus';
var cloudSaveCodeID = '#cloudSaveCode';
var cloudSaveOKID = '#cloudSaveOK';
var cloudSaveCancelID = '#cloudSaveCancel';


var submit = async function(e) {
  e.preventDefault();

  // If we already have a code displayed, just close
  if (this._savedCode) {
    this.close(true);
    return;
  }

  $(cloudSaveStatusID).text('Saving to cloud...').css('color', 'black');
  $(cloudSaveOKID).prop('disabled', true);
  $(cloudSaveCodeID).text('');

  try {
    var gameData = this._getGameData();
    var accessCode = await Storage.saveToCloud(gameData);
    this._savedCode = accessCode;

    $(cloudSaveStatusID).html('Saved! Your access code is:').css('color', 'green');
    $(cloudSaveCodeID).text(accessCode).css({
      'font-size': '24px',
      'font-weight': 'bold',
      'letter-spacing': '4px',
      'user-select': 'all',
      'padding': '10px',
      'background': '#f0f0f0',
      'border-radius': '4px'
    });
    $(cloudSaveOKID).val('Close').prop('disabled', false);
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
  $(cloudSaveStatusID).text('');
  $(cloudSaveCodeID).text('');
  $(cloudSaveOKID).val('Save to Cloud').prop('disabled', false);
  this._savedCode = null;
  this._toggleDisplay();
  this._emitEvent(CLOUD_SAVE_WINDOW_CLOSED, { success: success });
};


CloudSaveWindow.prototype.open = function(getGameDataFn) {
  this._getGameData = getGameDataFn;
  this._savedCode = null;
  $(cloudSaveStatusID).text('Click "Save to Cloud" to get your access code.');
  this._toggleDisplay();
  $(cloudSaveOKID).focus();
};


export { CloudSaveWindow };
