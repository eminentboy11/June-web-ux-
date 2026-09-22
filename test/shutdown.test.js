// NUCLEAR SHUTDOWN TEST — verifies the 3-kill chain in utils/shutdown.js:
//   1. requestShutdown writes { killsLeft: 2 } into the state file
//   2. no state file → enforceShutdownChain returns (normal boot, no exit)
//   3. state 2 → exit(44), state rewritten to 1
//   4. state 1 → exit(44), state deleted
//   5. after the chain → boot normally and stay alive
//   6. full simulation: command + boots → exactly 3 kills total, then alive
//   7. fail-open: corrupt JSON / spent count / stateFile-is-a-dir → no exit
//   8. exit code is always 44
// Uses a real temp dir via mkdtemp — never touches the bot's actual state file.

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const shutdown = require('../utils/shutdown');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shutdown-test-'));
const stateFile = path.join(tmp, 'database', 'shutdown-state.json');

function makeOpts(codes) {
  // Captures exit calls; the process is never actually killed in tests.
  return {
    stateFile,
    codes,
    log: () => {},
    fatalLog: () => {},
    exit: (code) => codes.push(code),
  };
}

function writeState(killsLeft) {
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify({ killsLeft, at: Date.now() }), 'utf8');
}

// 1. requestShutdown writes the correct state (auto-creates database/ dir)
{
  const ok = shutdown.requestShutdown({ stateFile, log: () => {} });
  assert.strictEqual(ok, true, 'requestShutdown should succeed');
  const st = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.strictEqual(st.killsLeft, 2, 'killsLeft should start at 2');
  assert.ok(typeof st.at === 'number' && st.at > 0, 'state should carry a timestamp');
}

// 2. no state file → normal boot, no exit, nothing created
{
  fs.unlinkSync(stateFile);
  const codes = [];
  shutdown.enforceShutdownChain(makeOpts(codes));
  assert.deepStrictEqual(codes, [], 'no state file must not exit');
  assert.strictEqual(fs.existsSync(stateFile), false, 'no state file must not be created');
}

// 3. killsLeft 2 → exit 44, rewritten to 1
{
  writeState(2);
  const codes = [];
  shutdown.enforceShutdownChain(makeOpts(codes));
  assert.deepStrictEqual(codes, [44], 'kill 2/3 must exit with code 44');
  const st = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.strictEqual(st.killsLeft, 1, 'state must decrement to 1');
}

// 4. killsLeft 1 → exit 44, state deleted
{
  writeState(1);
  const codes = [];
  shutdown.enforceShutdownChain(makeOpts(codes));
  assert.deepStrictEqual(codes, [44], 'kill 3/3 must exit with code 44');
  assert.strictEqual(fs.existsSync(stateFile), false, 'final kill must delete the state file');
}

// 5. after the chain → normal boot
{
  const codes = [];
  shutdown.enforceShutdownChain(makeOpts(codes));
  assert.deepStrictEqual(codes, [], 'boot after the chain must be a normal boot');
}

// 6. full simulation: command exit (kill 1) + boots until alive
{
  const codes = [];
  shutdown.requestShutdown({ stateFile, log: () => {} });
  codes.push(shutdown.EXIT_CODE); // kill 1: the command's own process.exit
  let boots = 0;
  while (boots < 5) {
    const before = codes.length;
    shutdown.enforceShutdownChain(makeOpts(codes));
    boots++;
    if (codes.length === before) break; // this boot stayed alive
  }
  assert.strictEqual(codes.length, 3, `chain must produce exactly 3 kills total, got ${codes.length}`);
  assert.ok(codes.every((c) => c === 44), 'every kill must use exit code 44');
  assert.strictEqual(boots, 3, 'the 3rd boot must stay alive');
  assert.strictEqual(fs.existsSync(stateFile), false, 'state must be gone when the bot is alive');
}

// 7a. corrupt JSON → fail-open: no exit, file deleted
{
  writeState(2);
  fs.writeFileSync(stateFile, '{ not json !!!', 'utf8');
  const codes = [];
  shutdown.enforceShutdownChain(makeOpts(codes));
  assert.deepStrictEqual(codes, [], 'corrupt state must fail open (boot normally)');
  assert.strictEqual(fs.existsSync(stateFile), false, 'corrupt state file must be deleted');
}

// 7b. spent/invalid count → fail-open: no exit, file deleted
{
  writeState(0);
  let codes = [];
  shutdown.enforceShutdownChain(makeOpts(codes));
  assert.deepStrictEqual(codes, [], 'killsLeft 0 must fail open');
  assert.strictEqual(fs.existsSync(stateFile), false, 'spent state file must be deleted');

  writeState('banana');
  codes = [];
  shutdown.enforceShutdownChain(makeOpts(codes));
  assert.deepStrictEqual(codes, [], 'non-numeric killsLeft must fail open');
}

// 7c. stateFile path is a directory → readFileSync throws EISDIR → fail-open
{
  fs.mkdirSync(stateFile, { recursive: true });
  const codes = [];
  shutdown.enforceShutdownChain(makeOpts(codes));
  assert.deepStrictEqual(codes, [], 'dir-as-state must fail open without throwing');
  fs.rmdirSync(stateFile);
}

// 8. default STATE_FILE location: inside database/ (loader SKIP_DIRS-safe)
{
  assert.ok(
    shutdown.STATE_FILE.endsWith(path.join('database', 'shutdown-state.json')),
    'default state file must live in database/'
  );
  assert.ok(
    !shutdown.STATE_FILE.startsWith(os.tmpdir()),
    'default state file must be inside the bot folder'
  );
}

// 9. requestShutdown to a non-writable location → returns false, no throw
{
  const bad = path.join(tmp, 'shutdown-state.json', 'nested', 'x.json'); // parent is a file, later
  fs.writeFileSync(path.join(tmp, 'shutdown-state.json'), 'x', 'utf8');
  const ok = shutdown.requestShutdown({ stateFile: bad, log: () => {} });
  assert.strictEqual(ok, false, 'non-writable state path must return false');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('SHUTDOWN TEST: all assertions passed');
