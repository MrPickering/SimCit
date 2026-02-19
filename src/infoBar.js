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

import * as Messages from './messages.ts';
import { MiscUtils } from './miscUtils.js';
import { Text } from './text.js';

var formatNumber = function(n) {
  return Number(n).toLocaleString();
};

var updateDemand = function(id, value) {
  var el = $(id);
  if (value > 100) {
    el.removeClass('demand-low').addClass('demand-high');
  } else if (value < -100) {
    el.removeClass('demand-high').addClass('demand-low');
  } else {
    el.removeClass('demand-high demand-low');
  }
};

var InfoBar = function(classification, population, score, funds, date, name) {
  var classificationSelector = MiscUtils.normaliseDOMid(classification);
  var populationSelector = MiscUtils.normaliseDOMid(population);
  var scoreSelector = MiscUtils.normaliseDOMid(score);
  var fundsSelector = MiscUtils.normaliseDOMid(funds);
  var dateSelector = MiscUtils.normaliseDOMid(date);
  var nameSelector = MiscUtils.normaliseDOMid(name);

  return function(dataSource, initialValues) {
    $(classificationSelector).text(initialValues.classification);
    $(populationSelector).text(formatNumber(initialValues.population));
    $(scoreSelector).text(formatNumber(initialValues.score));
    $(fundsSelector).text(formatNumber(initialValues.funds));
    $(dateSelector).text([Text.months[initialValues.date.month], initialValues.date.year].join(' '));
    $(nameSelector).text(initialValues.name);

    dataSource.addEventListener(Messages.CLASSIFICATION_UPDATED, function(classification) {
      $(classificationSelector).text(classification);
    });

    dataSource.addEventListener(Messages.POPULATION_UPDATED, function(population) {
      $(populationSelector).text(formatNumber(population));
    });

    dataSource.addEventListener(Messages.SCORE_UPDATED, function(score) {
      $(scoreSelector).text(formatNumber(score));
    });

    dataSource.addEventListener(Messages.FUNDS_CHANGED, function(funds) {
      $(fundsSelector).text(formatNumber(funds));
    });

    dataSource.addEventListener(Messages.DATE_UPDATED, function(date) {
      $(dateSelector).text([Text.months[date.month], date.year].join(' '));
    });

    dataSource.addEventListener(Messages.VALVES_UPDATED, function(data) {
      updateDemand('#demandR', data.residential);
      updateDemand('#demandC', data.commercial);
      updateDemand('#demandI', data.industrial);
    });
  };
};


export { InfoBar };
