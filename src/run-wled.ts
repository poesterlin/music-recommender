import { env } from "bun";
import { startWLEDVisualization, testVisualization } from "./wled-visualizer";

console.log("Starting WLED visualization test...");

// Check environment variable
const wledIp = env.WLED_IP;
if (!wledIp) {
  console.error("WLED_IP environment variable is not set!");
  console.log("Set it with: export WLED_IP=192.168.1.100");
  process.exit(1);
}

console.log(`Using WLED IP: ${wledIp}`);

// Wait a bit then start continuous visualization
await startWLEDVisualization(wledIp);