/**
 * Console Logger — June Ultra's classic style, rainbow console only.
 *
 * Blue bold `[ JUNEX ULTRA ]` prefix, magenta `[ CMD ]` command lines, and
 * the big one-box startup report from index.js. No day/night theme
 * switching — this is the only console style used.
 */
'use strict';
const chalk = require('chalk');
const db = require('../database');

// ── Time zone — single source of truth: the bot's own timezone setting ─────
// Priority: 1) bot setting 'timezone' (set with .settimezone) → 2) TIMEZONE
// env → 3) UTC fallback. Kept here for any module that still calls it.
function _validTz(v) {
  if (!v || typeof v !== 'string') return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: v }).format(new Date()); return true; }
  catch (_) { return false; }
}
function getTimeZone() {
  if (typeof db.getTimeZone === 'function') {
    try { return db.getTimeZone(); } catch (_) {}
  }
  try {
    const setting = db.getBotSetting('timezone');
    if (_validTz(setting)) return setting;
  } catch (_) {}
  if (_validTz(process.env.TIMEZONE)) return process.env.TIMEZONE;
  return 'UTC';
}
function getTimeZoneSource() {
  if (typeof db.getTimeZoneSource === 'function') {
    try { return db.getTimeZoneSource(); } catch (_) {}
  }
  try { if (_validTz(db.getBotSetting('timezone'))) return 'bot'; } catch (_) {}
  if (_validTz(process.env.TIMEZONE)) return 'env';
  return 'default';
}

function nowParts() {
  const timeZone = getTimeZone();
  const d = new Date();
  const time = d.toLocaleTimeString('en-US', {
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone,
  });
  const hour = Number(d.toLocaleString('en-US', { hour: '2-digit', hour12: false, timeZone }));
  return { time, hour: Number.isFinite(hour) ? hour : 0 };
}

// ── Logger — June Ultra's classic log(), byte-identical output ─────────────
function log(message, color = 'white', isError = false) {
  const prefix = chalk.blue.bold('[ JUNEX ULTRA ]');
  const logFunc = isError ? console.error : console.log;
  const coloredMessage = chalk[color] ? chalk[color](message) : message;
  if (String(message).includes('\n') || String(message).includes('════')) {
    logFunc(prefix, coloredMessage)
  } else {
    logFunc(`${prefix} ${coloredMessage}`)
  }
}

// ── Command execution line (handler.js) ─────────────────────────────────────
function cmdLine(commandName, senderNum, role) {
  console.log(
    chalk.magenta.bold('[ CMD ]'),
    chalk.cyan(`✦ ${commandName}`),
    chalk.yellow(`← ${senderNum}`),
    role === 'OWNER' ? chalk.green('[OWNER]') : role === 'SUDO' ? chalk.blue('[SUDO]') : chalk.white('[USER]')
  );
}

module.exports = {
  getTimeZone, getTimeZoneSource, nowParts, log, cmdLine,
};
