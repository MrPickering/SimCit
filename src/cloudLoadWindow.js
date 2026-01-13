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
var cloudLoadCodeID = '#cloudLoadCode';
var cloudLoadStatusID = '#cloudLoadStatus';
var cloudLoadOKID = '#cloudLoadOK';
var cloudLoadCancelID = '#cloudLoadCancel';


var submit = async function(e) {
  e.preventDefault();

  var accessCode = $(cloudLoadCodeID).val().trim().toUpperCase();
  if (!accessCode) {
    $(cloudLoadStatusID).text('Please enter an access code').css('color', 'red');
    return;
  }

  if (accessCode.length !== 6) {
    $(cloudLoadStatusID).text('Access code must be 6 characters').css('color', 'red');
    return;
  }

  $(cloudLoadStatusID).text('Loading from cloud...').css('color', 'black');
  $(cloudLoadOKID).prop('disabled', true);

  try {
    var gameData = await Storage.loadFromCloud(accessCode);
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
  $(cloudLoadCodeID).val('');
  $(cloudLoadStatusID).text('');
  $(cloudLoadOKID).prop('disabled', false);
  this._toggleDisplay();
  this._emitEvent(CLOUD_LOAD_WINDOW_CLOSED, { gameData: gameData });
};


CloudLoadWindow.prototype.open = function() {
  this._toggleDisplay();
  $(cloudLoadStatusID).text('');
  $(cloudLoadCodeID).val('').focus();
};


export { CloudLoadWindow };
