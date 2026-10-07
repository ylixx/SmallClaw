// SmallClaw 本地后端启动器 — 跟随 .smallclaw/config.json 的活跃模型档案。
// 用法：node scripts/start-backend.js （或双击 start-llama-cpp.bat 调用本脚本）
// 行为：
//   活跃档案为 llama_cpp → 按档案的 server.model_path / mmproj_path / ctx_size / ngl 启动 llama-server；
//   8080 已跑相同模型 → 提示已在运行，不重启；
//   8080 已跑不同模型 → 提示冲突，询问是否自动重启；
//   活跃档案为云端/其他 → 提示无需本地后端。
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const readline = require('readline');

const root = path.resolve(__dirname, '..');
const configPath = path.join(root, '.smallclaw', 'config.json');
const PORT = 8080;

function fail(msg) {
  console.error('[start-backend] ' + msg);
  process.exit(1);
}

function healthCheck() {
  return new Promise((res) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/health', timeout: 2000 }, (r) => {
      let body = '';
      r.on('data', (d) => { body += d; });
      r.on('end', () => res({ ok: true, body }));
    });
    req.on('error', () => res({ ok: false }));
    req.on('timeout', () => { req.destroy(); res({ ok: false }); });
  });
}

function fetchProps() {
  return new Promise((res) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/props', timeout: 2500 }, (r) => {
      let body = '';
      r.on('data', (d) => { body += d; });
      r.on('end', () => {
        try { res(JSON.parse(body)); } catch { res(null); }
      });
    });
    req.on('error', () => res(null));
    req.on('timeout', () => { req.destroy(); res(null); });
  });
}

function ask(question) {
  return new Promise((res) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => { rl.close(); res(answer.trim().toLowerCase()); });
  });
}

function findLlamaServer() {
  const env = process.env.SMALLCLAW_LLAMA_SERVER;
  const candidates = [
    env && env.trim() ? env.trim() : null,
    path.join('E:\\llama-b11000', 'llama-server.exe'),
    path.join('D:\\llama.cpp', 'llama-server.exe'),
    path.join('C:\\llama.cpp', 'llama-server.exe'),
  ].filter(Boolean);
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

async function main() {
  if (!fs.existsSync(configPath)) fail('未找到 .smallclaw/config.json');
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8')); } catch { fail('config.json 解析失败（可能是编码问题，须为 UTF-8 无 BOM）'); }

  const llm = cfg.llm || {};
  const presetId = String(llm.active_preset || '').trim();
  const preset = llm.presets?.[presetId];
  if (!preset) fail(`未找到活跃档案 "${presetId}"（.smallclaw/config.json 的 llm.active_preset）`);

  const provider = String(preset.provider || '');
  console.log(`[start-backend] 活跃档案: ${preset.name || presetId} (provider=${provider})`);

  if (provider !== 'llama_cpp') {
    console.log(`  该档案使用 ${provider}（云端/其他），无需本地 llama-server。`);
    if (provider === 'ollama') console.log('  如使用 Ollama：请用 `ollama run <模型名>` 自行启动对应模型。');
    process.exit(0);
  }

  const serverCfg = preset.server || {};
  const providerCfg = preset.providers?.llama_cpp || {};
  const modelPath = serverCfg.model_path || providerCfg.model || '';
  const mmprojPath = serverCfg.mmproj_path || '';
  const ctxSize = serverCfg.ctx_size || 49152;
  const ngl = serverCfg.ngl ?? 99;

  if (!modelPath) fail('该 llama.cpp 档案缺少 GGUF 模型路径（preset.server.model_path）');
  if (!fs.existsSync(modelPath)) fail(`模型文件不存在: ${modelPath}`);

  const alias = path.basename(modelPath).replace(/\.gguf$/i, '');

  const health = await healthCheck();
  if (health.ok) {
    const props = await fetchProps();
    const running = String(props?.model_alias || props?.model_path || '');
    const same = running && (running === modelPath || running.includes(alias) || (props?.model_path || '').toLowerCase().replace(/\\/g, '/') === modelPath.toLowerCase().replace(/\\/g, '/'));
    if (same) {
      console.log(`  127.0.0.1:${PORT} 已在运行相同模型：${running}`);
      console.log('  无需重启。');
      process.exit(0);
    }
    console.log(`  127.0.0.1:${PORT} 正在运行其他模型：${running || '未知'}`);
    console.log(`  目标模型：${modelPath}`);
    const answer = await ask('  是否自动重启为当前档案的模型？(y/N) ');
    if (answer !== 'y' && answer !== 'yes') { console.log('  已取消。请手动关闭现有 llama-server 后重试。'); process.exit(1); }
    // kill the existing llama-server process listening on 8080
    const { execSync } = require('child_process');
    try {
      const out = execSync('netstat -ano | findstr :8080 | findstr LISTENING', { encoding: 'utf-8', shell: 'cmd.exe' });
      const pids = [...new Set(out.split(/\r?\n/).map((l) => l.trim().split(/\s+/).pop()).filter((p) => p && /^\d+$/.test(p)))];
      for (const pid of pids) {
        try { execSync(`taskkill /PID ${pid} /F`, { shell: 'cmd.exe' }); console.log(`  已停止进程 ${pid}`); } catch {}
      }
      await new Promise((r) => setTimeout(r, 1500));
    } catch {
      console.log('  未能自动停止现有 llama-server，请手动关闭后重试。');
      process.exit(1);
    }
  }

  const exe = findLlamaServer();
  if (!exe) {
    console.log('  未找到 llama-server.exe（可通过环境变量 SMALLCLAW_LLAMA_SERVER 指定路径）。');
    process.exit(1);
  }

  const args = [
    '-m', modelPath,
    '--host', '127.0.0.1',
    '--port', String(PORT),
    '-ngl', String(ngl),
    '--ctx-size', String(ctxSize),
    '--cache-type-k', 'q8_0',
    '--cache-type-v', 'q8_0',
    '--alias', alias,
  ];
  if (mmprojPath && fs.existsSync(mmprojPath)) args.push('--mmproj', mmprojPath);
  else if (mmprojPath) console.log(`  提示：mmproj 文件不存在，本次无图像支持: ${mmprojPath}`);

  console.log(`  启动: ${exe} ${args.join(' ')}`);
  console.log('  模型加载约需 30-60 秒，就绪后 127.0.0.1:8080 会响应 /health。');
  const child = spawn(exe, args, { cwd: root, stdio: 'inherit' });
  child.on('error', (e) => console.error('  启动失败:', e.message));
  child.on('exit', (code) => console.log(`  llama-server 已退出 (code=${code})`));
}

main().catch((e) => fail(e.message));
