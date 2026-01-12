# Projects for Building a Retro Isometric Sim City Clone

This document lists open-source projects, game engines, libraries, and resources that can be used to build a retro isometric sim city clone.

## Table of Contents
- [Complete Open Source City-Building Games](#complete-open-source-city-building-games)
- [Game Engines and Frameworks](#game-engines-and-frameworks)
- [JavaScript/HTML5 Libraries](#javascripthtml5-libraries)
- [Asset and Rendering Libraries](#asset-and-rendering-libraries)
- [Classic SimCity Ports](#classic-simcity-ports)
- [Recommendations by Use Case](#recommendations-by-use-case)

---

## Complete Open Source City-Building Games

### 1. Cytopia
- **Repository**: https://github.com/CytopiaTeam/Cytopia
- **Website**: https://cytopia.net/
- **Tech Stack**: C++, SDL2, Custom engine
- **License**: GPLv3
- **Features**:
  - Heavily inspired by SimCity 2000
  - Retro pixel-art isometric graphics
  - Highly moddable with focus on community mods
  - Procedural terrain generation
  - Custom UI and camera controls (pan, zoom)
  - Multiple road types and underground pipe layer
  - Built-in tile editor
  - Original soundtrack
  - Active development with builds on Itch.io
- **Best For**: Learning from a complete, actively maintained C++ city builder with strong modding support

### 2. IsoCity (amilich/isometric-city)
- **Repository**: https://github.com/amilich/isometric-city
- **Demo**: https://iso-city.com/
- **Tech Stack**: Next.js, TypeScript, Tailwind CSS, HTML5 Canvas API
- **License**: MIT
- **Features**:
  - Custom-built isometric rendering engine
  - Complex depth sorting and layer management
  - Economic simulation systems
  - Transportation systems (trains, planes, cars, pedestrians)
  - Zoning mechanics
  - Upgradeable buildings
  - Save/load functionality
  - Responsive and mobile-friendly
  - Pixel art aesthetic
- **Best For**: Modern web-based approach with TypeScript and React ecosystem

### 3. IsoCity (victorqribeiro/isocity)
- **Repository**: https://github.com/victorqribeiro/isocity
- **Tech Stack**: JavaScript
- **Features**:
  - Modular block-based city builder
  - Isometric view with pixel art
  - Browser-based
  - Undo/redo functionality
  - Collaborative features
  - Creative tool emphasis
- **Best For**: Simple, creative pixel art city building without complex simulation

### 4. 1255-burgomaster
- **Repository**: https://github.com/zmrdlv/1255-burgomaster
- **Tech Stack**: JavaScript
- **Features**:
  - Little town builder with RPG mechanics
  - Isometric graphics
  - Work-in-progress but playable
- **Best For**: City-building with RPG elements twist

---

## Game Engines and Frameworks

### 1. FIFE (Flexible Isometric Free Engine)
- **Website**: http://www.fifengine.net/
- **Tech Stack**: C++, Python scripting
- **License**: LGPL
- **Features**:
  - General-purpose isometric game engine
  - Supports both isometric and top-down views
  - Integrated GUI system
  - Audio support
  - Lighting and pathfinding
  - Built-in map editor
  - Python and C++ scripting
- **Best For**: Building a complete isometric game from scratch with full engine support

### 2. Pogicity
- **Repository**: https://github.com/twofactor/pogicity-demo
- **Tech Stack**: Phaser 3, Next.js, React, TypeScript, Tailwind CSS
- **Features**:
  - Phaser 3-based isometric city builder engine
  - 2:1 isometric projection with proper depth sorting
  - Tile-based placement system
  - Road networks with auto-connecting intersections
  - Multi-tile buildings with rotation support
  - Animated citizens and vehicles (GIF support)
  - Multiple ground tiles and directional buildings
  - Save/load via localStorage
  - Modern stack (Phaser 3.90, Next.js 16, React 19, TypeScript 5)
- **Best For**: Starting a new web-based city builder with Phaser 3

### 3. Excalibur.js
- **Website**: https://excaliburjs.com/docs/isometric/
- **Tech Stack**: JavaScript/TypeScript
- **Features**:
  - HTML5 game engine with isometric tilemap support
  - Integrates with Tiled map editor
  - IsometricMap class for rendering
  - Custom colliders and depth sorting
  - Asset-based configuration
- **Best For**: Web games with Tiled editor integration

---

## JavaScript/HTML5 Libraries

### 1. Traviso
- **Website**: https://www.travisojs.com/
- **Tech Stack**: JavaScript, built on Pixi.js
- **License**: Open source
- **Features**:
  - Fast isometric rendering for web applications
  - Built on Pixi.js (WebGL acceleration)
  - Terrain height support
  - Fog of war
  - Camera controls
  - Highly customizable
  - Touch support
  - Suitable for both games and web apps
- **Best For**: Fast isometric web applications with Pixi.js

### 2. Isogenic Game Engine
- **Website**: https://isogenicengine.com/
- **Tech Stack**: JavaScript/HTML5
- **Features**:
  - Feature-rich HTML5 engine for isometric games
  - Scene-graph architecture
  - Physics integration with Box2D
  - Networking support for multiplayer
  - Tweening and animation systems
  - Designed for RPGs, city builders, and tile-based worlds
- **Best For**: Multiplayer isometric games with physics

### 3. Sheetengine
- **Website**: https://normanzb.github.io/sheetengine/sheetengine.codeplex.com/index.html
- **Tech Stack**: JavaScript/HTML5 Canvas
- **Features**:
  - Lightweight isometric canvas display engine
  - Texture support
  - Z-ordering
  - Object movement
  - Minimal and customizable
- **Best For**: Custom rendering engines without full game logic overhead

### 4. pixi-isometric-tilemaps
- **Repository**: https://github.com/holywyvern/pixi-isometric-tilemaps
- **Tech Stack**: JavaScript/TypeScript, Pixi.js
- **Features**:
  - Easy isometric tile map setup with Pixi.js
  - Tile elevation support
  - Custom textures
  - Tile properties
  - Object overlays
- **Best For**: Adding isometric tilemaps to existing Pixi.js projects

---

## Asset and Rendering Libraries

### Phaser 3 Isometric Resources
- **Phaser Plugin Isometric**: Adds isometric rendering, projection, tile placement, and physics to Phaser
- **Tutorials**: Official Phaser tutorials for isometric world creation
- **Documentation**: https://phaser.io/docs

### Pixi.js Isometric Resources
- **Community Examples**: CodePen demos for isometric tiles and normals
- **Tutorials**: DEV Community guides for isometric block rendering
- **Forum Discussions**: HTML5GameDevs.com for tips on depth sorting and coordinate mapping

---

## Classic SimCity Ports

### 1. Micropolis
- **Tech Stack**: C++, Python, Java ports available
- **Features**:
  - Original SimCity source code, open sourced
  - Ported to multiple languages (MicropolisJ, MicropolisJS)
  - Classic city-building mechanics
  - Historical reference
- **Best For**: Learning classic SimCity mechanics and algorithms

### 2. OpenSC2K
- **Repository**: https://github.com/nicholas-ochoa/OpenSC2K
- **Tech Stack**: JavaScript, WebGL, Phaser
- **Features**:
  - SimCity 2000 remake
  - Web-based with modern rendering
  - Can be studied or forked for mechanics
- **Best For**: Understanding SimCity 2000 mechanics in a modern web context

### 3. Lincity-NG & Lincity
- **Tech Stack**: C/C++, SDL2
- **Features**:
  - Older open source city-builders
  - Custom isometric engines
  - Useful for reverse engineering simulation/graphics logic
- **Best For**: Reference implementations of city simulation systems

---

## Recommendations by Use Case

### For Learning and Prototyping
- **Start with**: Pogicity (Phaser 3) or IsoCity (Canvas/TypeScript)
- **Why**: Well-documented, modern tech stacks, active examples

### For Web-Based Games (JavaScript/TypeScript)
- **Engines**: Phaser 3 with Pogicity template, or Pixi.js with Traviso
- **Why**: Fast WebGL rendering, large communities, extensive documentation

### For Desktop Games
- **Engines**: FIFE (Python/C++) or fork Cytopia (C++/SDL2)
- **Why**: Mature desktop game engine support, native performance

### For Heavy Customization
- **Start with**: Sheetengine (minimal) or build custom on Canvas/Pixi.js
- **Study**: IsoCity's custom rendering engine for inspiration
- **Why**: Full control over rendering and simulation logic

### For Studying Classic Mechanics
- **Projects**: Micropolis, OpenSC2K, Lincity-NG
- **Why**: Original or faithful implementations of SimCity mechanics

### For Quick Prototypes
- **Tools**: Excalibur.js with Tiled, or Traviso
- **Why**: Fast setup, visual editors, minimal boilerplate

---

## Additional Resources

### Tutorials and Guides
- **Phaser 3 Isometric Tutorial**: https://phaser.io/news/2017/05/creating-isometric-worlds-tutorial-part-1
- **Tizen Isometric Guide**: Creating isometric worlds with Phaser.js plugin
- **WADE Engine Tutorial**: Step-by-step isometric game walkthrough
- **Stack Overflow**: HTML5 Canvas isometric tile rendering examples

### Community Forums
- **FreeGameDev Forums**: https://forum.freegamedev.net/ - Cytopia discussions
- **HTML5GameDevs**: https://www.html5gamedevs.com/ - Pixi.js and Phaser tips
- **LibreGameWiki**: https://libregamewiki.org/ - Open source game documentation

### Asset Resources
- **OpenGameArt**: Free isometric tiles and sprites
- **Kenney.nl**: Free isometric asset packs
- **Itch.io**: Indie asset bundles with isometric themes

---

## Tech Stack Summary

| Project/Engine | Language | Rendering | Simulation | Multiplayer | Active |
|---------------|----------|-----------|------------|-------------|--------|
| Cytopia | C++ | SDL2 | Full | No | Yes |
| IsoCity (amilich) | TypeScript | Canvas | Full | No | Yes |
| Pogicity | TypeScript | Phaser 3 | Partial | No | Yes |
| FIFE | Python/C++ | Custom | Framework | Yes | Yes |
| Traviso | JavaScript | Pixi.js | Framework | Planned | Yes |
| Isogenic | JavaScript | Canvas/WebGL | Full | Yes | Yes |
| Micropolis | C++/Java/Python | Various | Classic | No | Ports |
| OpenSC2K | JavaScript | Phaser | Full | No | Archived |

---

## Getting Started

### Recommended Path for Beginners
1. **Explore**: Try the IsoCity demo (https://iso-city.com/) to see what's possible
2. **Learn**: Study Pogicity's codebase for modern Phaser 3 + React patterns
3. **Experiment**: Fork and modify Pogicity or IsoCity for your needs
4. **Expand**: Add custom simulation logic, new building types, and features

### Recommended Path for Advanced Developers
1. **Study**: Review Cytopia for a full C++ implementation
2. **Choose**: Select FIFE for desktop or Pixi.js/Phaser 3 for web
3. **Customize**: Build custom rendering engine or extend existing ones
4. **Integrate**: Add advanced features like multiplayer (Isogenic) or modding (Cytopia patterns)

---

## Conclusion

For building a **retro isometric sim city clone**, the best starting points are:

1. **For Web (Modern)**: Fork IsoCity or Pogicity - they provide complete, working examples with modern tech stacks
2. **For Desktop**: Fork Cytopia or build with FIFE - mature C++ implementations with strong foundations
3. **For Learning**: Study Micropolis for classic mechanics, then implement in your chosen engine
4. **For Quick Start**: Use Traviso or Phaser 3 with isometric plugin for rapid prototyping

All these projects are open source and actively maintained or well-documented, making them excellent foundations for your own retro isometric sim city clone.
