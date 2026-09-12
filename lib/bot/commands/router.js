import * as menu from './menu.js';
import * as help from './help.js';
import * as whoami from './whoami.js';
import * as version from './version.js';
import * as aitest from './aitest.js';
import * as stats from './stats.js';
import * as total from './total.js';
import * as pending from './pending.js';
import * as memories from './memories.js';
import * as remember from './remember.js';
import * as forget from './forget.js';
import * as clearchat from './clearchat.js';
import * as setcaption from './setcaption.js';
import * as stop from './stop.js';
import * as resume from './resume.js';
import * as resetbatch from './resetbatch.js';
import { parseCommand } from '../core/command.js';
import { isAdminMessage } from '../core/auth.js';

const modules = [
  menu,
  help,
  whoami,
  version,
  aitest,
  stats,
  total,
  pending,
  memories,
  remember,
  forget,
  clearchat,
  setcaption,
  stop,
  resume,
  resetbatch,
];

const registry = new Map();
for (const mod of modules) {
  for (const name of mod.names || []) {
    registry.set(String(name).toLowerCase(), mod);
  }
}

export const registeredCommandNames = [...registry.keys()].sort();

export async function routeCommand({ message, req, res }) {
  if (message?.chat?.type !== 'private') return false;
  const command = parseCommand(message.text);
  if (!command) return false;

  const mod = registry.get(command.name);
  if (!mod) return false;

  const adminOnly = mod.adminOnly !== false;
  if (adminOnly && !isAdminMessage(message)) {
    return res.status(200).json({ ok: true, ignored: 'not_admin', command: command.name });
  }

  return mod.handle({ message, req, res, command });
}
