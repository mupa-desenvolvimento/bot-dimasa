const { spawn } = require('child_process');
const path = require('path');

function runProcess(label, script, args = []) {
  const child = spawn('node', [script, ...args], {
    cwd: __dirname,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  child.stdout.on('data', (data) => {
    process.stdout.write(`[${label}] ${data}`);
  });

  child.stderr.on('data', (data) => {
    process.stderr.write(`[${label}] ${data}`);
  });

  child.on('exit', (code) => {
    console.log(`[${label}] encerrado com código ${code}`);
  });

  return child;
}

const botArgs = (process.env.BOT_MODE === 'workspace_download') ? ['workspace'] : [];
const bot = runProcess('BOT', path.join(__dirname, 'bot_visual.js'), botArgs);
const ocr = runProcess('OCR', path.join(__dirname, 'ocr_worker.js'));
const server = runProcess('SERVER', path.join(__dirname, 'server.js'));

function shutdown() {
  if (bot && !bot.killed) {
    try { bot.kill(); } catch (e) {}
  }
  if (ocr && !ocr.killed) {
    try { ocr.kill(); } catch (e) {}
  }
  if (server && !server.killed) {
    try { server.kill(); } catch (e) {}
  }
  process.exit();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
