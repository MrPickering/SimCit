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
  this._initialZoom = 1;

  // Pan state
  this._panning = false;
  this._panStartX = 0;
  this._panStartY = 0;

  // Current zoom level
  this._zoom = 1;
  this._minZoom = 0.5;
  this._maxZoom = 2;

  // Tap detection threshold
  this._tapThreshold = 10; // pixels
  this._tapTimeout = 300; // ms

  // Bind touch event handlers
  this._onTouchStart = this._handleTouchStart.bind(this);
  this._onTouchMove = this._handleTouchMove.bind(this);
  this._onTouchEnd = this._handleTouchEnd.bind(this);

  // Initialize
  this._init();
};

TouchInput.prototype._init = function() {
  var canvas = document.querySelector(this.canvasID);
  if (!canvas) return;

  // Add touch event listeners
  canvas.addEventListener('touchstart', this._onTouchStart, { passive: false });
  canvas.addEventListener('touchmove', this._onTouchMove, { passive: false });
  canvas.addEventListener('touchend', this._onTouchEnd, { passive: false });
  canvas.addEventListener('touchcancel', this._onTouchEnd, { passive: false });

  // Prevent default touch behaviors on canvas
  canvas.style.touchAction = 'none';
};

TouchInput.prototype._handleTouchStart = function(e) {
  e.preventDefault();

  var touches = e.touches;

  if (touches.length === 1) {
    // Single touch - could be tap or pan start
    var touch = touches[0];
    var coords = this._getCanvasCoords(touch);

    this._touching = true;
    this._touchStartX = coords.x;
    this._touchStartY = coords.y;
    this._lastTouchX = coords.x;
    this._lastTouchY = coords.y;
    this._touchStartTime = Date.now();
    this._panning = false;

    // Show touch feedback
    this._showTouchFeedback(touch.clientX, touch.clientY);

  } else if (touches.length === 2) {
    // Two finger touch - pinch zoom
    this._pinching = true;
    this._touching = false;
    this._panning = false;
    this._lastPinchDist = this._getPinchDistance(touches);
    this._initialZoom = this._zoom;
  }
};

TouchInput.prototype._handleTouchMove = function(e) {
  e.preventDefault();

  var touches = e.touches;

  if (this._pinching && touches.length === 2) {
    // Handle pinch zoom
    var dist = this._getPinchDistance(touches);
    var scale = dist / this._lastPinchDist;

    var newZoom = this._zoom * scale;
    newZoom = Math.max(this._minZoom, Math.min(this._maxZoom, newZoom));

    if (newZoom !== this._zoom) {
      this._zoom = newZoom;
      this._applyZoom();
    }

    this._lastPinchDist = dist;

  } else if (this._touching && touches.length === 1) {
    var touch = touches[0];
    var coords = this._getCanvasCoords(touch);

    var dx = coords.x - this._touchStartX;
    var dy = coords.y - this._touchStartY;
    var distance = Math.sqrt(dx * dx + dy * dy);

    // Check if we've moved enough to start panning
    if (!this._panning && distance > this._tapThreshold) {
      this._panning = true;
    }

    if (this._panning) {
      // Pan the canvas
      var panDx = coords.x - this._lastTouchX;
      var panDy = coords.y - this._lastTouchY;

      if (this.gameCanvas && this.gameCanvas.pan) {
        this.gameCanvas.pan(-panDx, -panDy);
      }
    } else if (this.inputStatus.currentTool && this.inputStatus.currentTool.isDraggable) {
      // Draggable tool (like road) - emit tool clicks while dragging
      var tileWidth = this.inputStatus._tileWidth;
      var x = Math.floor(coords.x / tileWidth);
      var y = Math.floor(coords.y / tileWidth);

      var lastX = Math.floor(this._lastTouchX / tileWidth);
      var lastY = Math.floor(this._lastTouchY / tileWidth);

      if (x !== lastX || y !== lastY) {
        this.inputStatus.mouseX = coords.x;
        this.inputStatus.mouseY = coords.y;
        this.inputStatus._emitEvent(Messages.TOOL_CLICKED, { x: coords.x, y: coords.y });
      }
    }

    this._lastTouchX = coords.x;
    this._lastTouchY = coords.y;
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

    // Detect tap
    if (!this._panning && distance < this._tapThreshold && elapsed < this._tapTimeout) {
      // This is a tap - place tool
      if (this.inputStatus.currentTool) {
        this.inputStatus.mouseX = this._touchStartX;
        this.inputStatus.mouseY = this._touchStartY;
        this.inputStatus._emitEvent(Messages.TOOL_CLICKED, {
          x: this._touchStartX,
          y: this._touchStartY
        });
      }
    }
  }

  this._touching = false;
  this._panning = false;
};

TouchInput.prototype._getCanvasCoords = function(touch) {
  var canvas = document.querySelector(this.canvasID);
  var rect = canvas.getBoundingClientRect();
  return {
    x: (touch.clientX - rect.left) / this._zoom,
    y: (touch.clientY - rect.top) / this._zoom
  };
};

TouchInput.prototype._getPinchDistance = function(touches) {
  var dx = touches[0].clientX - touches[1].clientX;
  var dy = touches[0].clientY - touches[1].clientY;
  return Math.sqrt(dx * dx + dy * dy);
};

TouchInput.prototype._applyZoom = function() {
  var canvas = document.querySelector(this.canvasID);
  if (canvas) {
    canvas.style.transform = 'scale(' + this._zoom + ')';
    canvas.style.transformOrigin = 'top left';
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
  this._zoom = Math.min(this._maxZoom, this._zoom * 1.2);
  this._applyZoom();
};

TouchInput.prototype.zoomOut = function() {
  this._zoom = Math.max(this._minZoom, this._zoom / 1.2);
  this._applyZoom();
};

TouchInput.prototype.resetZoom = function() {
  this._zoom = 1;
  this._applyZoom();
};

export { TouchInput };
