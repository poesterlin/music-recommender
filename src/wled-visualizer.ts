import { env } from "bun";
import { getCurrentTrack } from "./webhook";
import { db } from "./db";
import { eq } from "drizzle-orm";
import { trackTable } from "./schema";

class EmbeddingVisualizer {
  private wledIp: string;
  private wledPort: number;
  private animationInterval: Timer | null = null;
  private currentEmbedding: Float32Array | null = null;

  constructor(wledIp: string, port: number = 21324) {
    this.wledIp = wledIp;
    this.wledPort = port;
  }

  // 512 → 64 dimension reduction using chunking
  private embeddingToGrid(embedding: Float32Array): Float32Array {
    const chunks = new Float32Array(64);
    for (let i = 0; i < 64; i++) {
      let sum = 0;
      for (let j = 0; j < 8; j++) {
        sum += embedding[i * 8 + j];
      }
      chunks[i] = sum / 8; // Mean of each chunk
    }
    return chunks;
  }

  // HSV to RGB conversion (fixed for better colors)
  private hsvToRgb(h: number, s: number, v: number): [number, number, number] {
    let r, g, b;

    const i = Math.floor(h * 6);
    const f = h * 6 - i;
    const p = v * (1 - s);
    const q = v * (1 - f * s);
    const t = v * (1 - (1 - f) * s);

    switch (i % 6) {
      case 0: r = v; g = t; b = p; break;
      case 1: r = q; g = v; b = p; break;
      case 2: r = p; g = v; b = t; break;
      case 3: r = p; g = q; b = v; break;
      case 4: r = t; g = p; b = v; break;
      case 5: r = v; g = p; b = q; break;
      default: r = g = b = 0;
    }

    return [
      Math.round(r * 255),
      Math.round(g * 255),
      Math.round(b * 255)
    ];
  }

  // Convert grid values to RGB colors with HSV mapping
  private gridToColors(grid: Float32Array, hueOffset: number = 0, waveEffect: Float32Array | null = null): Uint8Array {
    // Normalize grid values to 0-1 range
    const min = Math.min(...grid);
    const max = Math.max(...grid);
    const range = max - min || 0.001;

    const colors = new Uint8Array(64 * 3); // 64 LEDs * 3 RGB values

    for (let i = 0; i < 64; i++) {
      let value = (grid[i] - min) / range;
      
      // Apply wave effect if provided
      if (waveEffect) {
        value = Math.max(0, Math.min(1, value + waveEffect[i]));
      }

      // More vibrant color mapping
      // Use different hue ranges for visual variety
      const gridX = i % 8;
      const gridY = Math.floor(i / 8);
      const positionHue = ((gridX + gridY) / 14) * 0.3; // Position-based hue variation
      
      const hue = (value * 0.7 + positionHue + hueOffset) % 1.0;
      const saturation = 0.9 + 0.1 * value; // Very high saturation
      const brightness = 0.4 + 0.6 * value; // Better brightness range

      const [r, g, b] = this.hsvToRgb(hue, saturation, brightness);
      
      colors[i * 3] = r;
      colors[i * 3 + 1] = g;
      colors[i * 3 + 2] = b;
    }

    return colors;
  }

  // Send colors to WLED via UDP (DRGB protocol)
  private async sendToWledUDP(colors: Uint8Array): Promise<void> {
    try {
      // DRGB protocol: timeout byte + RGB data
      const data = new Uint8Array(1 + colors.length);
      data[0] = 2; // Timeout indicator
      data.set(colors, 1);

      // Create datagram packet
      const packet = new Uint8Array(data.length);
      packet.set(data);

      // Use Node's dgram module via Bun.spawn
      const process = Bun.spawn(['node', '-e', `
        const dgram = require('dgram');
        const socket = dgram.createSocket('udp4');
        const data = Buffer.from(${JSON.stringify(Array.from(packet))});
        socket.send(data, ${this.wledPort}, '${this.wledIp}', (err) => {
          if (err) console.error('UDP send error:', err);
          socket.close();
        });
      `]);
      await process.exited;
    } catch (error) {
      console.error("Failed to send UDP data to WLED:", error);
      // Fallback to JSON API
      await this.sendToWledJSON(colors);
    }
  }

  // Send colors to WLED via JSON API (fallback)
  private async sendToWledJSON(colors: Uint8Array): Promise<void> {
    try {
      const colorArray = [];
      for (let i = 0; i < colors.length; i += 3) {
        colorArray.push([colors[i], colors[i + 1], colors[i + 2]]);
      }

      const payload = {
        seg: {
          i: colorArray
        },
        on: true,           // Ensure LEDs are on
        bri: 255,           // Full brightness
        transition: 0,      // No transition for responsive updates
        mainseg: 0,         // Use main segment
        // Disable other effects that might interfere
        ps: 0,              // No preset
        fx: 0,              // No effect
        sx: 0,              // Effect speed = 0
        ix: 0,              // Effect intensity = 0
        // Enable realtime mode to prevent interference
        live: true,
        lor: 1              // Live override = 1 (realtime)
      };

      await fetch(`http://${this.wledIp}/json/state`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload)
      });
    } catch (error) {
      console.error("Failed to send JSON data to WLED:", error);
    }
  }

  // Generate wave effect for animation (slower)
  private generateWaveEffect(time: number): Float32Array {
    const wave = new Float32Array(64);
    for (let i = 0; i < 8; i++) {
      for (let j = 0; j < 8; j++) {
        const index = i * 8 + j;
        wave[index] = Math.sin((i + j) * 0.3 + time * 0.5) * 0.05; // Slower, gentler wave
      }
    }
    return wave;
  }

  // Start animation for a given embedding
  public async playEmbedding(embedding: Float32Array, duration: number = 30): Promise<void> {
    this.currentEmbedding = embedding;
    const grid = this.embeddingToGrid(embedding);
    const startTime = Date.now();
    const fps = 15; // Slower frame rate

    if (this.animationInterval) {
      clearInterval(this.animationInterval);
    }

    this.animationInterval = setInterval(async () => {
      const elapsed = (Date.now() - startTime) / 1000;
      
      if (elapsed >= duration) {
        this.stopAnimation();
        return;
      }

      // Animate hue offset (slower rotating colors)
      const hueOffset = (elapsed * 0.02) % 1.0;
      
      // Generate wave effect
      const wave = this.generateWaveEffect(elapsed);
      
      // Convert to colors and send (try JSON first for reliability)
      const colors = this.gridToColors(grid, hueOffset, wave);
      await this.sendToWledJSON(colors);
      
    }, 1000 / fps);
  }

  // Stop current animation
  public stopAnimation(): void {
    if (this.animationInterval) {
      clearInterval(this.animationInterval);
      this.animationInterval = null;
    }
  }

  // Get current track embedding and visualize it
  public async visualizeCurrentTrack(): Promise<void> {
    try {
      const currentTrack = await getCurrentTrack();
      if (!currentTrack || !currentTrack.uri) {
        console.error("No current track found");
        return;
      }

      const [track] = await db
        .select()
        .from(trackTable)
        .where(eq(trackTable.uri, currentTrack.uri));

      if (!track || !track.embedding) {
        console.error("No embedding found for current track");
        return;
      }

      // Convert embedding to Float32Array if needed
      const embedding = track.embedding instanceof Float32Array 
        ? track.embedding 
        : new Float32Array(track.embedding);

      console.log(`Visualizing track: ${track.name}`);
      await this.playEmbedding(embedding);
      
    } catch (error) {
      console.error("Error visualizing current track:", error);
    }
  }

  // Continuous visualization that updates with track changes
  public async startContinuousVisualization(checkInterval: number = 15000): Promise<void> {
    console.log("Starting continuous WLED visualization...");
    
    console.log("WLED polling Home Assistant every 15s for track changes...");

    const checkAndUpdate = async () => {
      try {
        const currentTrack = await getCurrentTrack();
        if (!currentTrack || !currentTrack.uri) return;

        const [track] = await db
          .select()
          .from(trackTable)
          .where(eq(trackTable.uri, currentTrack.uri));

        if (!track || !track.embedding) return;

        const embedding = track.embedding instanceof Float32Array 
          ? track.embedding 
          : new Float32Array(track.embedding);

        // Only update if embedding has changed
        if (!this.currentEmbedding || 
            !this.arraysEqual(this.currentEmbedding, embedding)) {
          
          console.log(`Track changed: ${track.name}`);
          await this.playEmbedding(embedding);
        }
        
      } catch (error) {
        console.error("Error in continuous visualization:", error);
      }
    };

    // Initial check
    await checkAndUpdate();
    
    // Set up periodic checks
    setInterval(checkAndUpdate, checkInterval);
  }

  // Utility to compare Float32Arrays
  private arraysEqual(a: Float32Array, b: Float32Array): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (Math.abs(a[i] - b[i]) > 0.0001) return false;
    }
    return true;
  }
}

// Usage examples
export async function startWLEDVisualization(wledIp: string) {
  const visualizer = new EmbeddingVisualizer(wledIp);
  
  // Start continuous visualization that updates with track changes
  await visualizer.startContinuousVisualization();
  
  return visualizer;
}

// Single track visualization
export async function visualizeCurrentTrackOnce(wledIp: string, duration: number = 30) {
  const visualizer = new EmbeddingVisualizer(wledIp);
  await visualizer.visualizeCurrentTrack();
  return visualizer;
}

// CLI command for testing
export async function testVisualization(wledIp: string) {
  const visualizer = new EmbeddingVisualizer(wledIp);
  
  // Create a test embedding with some pattern
  const testEmbedding = new Float32Array(512);
  for (let i = 0; i < 512; i++) {
    testEmbedding[i] = Math.sin(i * 0.1) + Math.random() * 0.2;
  }
  
  console.log("Testing WLED visualization with test embedding...");
  await visualizer.playEmbedding(testEmbedding, 10);
}