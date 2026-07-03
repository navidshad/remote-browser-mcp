import { exec } from "child_process";
import { promisify } from "util";
import net from "net";

const execAsync = promisify(exec);

export interface ChromeStatus {
  online: boolean;
  chrome_running: boolean;
  /** Browser is reachable for remote control. In extension mode this means the
   *  Playwright MCP bridge is up; in cdp mode it means the CDP port answers. */
  chrome_debug_accessible: boolean;
  message: string;
}

/** How Playwright MCP attaches to Chrome — mirrors BROWSER_MODE in start-local.sh. */
const BROWSER_MODE = process.env.BROWSER_MODE ?? "extension";

async function isChromeRunning(): Promise<boolean> {
  try {
    if (process.platform === "darwin") {
      const { stdout } = await execAsync("pgrep -x 'Google Chrome'");
      return stdout.trim().length > 0;
    }
    if (process.platform === "linux") {
      const { stdout } = await execAsync(
        "pgrep -x chrome || pgrep -x google-chrome || pgrep -x chromium-browser || pgrep -x chromium || true"
      );
      return stdout.trim().length > 0;
    }
    if (process.platform === "win32") {
      const { stdout } = await execAsync('tasklist /FI "IMAGENAME eq chrome.exe" /NH');
      return stdout.toLowerCase().includes("chrome.exe");
    }
    return false;
  } catch {
    return false;
  }
}

/** True if a TCP server is accepting connections on localhost:port. */
function isPortOpen(port: number, timeoutMs = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const finish = (v: boolean) => {
      socket.destroy();
      resolve(v);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    socket.connect(port, "localhost");
  });
}

/** CDP-port mode: Chrome must answer the DevTools endpoint on CDP_PORT. */
async function isChromeDebugAccessible(): Promise<boolean> {
  const port = process.env.CDP_PORT ?? "9222";
  try {
    const resp = await fetch(`http://localhost:${port}/json/version`, {
      signal: AbortSignal.timeout(2000),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

/** Extension mode: readiness = the Playwright MCP bridge server is listening.
 *  With PLAYWRIGHT_MCP_EXTENSION_TOKEN set it auto-attaches to the paired
 *  (Aso Dara) profile, so a running server means the browser is drivable —
 *  provided that profile's Chrome window is open. */
async function isExtensionBridgeReady(): Promise<boolean> {
  const port = Number(process.env.PLAYWRIGHT_PORT ?? "3000");
  return isPortOpen(port);
}

export async function checkChromeStatus(): Promise<ChromeStatus> {
  const chrome_running = await isChromeRunning();

  if (!chrome_running) {
    return {
      online: true,
      chrome_running: false,
      chrome_debug_accessible: false,
      message:
        BROWSER_MODE === "extension"
          ? "Local machine is online but Chrome is not running. Open the dedicated agent Chrome profile (Aso Dara)."
          : "Local machine is online but Chrome is not running. Please open Chrome.",
    };
  }

  const ready =
    BROWSER_MODE === "extension"
      ? await isExtensionBridgeReady()
      : await isChromeDebugAccessible();

  if (!ready) {
    return {
      online: true,
      chrome_running: true,
      chrome_debug_accessible: false,
      message:
        BROWSER_MODE === "extension"
          ? "Chrome is running but the Playwright MCP bridge is not reachable. Make sure host services are up (make start-local) and the Playwright MCP Bridge extension is connected in the Aso Dara profile."
          : "Chrome is running but remote debugging is not accessible. Launch the debug Chrome: make chrome-debug.",
    };
  }

  return {
    online: true,
    chrome_running: true,
    chrome_debug_accessible: true,
    message:
      BROWSER_MODE === "extension"
        ? "Local machine is online and the agent browser (Aso Dara) is ready for remote control."
        : "Local machine is online and Chrome is ready for remote control.",
  };
}
