/* SimCit Touch Input Handler
 * Adds touch support for mobile devices: tap to place, pan to scroll, pinch to zoom
 */

import $ from "jquery";
import { GameCanvas } from './gameCanvas.js';
import * as Messages from './messages.ts';

var TouchInput = function(inputStatus, gameCanvas) {
  this.inputStatus = inputStatus;
  this.gameCanvas = gameCanvas;
  this.canvasID = '#' + GameCanvas.DEFAULT_ID;

  // Only initialize touch controls on touch devices
  this._isTouchDevice = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
  if (!this._isTouchDevice) {
    return; // Don't initialize on desktop
  }

  // Touch state
  this._touching = false;
  this._lastTouchX = 0;
  this._lastTouchY = 0;
  this._touchStartX = 0;
  this._touchStartY = 0;
  this._touchStartTime = 0;

  // Pinch zoom state
  this._pinching = false;
  this._lastPinchDist = 0;

  // Pan state
  this._panning = false;
  this._accumulatedPanX = 0;
  this._accumulatedPanY = 0;

  // Current zoom level (CSS scale)
  this._zoom = 1;
  this._minZoom = 0.5;
  this._maxZoom = 2.5;

  // Tap detection threshold
  this._tapThreshold = 15; // pixels
  this._tapTimeout = 300; // ms

  // How many pixels of drag equals one tile scroll
  this._panSensitivity = 16; // tile width

  // Bind touch event handlers
  this._onTouchStart = this._handleTouchStart.bind(this);
  this._onTouchMove = this._handleTouchMove.bind(this);
  this._onTouchEnd = this._handleTouchEnd.bind(this);

  // Initialize after a delay to ensure canvas is ready
  var self = this;
  setTimeout(function() {
    self._init();
  }, 500);
};

TouchInput.prototype._init = function() {
  try {
    var canvas = document.querySelector(this.canvasID);
    if (!canvas) {
      // Try again after a short delay (canvas may not be ready yet)
      setTimeout(this._init.bind(this), 100);
      return;
    }

    // Add touch event listeners
    canvas.addEventListener('touchstart', this._onTouchStart, { passive: false });
    canvas.addEventListener('touchmove', this._onTouchMove, { passive: false });
    canvas.addEventListener('touchend', this._onTouchEnd, { passive: false });
    canvas.addEventListener('touchcancel', this._onTouchEnd, { passive: false });

    // Prevent default touch behaviors on canvas
    canvas.style.touchAction = 'none';

    // Store reference to canvas element
    this._canvasEl = canvas;

    // Don't apply initial zoom transform - it breaks canvas rendering
    // Zoom will be applied only when user actually zooms
  } catch (e) {
    console.error('TouchInput init error:', e);
  }
};

TouchInput.prototype._handleTouchStart = function(e) {
  e.preventDefault();

  var touches = e.touches;

  if (touches.length === 1) {
    // Single touch - could be tap or pan start
    var touch = touches[0];

    this._touching = true;
    this._touchStartX = touch.clientX;
    this._touchStartY = touch.clientY;
    this._lastTouchX = touch.clientX;
    this._lastTouchY = touch.clientY;
    this._touchStartTime = Date.now();
    this._panning = false;
    this._accumulatedPanX = 0;
    this._accumulatedPanY = 0;

    // Show touch feedback
    this._showTouchFeedback(touch.clientX, touch.clientY);

  } else if (touches.length === 2) {
    // Two finger touch - pinch zoom
    this._pinching = true;
    this._touching = false;
    this._panning = false;
    this._lastPinchDist = this._getPinchDistance(touches);
  }
};

TouchInput.prototype._handleTouchMove = function(e) {
  e.preventDefault();

  var touches = e.touches;

  if (this._pinching && touches.length === 2) {
    // Pinch zoom disabled - CSS zoom breaks canvas rendering
    // Just ignore pinch gestures
    return;

  } else if (this._touching && touches.length === 1) {
    var touch = touches[0];

    var dx = touch.clientX - this._touchStartX;
    var dy = touch.clientY - this._touchStartY;
    var distance = Math.sqrt(dx * dx + dy * dy);

    // Check if we've moved enough to start panning
    if (!this._panning && distance > this._tapThreshold) {
      this._panning = true;
    }

    if (this._panning) {
      // Calculate pan delta
      var panDx = touch.clientX - this._lastTouchX;
      var panDy = touch.clientY - this._lastTouchY;

      // Accumulate pan movement (adjusted for zoom)
      this._accumulatedPanX += panDx / this._zoom;
      this._accumulatedPanY += panDy / this._zoom;

      // Move by tiles when accumulated enough
      var tilesMoved = false;

      while (this._accumulatedPanX > this._panSensitivity) {
        this.gameCanvas.moveWest();
        this._accumulatedPanX -= this._panSensitivity;
        tilesMoved = true;
      }
      while (this._accumulatedPanX < -this._panSensitivity) {
        this.gameCanvas.moveEast();
        this._accumulatedPanX += this._panSensitivity;
        tilesMoved = true;
      }
      while (this._accumulatedPanY > this._panSensitivity) {
        this.gameCanvas.moveNorth();
        this._accumulatedPanY -= this._panSensitivity;
        tilesMoved = true;
      }
      while (this._accumulatedPanY < -this._panSensitivity) {
        this.gameCanvas.moveSouth();
        this._accumulatedPanY += this._panSensitivity;
        tilesMoved = true;
      }

      this._lastTouchX = touch.clientX;
      this._lastTouchY = touch.clientY;

    } else if (this.inputStatus.currentTool && this.inputStatus.currentTool.isDraggable) {
      // Draggable tool (like road) - emit tool clicks while dragging
      var coords = this._getCanvasCoords(touch);
      var tileWidth = this.inputStatus._tileWidth;
      var x = Math.floor(coords.x / tileWidth);
      var y = Math.floor(coords.y / tileWidth);

      var startCoords = this._getCanvasCoordsFromClient(this._lastTouchX, this._lastTouchY);
      var lastX = Math.floor(startCoords.x / tileWidth);
      var lastY = Math.floor(startCoords.y / tileWidth);

      if (x !== lastX || y !== lastY) {
        this.inputStatus.mouseX = coords.x;
        this.inputStatus.mouseY = coords.y;
        this.inputStatus._emitEvent(Messages.TOOL_CLICKED, { x: coords.x, y: coords.y });
        this._lastTouchX = touch.clientX;
        this._lastTouchY = touch.clientY;
      }
    }
  }
};

TouchInput.prototype._handleTouchEnd = function(e) {
  e.preventDefault();

  if (this._pinching) {
    this._pinching = false;
    return;
  }

  if (this._touching) {
    var elapsed = Date.now() - this._touchStartTime;
    var dx = this._lastTouchX - this._touchStartX;
    var dy = this._lastTouchY - this._touchStartY;
    var distance = Math.sqrt(dx * dx + dy * dy);

    // Detect tap (short press, small movement)
    if (!this._panning && distance < this._tapThreshold && elapsed < this._tapTimeout) {
      // This is a tap - place tool
      if (this.inputStatus.currentTool) {
        var coords = this._getCanvasCoordsFromClient(this._touchStartX, this._touchStartY);
        this.inputStatus.mouseX = coords.x;
        this.inputStatus.mouseY = coords.y;
        this.inputStatus._emitEvent(Messages.TOOL_CLICKED, {
          x: coords.x,
          y: coords.y
        });
      }
    }
  }

  this._touching = false;
  this._panning = false;
};

TouchInput.prototype._getCanvasCoords = function(touch) {
  return this._getCanvasCoordsFromClient(touch.clientX, touch.clientY);
};

TouchInput.prototype._getCanvasCoordsFromClient = function(clientX, clientY) {
  var canvas = this._canvasEl || document.querySelector(this.canvasID);
  if (!canvas) return { x: 0, y: 0 };

  var rect = canvas.getBoundingClientRect();

  // Account for zoom when converting coordinates
  var scaleX = canvas.width / rect.width;
  var scaleY = canvas.height / rect.height;

  return {
    x: (clientX - rect.left) * scaleX,
    y: (clientY - rect.top) * scaleY
  };
};

TouchInput.prototype._getPinchDistance = function(touches) {
  var dx = touches[0].clientX - touches[1].clientX;
  var dy = touches[0].clientY - touches[1].clientY;
  return Math.sqrt(dx * dx + dy * dy);
};

TouchInput.prototype._applyZoom = function() {
  var canvas = this._canvasEl || document.querySelector(this.canvasID);
  if (!canvas) return;

  // Apply CSS scale transform for zoom
  canvas.style.transformOrigin = 'center center';
  canvas.style.transform = 'scale(' + this._zoom + ')';

  // Update zoom display if exists
  var zoomDisplay = document.getElementById('zoomLevel');
  if (zoomDisplay) {
    zoomDisplay.textContent = Math.round(this._zoom * 100) + '%';
  }
};

TouchInput.prototype._showTouchFeedback = function(x, y) {
  var feedback = document.createElement('div');
  feedback.className = 'touch-feedback';
  feedback.style.left = x + 'px';
  feedback.style.top = y + 'px';
  document.body.appendChild(feedback);

  setTimeout(function() {
    if (feedback.parentNode) {
      feedback.parentNode.removeChild(feedback);
    }
  }, 400);
};

TouchInput.prototype.zoomIn = function() {
  // CSS zoom breaks canvas rendering - disabled
  // Instead, move the view to show less area (zoom effect via panning)
};

TouchInput.prototype.zoomOut = function() {
  // CSS zoom breaks canvas rendering - disabled
};

TouchInput.prototype.resetZoom = function() {
  // CSS zoom breaks canvas rendering - disabled
};

TouchInput.prototype.getZoom = function() {
  return this._zoom;
};

export { TouchInput };
