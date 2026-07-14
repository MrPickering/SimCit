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

// PB runtime — the shared loud-failure channel + drive surface. Side-effect import:
// it sets window.PB / window.__pbAssetErrors. MUST come first, so the tileset and
// sprite loaders below can report through it. (asset-factory/standard/RUNTIME.md)
import './pb-runtime.js';

import $ from "jquery";

import { Config } from './config.js';
import { SplashScreen } from './splashScreen.js';
import { TileSet } from './tileSet.js';
import { TileSetURI } from './tileSetURI.ts';
import { TileSetSnowURI } from './tileSetSnowURI.ts';

/*
 *
 * Our task in main is to load the tile image, create a TileSet from it, and then tell the SplashScreen to display
 * itself. We will never return here.
 *
 */


var fallbackImage, tileSet, snowTileSet;


var onTilesLoaded = function() {
  var snowTiles = $('#snowtiles')[1];
  snowTileSet = new TileSet(snowTiles, onAllTilesLoaded, onFallbackTilesLoaded);
};


var onAllTilesLoaded = function() {
  // Kick things off properly
  var sprites = $('#sprites')[0];
  // RULE 0 (asset-factory/standard/RUNTIME.md). `complete` is TRUE for a 404 as well as
  // a success — the browser is done either way. So a missing sheet neither stalls this
  // poll nor throws: every drawImage below silently draws nothing, and the city runs
  // with no trains, no planes and no monster. Invisible, not broken. naturalWidth is the
  // only thing that tells them apart.
  if (sprites.complete && !sprites.naturalWidth && typeof PB !== 'undefined') {
    PB.missing('sheet', 'images/sprites.png', 'loaded 0x0 — every moving sprite will draw nothing');
  }
  if (sprites.complete) {
    $('#loadingBanner').css('display', 'none');
    var s = new SplashScreen(tileSet, snowTileSet, sprites);

    // PB drive surface (asset-factory/standard/RUNTIME.md).
    //
    // SimCit boots into a SPLASH SCREEN that generates a map and waits for the player to
    // accept it — the simulation is not running and nothing is drawn until then. So
    // `boot` has to get past the splash, or the harness would drive a menu and R5 would
    // assert silence over a screen with no city on it.
    if (typeof PB !== 'undefined') {
      PB.drive({
        boot: function() {
          // SimCit boots into a SPLASH: it generates a map and waits for the player to
          // submit the name/difficulty form. Nothing simulates and nothing is drawn until
          // then. So drive the REAL path — submit the form — rather than reaching past it.
          // Otherwise the harness would drive a menu and R5 would assert silence over a
          // screen with no city on it.
          $('#playForm').trigger('submit');
        },
        step: function(n) {
          var g = window.__simcitGame;
          for (var i = 0; i < (n || 1); i++) { if (g && g.tick) g.tick(); }
        },
        draw: function() {
          var g = window.__simcitGame;
          if (g && g.animate) g.animate();
        },
      });
    }
  } else {
     window.setTimeout(onAllTilesLoaded, 0);
  }
};


// XXX Replace with an error dialog
var onFallbackError = function() {
  fallbackImage.onload = fallbackImage.onerror = null;
  alert('Failed to load tileset!');
};


var onFallbackSnowLoad = function() {
  fallbackImage.onload = fallbackImage.onerror = null;
  snowTileSet = new TileSet(fallbackImage, onAllTilesLoaded, onFallbackError);
};


var onFallbackTilesLoaded = function() {
  fallbackImage = new Image();
  fallbackImage.onload = onFallbackSnowLoad;
  fallbackImage.onerror = onFallbackError;
  fallbackImage.src = TileSetSnowURI;
};


var onFallbackLoad = function() {
  fallbackImage.onload = fallbackImage.onerror = null;
  tileSet = new TileSet(fallbackImage, onFallbackTilesLoaded, onFallbackError);
};


var tileSetError = function() {
  // We might be running locally in Chrome, which handles the security context of file URIs differently, which makes
  // things go awry when we try to create an image from a "tainted" canvas (one we've painted on). Let's try creating
  // the tileset by URI instead
  fallbackImage = new Image();
  fallbackImage.onload = onFallbackLoad;
  fallbackImage.onerror = onFallbackError;
  fallbackImage.src = TileSetURI;
};


// Check for debug parameter in URL
Config.debug = window.location.search.slice(1).split('&').some(function(param) {
  return param.trim().toLowerCase() === 'debug=1';
});


var tiles = $('#tiles')[0];
tileSet = new TileSet(tiles, onTilesLoaded, tileSetError);
var snowtiles = $('#snowtiles')[1];
