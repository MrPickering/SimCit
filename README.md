# SimCit

A classic SimCity clone built with JavaScript/TypeScript and HTML5 Canvas.

Based on [micropolisJS](https://github.com/graememcc/micropolisJS), which is a port of [Micropolis](https://github.com/SimHacker/micropolis) - the open-source release of the original SimCity by Will Wright.

## Features

- **City Building**: Build residential, commercial, and industrial zones
- **Infrastructure**: Construct roads, rails, power lines, and power plants
- **City Services**: Build police stations, fire departments, and stadiums
- **Disasters**: Experience floods, fires, tornadoes, earthquakes, and monster attacks
- **Economy**: Manage city budget with taxes and expenses
- **Simulation**: Watch your city grow and respond to your decisions

## Getting Started

### Prerequisites

- Node.js (v18 or higher)
- npm

### Installation

```bash
# Install dependencies
npm install

# Start development server
npm run dev

# Build for production
npm run build
```

### Development Commands

| Command | Description |
|---------|-------------|
| `npm run dev` | Start development server with hot reload |
| `npm run build` | Build for production |
| `npm run watch` | Watch mode for development |
| `npm run test` | Run tests |
| `npm run lint` | Lint TypeScript files |

## How to Play

1. **Start a New City**: Click "Play micropolisJS" to begin
2. **Choose a Map**: Generate a new map or load a saved city
3. **Build Zones**:
   - **R** (Green) - Residential zones for housing
   - **C** (Blue) - Commercial zones for shops
   - **I** (Yellow) - Industrial zones for factories
4. **Add Infrastructure**:
   - Roads connect zones
   - Power lines bring electricity from power plants
   - Rails provide transportation
5. **Provide Services**:
   - Police stations reduce crime
   - Fire stations prevent fire spread
6. **Manage Budget**: Adjust tax rates and funding levels

## Game Controls

- **Left Click**: Place selected tool
- **Right Click/Drag**: Pan the map
- **Scroll**: Zoom in/out
- **Keyboard Shortcuts**: Various tools have keyboard shortcuts

## Project Structure

```
SimCit/
├── src/           # Game source code (JS/TS)
├── css/           # Stylesheets
├── images/        # Game images
├── sprites/       # Tile sprites
├── test/          # Test files
├── index.html     # Main game page
├── about.html     # About page
└── webpack.config.js
```

## Technology Stack

- **JavaScript/TypeScript**: Game logic and simulation
- **HTML5 Canvas**: Rendering
- **Webpack**: Build system
- **jQuery**: UI interactions
- **Jest**: Testing

## License

This project is licensed under the GPL-3.0 License - see the [LICENSE](LICENSE) file for details.

The code is additionally governed by the [Micropolis Public Name License](MicropolisPublicNameLicense.md).

## Credits

- **Original SimCity**: Will Wright / Maxis / Electronic Arts
- **Micropolis**: Open source release of SimCity
- **micropolisJS**: Graeme McCutcheon - JavaScript port

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.
