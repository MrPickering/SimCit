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

import { CLOUD_LOAD_WINDOW_CLOSED } from './messages.ts';
import { ModalWindow } from './modalWindow.js';
import { Storage } from './storage.js';

var CloudLoadWindow = ModalWindow(function() {
  $(cloudLoadFormID).on('submit', submit.bind(this));
  $(cloudLoadCancelID).on('click', cancel.bind(this));
});


var cloudLoadFormID = '#cloudLoadForm';
var cloudLoadSelectID = '#cloudLoadSelect';
var cloudLoadStatusID = '#cloudLoadStatus';
var cloudLoadOKID = '#cloudLoadOK';
var cloudLoadCancelID = '#cloudLoadCancel';


var submit = async function(e) {
  e.preventDefault();

  var saveId = $(cloudLoadSelectID).val();
  if (!saveId) {
    $(cloudLoadStatusID).text('Please select a save').css('color', 'red');
    return;
  }

  $(cloudLoadStatusID).text('Loading from cloud...').css('color', 'black');
  $(cloudLoadOKID).prop('disabled', true);

  try {
    var gameData = await Storage.loadFromCloud(saveId);
    $(cloudLoadStatusID).text('Loaded successfully!').css('color', 'green');
    setTimeout(function() {
      this.close(gameData);
    }.bind(this), 500);
  } catch (error) {
    $(cloudLoadStatusID).text('Error: ' + error.message).css('color', 'red');
    $(cloudLoadOKID).prop('disabled', false);
  }
};


var cancel = function(e) {
  e.preventDefault();
  this.close(null);
};


CloudLoadWindow.prototype.close = function(gameData) {
  $(cloudLoadStatusID).text('');
  $(cloudLoadOKID).prop('disabled', false);
  this._toggleDisplay();
  this._emitEvent(CLOUD_LOAD_WINDOW_CLOSED, { gameData: gameData });
};


CloudLoadWindow.prototype.open = async function() {
  this._toggleDisplay();
  $(cloudLoadStatusID).text('Loading saves...').css('color', 'black');
  $(cloudLoadSelectID).html('<option value="">Loading...</option>');

  try {
    var saves = await Storage.listCloudSaves();
    $(cloudLoadSelectID).empty();

    if (saves.length === 0) {
      $(cloudLoadSelectID).append('<option value="">No saves found</option>');
      $(cloudLoadStatusID).text('No cloud saves found').css('color', 'gray');
    } else {
      $(cloudLoadSelectID).append('<option value="">Select a save...</option>');
      saves.forEach(function(save) {
        var date = new Date(save.uploadedAt).toLocaleString();
        $(cloudLoadSelectID).append(
          $('<option></option>').val(save.saveId).text(save.saveId + ' (' + date + ')')
        );
      });
      $(cloudLoadStatusID).text('');
    }
  } catch (error) {
    $(cloudLoadSelectID).html('<option value="">Error loading saves</option>');
    $(cloudLoadStatusID).text('Error: ' + error.message).css('color', 'red');
  }

  $(cloudLoadSelectID).focus();
};


export { CloudLoadWindow };
