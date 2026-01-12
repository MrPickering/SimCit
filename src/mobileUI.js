/* SimCit Mobile UI
 * Creates and manages mobile-specific UI elements
 */

import $ from "jquery";
import { EventEmitter } from './eventEmitter.js';
import * as Messages from './messages.ts';

var MobileUI = EventEmitter(function(inputStatus) {
  this.inputStatus = inputStatus;
  this.isOpen = false;

  // Tool definitions for mobile palette
  this.tools = [
    { id: 'residential', name: 'Residential', cost: '$100', size: 3 },
    { id: 'commercial', name: 'Commercial', cost: '$100', size: 3 },
    { id: 'industrial', name: 'Industrial', cost: '$100', size: 3 },
    { id: 'road', name: 'Road', cost: '$10', size: 1 },
    { id: 'rail', name: 'Rail', cost: '$20', size: 1 },
    { id: 'wire', name: 'Wire', cost: '$5', size: 1 },
    { id: 'bulldozer', name: 'Bulldozer', cost: '$1', size: 1 },
    { id: 'park', name: 'Park', cost: '$10', size: 1 },
    { id: 'police', name: 'Police', cost: '$500', size: 3 },
    { id: 'fire', name: 'Fire Dept', cost: '$500', size: 3 },
    { id: 'stadium', name: 'Stadium', cost: '$5000', size: 4 },
    { id: 'port', name: 'Port', cost: '$3000', size: 4 },
    { id: 'airport', name: 'Airport', cost: '$10000', size: 6 },
    { id: 'coal', name: 'Coal', cost: '$3000', size: 4 },
    { id: 'nuclear', name: 'Nuclear', cost: '$5000', size: 4 },
    { id: 'query', name: 'Query', cost: '', size: 1 }
  ];

  this._init();
});

MobileUI.prototype._init = function() {
  // Only initialize on mobile/touch devices
  if (!this._isMobile()) return;

  try {
    this._createMobileInfoBar();
    this._createMobileToolPalette();
    this._createMobileQuickActions();
    this._createZoomControls();
    this._createMobileMenu();
    this._bindEvents();

    // Suppress the touch warning dialog
    $('#touchWarnWindow').remove();

    // Trigger resize after mobile layout is applied so canvas recalculates dimensions
    setTimeout(function() {
      window.dispatchEvent(new Event('resize'));
    }, 100);
  } catch (e) {
    console.error('MobileUI init error:', e);
  }
};

MobileUI.prototype._isMobile = function() {
  return window.matchMedia('(max-width: 768px)').matches ||
         ('ontouchstart' in window) ||
         (navigator.maxTouchPoints > 0);
};

MobileUI.prototype._createMobileInfoBar = function() {
  var html = `
    <div id="mobileInfoBar">
      <div class="info-row">
        <div class="info-item">
          <div class="info-label">FUNDS</div>
          <div class="info-value" id="mobileFunds">$20,000</div>
        </div>
        <div class="info-item">
          <div class="info-label">POP</div>
          <div class="info-value" id="mobilePop">0</div>
        </div>
        <div class="info-item">
          <div class="info-label">DATE</div>
          <div class="info-value" id="mobileDate">Jan 1900</div>
        </div>
        <div class="info-item">
          <div class="info-label">SCORE</div>
          <div class="info-value" id="mobileScore">0</div>
        </div>
      </div>
    </div>
  `;
  $('body').append(html);
};

MobileUI.prototype._createMobileToolPalette = function() {
  var toolsHtml = this.tools.map(function(tool) {
    return `
      <button class="mobile-tool-btn" data-tool="${tool.id}" data-size="${tool.size}">
        <div class="tool-icon"></div>
        <span>${tool.name}</span>
        <small>${tool.cost}</small>
      </button>
    `;
  }).join('');

  var html = `
    <div id="mobileToolPalette">
      <div class="tool-grid">
        ${toolsHtml}
      </div>
    </div>
    <button id="mobileToolbarToggle">+</button>
  `;
  $('body').append(html);
};

MobileUI.prototype._createMobileQuickActions = function() {
  var html = `
    <div id="mobileQuickActions">
      <button class="pause-btn" id="mobilePause" title="Pause">||</button>
      <button class="menu-btn" id="mobileMenuBtn" title="Menu">...</button>
    </div>
  `;
  $('body').append(html);
};

MobileUI.prototype._createZoomControls = function() {
  var html = `
    <div id="zoomControls">
      <button id="zoomIn">+</button>
      <button id="zoomOut">-</button>
      <div id="zoomLevel">100%</div>
    </div>
  `;
  $('body').append(html);
};

MobileUI.prototype._createMobileMenu = function() {
  var html = `
    <div id="mobileMenuOverlay">
      <div id="mobileMenu">
        <h3>Menu</h3>
        <button id="menuBudget" style="background-color: dodgerblue; color: white;">Budget</button>
        <button id="menuEval" style="background-color: forestgreen; color: white;">Evaluation</button>
        <button id="menuDisaster" style="background-color: red; color: yellow;">Disasters</button>
        <button id="menuSettings" style="background-color: #663399; color: white;">Settings</button>
        <button id="menuSave" class="loadSave" style="background-color: cadetblue; color: white;">Save Game</button>
        <button id="menuClose" class="menu-close">Close</button>
      </div>
    </div>
  `;
  $('body').append(html);
};

MobileUI.prototype._bindEvents = function() {
  var self = this;

  // Tool palette toggle
  $('#mobileToolbarToggle').on('click touchend', function(e) {
    e.preventDefault();
    self.toggleToolPalette();
  });

  // Tool selection
  $('#mobileToolPalette').on('click touchend', '.mobile-tool-btn', function(e) {
    e.preventDefault();
    var $btn = $(this);
    var toolName = $btn.data('tool');

    // Update UI
    $('.mobile-tool-btn').removeClass('selected');
    $btn.addClass('selected');

    // Update desktop tool buttons to keep in sync
    $('.toolButton').removeClass('selected').addClass('unselected');
    $('[data-tool="' + toolName + '"]').removeClass('unselected').addClass('selected');

    // Set the tool
    self.inputStatus.toolName = toolName;
    self.inputStatus.toolWidth = $btn.data('size');
    self.inputStatus.currentTool = self.inputStatus.gameTools[toolName];
    self.inputStatus.toolColour = $('[data-tool="' + toolName + '"]').data('colour');

    // Close palette
    self.closeToolPalette();
  });

  // Pause button
  $('#mobilePause').on('click touchend', function(e) {
    e.preventDefault();
    self.inputStatus.speedChangeHandler();
    var isPaused = $('#pauseRequest').text() === 'Play';
    $(this).text(isPaused ? '>' : '||');
  });

  // Menu button
  $('#mobileMenuBtn').on('click touchend', function(e) {
    e.preventDefault();
    self.showMenu();
  });

  // Menu items
  $('#menuBudget').on('click touchend', function(e) {
    e.preventDefault();
    self.hideMenu();
    self.inputStatus._emitEvent(Messages.BUDGET_REQUESTED);
  });

  $('#menuEval').on('click touchend', function(e) {
    e.preventDefault();
    self.hideMenu();
    self.inputStatus._emitEvent(Messages.EVAL_REQUESTED);
  });

  $('#menuDisaster').on('click touchend', function(e) {
    e.preventDefault();
    self.hideMenu();
    self.inputStatus._emitEvent(Messages.DISASTER_REQUESTED);
  });

  $('#menuSettings').on('click touchend', function(e) {
    e.preventDefault();
    self.hideMenu();
    self.inputStatus._emitEvent(Messages.SETTINGS_WINDOW_REQUESTED);
  });

  $('#menuSave').on('click touchend', function(e) {
    e.preventDefault();
    self.hideMenu();
    self.inputStatus._emitEvent(Messages.SAVE_REQUESTED);
  });

  $('#menuClose, #mobileMenuOverlay').on('click touchend', function(e) {
    if (e.target === this) {
      e.preventDefault();
      self.hideMenu();
    }
  });

  // Zoom controls
  $('#zoomIn').on('click touchend', function(e) {
    e.preventDefault();
    if (self.touchInput) {
      self.touchInput.zoomIn();
    }
  });

  $('#zoomOut').on('click touchend', function(e) {
    e.preventDefault();
    if (self.touchInput) {
      self.touchInput.zoomOut();
    }
  });

  // Close palette when clicking outside
  $(document).on('click touchend', function(e) {
    if (self.isOpen &&
        !$(e.target).closest('#mobileToolPalette').length &&
        !$(e.target).closest('#mobileToolbarToggle').length) {
      self.closeToolPalette();
    }
  });
};

MobileUI.prototype.toggleToolPalette = function() {
  if (this.isOpen) {
    this.closeToolPalette();
  } else {
    this.openToolPalette();
  }
};

MobileUI.prototype.openToolPalette = function() {
  this.isOpen = true;
  $('#mobileToolPalette').addClass('open');
  $('#mobileToolbarToggle').addClass('active').text('x');
};

MobileUI.prototype.closeToolPalette = function() {
  this.isOpen = false;
  $('#mobileToolPalette').removeClass('open');
  $('#mobileToolbarToggle').removeClass('active').text('+');
};

MobileUI.prototype.showMenu = function() {
  $('#mobileMenuOverlay').fadeIn(200);
};

MobileUI.prototype.hideMenu = function() {
  $('#mobileMenuOverlay').fadeOut(200);
};

MobileUI.prototype.setTouchInput = function(touchInput) {
  this.touchInput = touchInput;
};

MobileUI.prototype.updateInfo = function(funds, population, date, score) {
  $('#mobileFunds').text('$' + funds.toLocaleString());
  $('#mobilePop').text(population.toLocaleString());
  $('#mobileDate').text(date);
  $('#mobileScore').text(score);
};

// Sync with desktop info bar updates
MobileUI.prototype.syncWithDesktop = function() {
  var self = this;

  // Create a MutationObserver to watch for changes in the desktop info elements
  var fundsEl = document.getElementById('funds');
  var popEl = document.getElementById('population');
  var dateEl = document.getElementById('date');
  var scoreEl = document.getElementById('score');

  if (fundsEl && popEl && dateEl && scoreEl) {
    var observer = new MutationObserver(function() {
      $('#mobileFunds').text('$' + (fundsEl.textContent || '0'));
      $('#mobilePop').text(popEl.textContent || '0');
      $('#mobileDate').text(dateEl.textContent || '');
      $('#mobileScore').text(scoreEl.textContent || '0');
    });

    var config = { childList: true, characterData: true, subtree: true };

    observer.observe(fundsEl, config);
    observer.observe(popEl, config);
    observer.observe(dateEl, config);
    observer.observe(scoreEl, config);
  }
};

export { MobileUI };
