import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

export async function sendNotification(title: string, message: string): Promise<void> {
  if (process.platform === "darwin") {
    const t = title.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const m = message.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    try {
      await execAsync(`osascript -e 'display notification "${m}" with title "${t}"'`);
    } catch {
      console.log(`[Notification] ${title}: ${message}`);
    }
  } else {
    console.log(`[Notification] ${title}: ${message}`);
  }
}
