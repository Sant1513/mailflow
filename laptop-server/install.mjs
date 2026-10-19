/**
 * Makes Windows start the MailFlow laptop server whenever you sign in, with no window.
 *
 *   node install.mjs            add it to Startup
 *   node install.mjs --remove   take it out again
 *
 * It adds "MailFlow server.vbs" to your Startup folder. The script keeps start.mjs running:
 * if it ever stops, it is started again a minute later (start.mjs exits straight away when a
 * copy is already running, so this never starts two).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const startup = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
const target = path.join(startup, 'MailFlow server.vbs');

if (process.argv.includes('--remove')) {
  fs.rmSync(target, { force: true });
  console.log(`Removed ${target}`);
  process.exit(0);
}

const q = (s) => s.replace(/"/g, '""');
const command = `"${q(process.execPath)}" "${q(path.join(HERE, 'start.mjs'))}"`;
const vbs = [
  "' MailFlow laptop server: keeps laptop-server\\start.mjs running (see install.mjs).",
  'Set shell = CreateObject("WScript.Shell")',
  `shell.CurrentDirectory = "${q(HERE)}"`,
  'Do',
  `  shell.Run "${q(command)}", 0, True`,
  '  WScript.Sleep 60000',
  'Loop',
  '',
].join('\r\n');

fs.mkdirSync(startup, { recursive: true });
fs.writeFileSync(target, vbs);
console.log(`Added ${target}\nMailFlow will start whenever you sign in to Windows.`);
