import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

export interface ChromeStatus {
  online: boolean;
  chrome_running: boolean;
  chrome_debug_accessible: boolean;
  message: string;
}

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

export async function checkChromeStatus(): Promise<ChromeStatus> {
  const chrome_running = await isChromeRunning();

  if (!chrome_running) {
    return {
      online: true,
      chrome_running: false,
      chrome_debug_accessible: false,
      message:
        "Local machine is online but Chrome is not running. " +
        "Please open Chrome and enable remote debugging at chrome://inspect/#remote-debugging",
    };
  }

  const chrome_debug_accessible = await isChromeDebugAccessible();

  if (!chrome_debug_accessible) {
    return {
      online: true,
      chrome_running: true,
      chrome_debug_accessible: false,
      message:
        "Chrome is running but remote debugging is not accessible. " +
        "For channel mode: visit chrome://inspect/#remote-debugging and enable it. " +
        "For CDP port mode: launch Chrome with --remote-debugging-port=9222",
    };
  }

  return {
    online: true,
    chrome_running: true,
    chrome_debug_accessible: true,
    message: "Local machine is online and Chrome is ready for remote control",
  };
}
