#!/usr/bin/env node
'use strict';

const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const path = require('node:path');
const runFile = promisify(execFile);
const LEVELS = ['verbose', 'info', 'warning', 'error'];

/** 用稳定错误码区分参数、环境和协议故障。 */
class ConsoleError extends Error {
  constructor(code, message, details, exitCode = 1) {
    super(message);
    Object.assign(this, { code, details, exitCode });
  }
}

/** 校验命令行参数，避免把拼写错误当作没有匹配日志。 */
function parseArgs(args, cwd = process.cwd()) {
  const options = { project: path.basename(cwd), grep: '', levels: [], limit: 100, list: false, expand: false, depth: 3 };
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === '--list') { options.list = true; continue; }
    if (flag === '--expand') { options.expand = true; continue; }
    if (!['--project', '--grep', '--level', '--limit', '--target', '--depth'].includes(flag)) {
      throw new ConsoleError('INVALID_ARGUMENT', `未知参数：${flag}`, undefined, 2);
    }
    const value = args[++index];
    if (value === undefined || value.startsWith('--')) {
      throw new ConsoleError('INVALID_ARGUMENT', `${flag} 缺少参数值`, undefined, 2);
    }
    if (flag === '--project') options.project = value;
    if (flag === '--grep') options.grep = value;
    if (flag === '--level') options.levels = value.split(',');
    if (flag === '--limit') {
      if (!/^\d+$/.test(value)) throw new ConsoleError('INVALID_ARGUMENT', 'limit 必须为整数', undefined, 2);
      options.limit = Number(value);
    }
    if (flag === '--target') options.target = value;
    if (flag === '--depth') {
      if (!/^[1-6]$/.test(value)) throw new ConsoleError('INVALID_ARGUMENT', 'depth 必须为 1～6 的整数', undefined, 2);
      options.depth = Number(value);
      options.expand = true;
    }
  }
  if (!options.project || options.levels.some(level => !LEVELS.includes(level)) || options.limit < 1 || options.limit > 1000) {
    throw new ConsoleError('INVALID_ARGUMENT', '项目名不能为空；level 为 verbose/info/warning/error；limit 为 1～1000', undefined, 2);
  }
  if (options.target && (!/^(\d{1,5}):[A-Za-z0-9_-]+$/.test(options.target) ||
      Number(options.target.split(':')[0]) < 1 || Number(options.target.split(':')[0]) > 65535)) {
    throw new ConsoleError('INVALID_ARGUMENT', 'target 格式为 <port>:<targetId>，端口为 1～65535', undefined, 2);
  }
  if (options.list && options.target) throw new ConsoleError('INVALID_ARGUMENT', '--list 与 --target 不能同时使用', undefined, 2);
  return options;
}

/** 解析 lsof 字段输出，支持 IPv4、IPv6 和重复监听描述符。 */
function parseListeners(output) {
  const result = new Map();
  let pid;
  for (const line of output.split('\n')) {
    if (/^p\d+$/.test(line)) {
      pid = line.slice(1);
      if (!result.has(pid)) result.set(pid, new Set());
    } else if (pid && line.startsWith('n')) {
      const port = /:(\d+)$/.exec(line);
      if (port) result.get(pid).add(Number(port[1]));
    }
  }
  return result;
}

/** 用可执行文件确认主进程，避免依赖截断的中文进程名。 */
function parseMainPids(output) {
  const result = new Set();
  let pid;
  for (const line of output.split('\n')) {
    if (/^p\d+$/.test(line)) pid = line.slice(1);
    if (pid && /\/Contents\/MacOS\/淘宝开发者工具$/.test(line)) result.add(pid);
  }
  return result;
}

/** 每次重新发现端口，命令参数经 execFile 传递而不经过 shell。 */
async function discoverPorts(signal) {
  /** lsof 的退出码 1 可以表示没有匹配项，需要保留已有输出。 */
  async function lsof(args) {
    try {
      return (await runFile('lsof', args, { encoding: 'utf8', signal, timeout: 2000, maxBuffer: 4 * 1024 * 1024 })).stdout;
    } catch (error) {
      if (error.code === 1 && !error.stderr?.trim()) return error.stdout || '';
      if (signal.aborted) throw new ConsoleError('TIMEOUT', '读取日志超过总时间限制');
      throw new ConsoleError('DISCOVERY_FAILED', '无法通过 lsof 读取 IDE 进程和端口');
    }
  }
  const listeners = parseListeners(await lsof(['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpn']));
  if (!listeners.size) throw new ConsoleError('IDE_NOT_RUNNING', '未发现运行中的淘宝开发者工具');
  const pids = parseMainPids(await lsof(['-a', '-p', [...listeners.keys()].join(','), '-d', 'txt', '-Fpn']));
  const ports = [...new Set([...pids].flatMap(pid => [...(listeners.get(pid) || [])]))];
  if (!ports.length) throw new ConsoleError('IDE_NOT_RUNNING', '未发现淘宝开发者工具主进程的监听端口');
  return ports;
}

/** 管理主进程代理的协议请求、事件等待和自身连接的释放。 */
class CdpClient {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.waiters = new Set();
    this.closed = false;
    socket.addEventListener('message', ({ data }) => {
      let message;
      try { message = JSON.parse(String(data)); } catch { return; }
      for (const waiter of [...this.waiters]) waiter.receive(message);
    });
    socket.addEventListener('close', () => this.fail(new ConsoleError('CONNECTION_CLOSED', 'IDE 调试连接已断开')));
    socket.addEventListener('error', () => this.fail(new ConsoleError('CONNECTION_FAILED', 'IDE 调试连接失败')));
  }

  /** 建立本地连接；探测阶段和读取阶段分别使用各自的取消信号。 */
  static async connect(port, { signal, timeoutMs = 2000, WebSocketImpl = WebSocket } = {}) {
    if (signal?.aborted) throw new ConsoleError('TIMEOUT', '连接 IDE 调试代理超时');
    const socket = new WebSocketImpl(`ws://127.0.0.1:${port}`);
    const client = new CdpClient(socket);
    try {
      await new Promise((resolve, reject) => {
        /** 连接结果确定后释放临时监听。 */
        function finish(error) {
          clearTimeout(timer);
          signal?.removeEventListener('abort', abort);
          socket.removeEventListener('open', open);
          socket.removeEventListener('error', failed);
          socket.removeEventListener('close', failed);
          if (error) reject(error); else resolve();
        }
        /** 握手成功后允许发送命令。 */
        function open() { finish(); }
        /** 握手失败时不输出底层请求内容。 */
        function failed() { finish(new ConsoleError('CONNECTION_FAILED', '无法连接 IDE 调试代理')); }
        /** 探测或整次任务到期时结束握手。 */
        function abort() { finish(new ConsoleError('TIMEOUT', '连接 IDE 调试代理超时')); }
        const timer = setTimeout(abort, timeoutMs);
        socket.addEventListener('open', open);
        socket.addEventListener('error', failed);
        socket.addEventListener('close', failed);
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
      });
      return client;
    } catch (error) { client.close(); throw error; }
  }

  /** 注册一次性等待，允许嵌套事件先于外层命令确认到达。 */
  waitFor(predicate, { signal, timeoutMs = 5000 } = {}) {
    let dispose;
    const promise = new Promise((resolve, reject) => {
      const waiter = {
        /** 只结束匹配的请求或会话事件。 */
        receive: message => { if (predicate(message)) { dispose(); resolve(message); } },
        /** 连接失效时立即结束调用。 */
        reject: error => { dispose(); reject(error); },
      };
      /** 超时和取消使用同一个错误码。 */
      const abort = () => waiter.reject(new ConsoleError('TIMEOUT', 'IDE 调试协议请求超时'));
      const timer = setTimeout(abort, timeoutMs);
      dispose = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        this.waiters.delete(waiter);
      };
      this.waiters.add(waiter);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      else if (this.closed) waiter.reject(new ConsoleError('CONNECTION_CLOSED', 'IDE 调试连接已断开'));
    });
    return { promise, dispose: () => dispose() };
  }

  /** 发送唯一 ID 的命令，空错误对象也视为失败。 */
  async request(method, params = {}, options = {}) {
    if (options.signal?.aborted) throw new ConsoleError('TIMEOUT', 'IDE 调试协议请求超时');
    const id = this.nextId++;
    const waiter = this.waitFor(message => message.id === id, options);
    try {
      const [message] = await Promise.all([
        waiter.promise,
        Promise.resolve().then(() => {
          if (this.closed) throw new ConsoleError('CONNECTION_CLOSED', 'IDE 调试连接已断开');
          this.socket.send(JSON.stringify({ id, method, params }));
        }),
      ]);
      if (message.error != null || !message.result || typeof message.result !== 'object') {
        throw new ConsoleError('PROTOCOL_ERROR', `IDE 调试命令失败：${method}`);
      }
      return message.result;
    } finally { waiter.dispose(); }
  }

  /** 使用非扁平会话，兼容代理不转发顶层 sessionId 的行为。 */
  async evaluate(sessionId, expression, options) {
    const id = this.nextId++;
    const waiter = this.waitFor(message => {
      if (message.method !== 'Target.receivedMessageFromTarget' || message.params?.sessionId !== sessionId) return false;
      try { return JSON.parse(message.params.message).id === id; } catch { return false; }
    }, options);
    try {
      const [, event] = await Promise.all([
        this.request('Target.sendMessageToTarget', {
          sessionId,
          message: JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }),
        }, options),
        waiter.promise,
      ]);
      const response = JSON.parse(event.params.message);
      if (response.error != null || response.result?.exceptionDetails || !response.result?.result?.value) {
        throw new ConsoleError('INTERFACE_INCOMPATIBLE', '调试器日志模型不可用或 Runtime.evaluate 读取失败');
      }
      return response.result.result.value;
    } finally { waiter.dispose(); }
  }

  /** 让未完成命令失败并移除其等待器、定时器和取消监听。 */
  fail(error) {
    this.closed = true;
    for (const waiter of [...this.waiters]) waiter.reject(error);
  }

  /** 关闭本脚本的连接，不操作 IDE 已有的调试连接。 */
  close() {
    this.fail(new ConsoleError('CONNECTION_CLOSED', '调试读取已结束'));
    try { this.socket.close(); } catch { /* 连接已经关闭，无需重复处理。 */ }
  }
}

/** 验证代理身份和目标列表，失败时立即释放候选连接。 */
async function probeService(port, signal) {
  const probeSignal = AbortSignal.any([signal, AbortSignal.timeout(2000)]);
  const client = await CdpClient.connect(port, { signal: probeSignal });
  try {
    const version = await client.request('Browser.getVersion', {}, { signal: probeSignal, timeoutMs: 2000 });
    if (!/taobao-dev-tool/i.test(version.userAgent || '')) throw new ConsoleError('INTERFACE_INCOMPATIBLE', '服务不是淘宝 IDE 调试代理');
    const result = await client.request('Target.getTargets', {}, { signal: probeSignal, timeoutMs: 2000 });
    if (!Array.isArray(result.targetInfos)) throw new ConsoleError('INTERFACE_INCOMPATIBLE', 'IDE 未返回调试目标列表');
    return {
      port, client,
      projects: result.targetInfos.filter(target => target.type === 'page' && target.url?.includes('/editor/browser/index.html')),
      targets: result.targetInfos.filter(target => target.type === 'webview' && target.url?.includes('/mini-devtools-frontend/')),
    };
  } catch (error) { client.close(); throw error; }
}

/** 候选列表不包含可能携带内部令牌的目标 URL。 */
function summarizeServices(services) {
  return services.map(service => ({
    port: service.port,
    projects: service.projects.map(project => ({ targetId: project.targetId, title: project.title })),
    targets: service.targets.map(target => ({ targetId: target.targetId, selector: `${service.port}:${target.targetId}` })),
  }));
}

/** 仅在项目与调试器均唯一时自动选择，显式目标可以解除歧义。 */
function selectTarget(services, options) {
  const candidates = summarizeServices(services);
  if (options.target) {
    const service = services.find(service => service.targets.some(target => `${service.port}:${target.targetId}` === options.target));
    if (!service) throw new ConsoleError('TARGET_NOT_FOUND', '指定目标不存在，请重新运行 --list', { candidates });
    return { service, target: service.targets.find(target => `${service.port}:${target.targetId}` === options.target) };
  }
  const matches = services.filter(service => service.projects.some(project => project.title === options.project));
  if (!matches.length) throw new ConsoleError('PROJECT_NOT_FOUND', `没有找到项目：${options.project}`, { candidates });
  if (matches.length === 1 && matches[0].projects.length === 1 && matches[0].targets.length === 0) {
    throw new ConsoleError('DEBUGGER_NOT_OPEN', '当前项目的调试器未打开，请在 IDE 中打开调试器后重试', { candidates });
  }
  if (matches.length !== 1 || matches[0].projects.length !== 1 || matches[0].targets.length !== 1) {
    throw new ConsoleError('AMBIGUOUS_TARGET', '项目与调试器无法唯一对应，请用 --target 选择候选目标', { candidates });
  }
  return { service: matches[0], target: matches[0].targets[0] };
}

/** 在前端筛选快照，按需通过属性描述符展开对象，不执行业务 getter。 */
function snapshotConsole(options) {
  if (typeof SDK === 'undefined' || typeof SDK.consoleModel?.messages !== 'function') {
    throw new Error('调试器 SDK.consoleModel.messages 不可用');
  }
  const all = SDK.consoleModel.messages();
  if (!Array.isArray(all)) throw new Error('调试器日志模型未返回数组');
  const levels = {};
  for (const message of all) levels[message.level || 'unknown'] = (levels[message.level || 'unknown'] || 0) + 1;
  const matched = all.filter(message => (!options.levels.length || options.levels.includes(message.level)) &&
    String(message.messageText ?? '').includes(options.grep));
  const selected = matched.slice(-options.limit);
  const messages = selected.map(message => ({
    timestamp: Number.isFinite(message.timestamp) ? message.timestamp : null,
    level: message.level ?? null,
    text: String(message.messageText ?? ''),
    source: message.source ?? null,
    url: message.url || null,
    line: Number.isInteger(message.line) && message.line >= 0 ? message.line + 1 : null,
    column: Number.isInteger(message.column) && message.column >= 0 ? message.column + 1 : null,
    // 默认保留简短描述，只有显式展开时才追加参数值。
    parameters: Array.isArray(message.parameters) ? message.parameters.map(parameter => ({
      type: parameter?.type ?? null,
      description: typeof parameter?.description === 'string' ? parameter.description.slice(0, 300) : null,
    })) : [],
  }));
  const snapshot = { total: all.length, levels, matched: matched.length, returned: messages.length, messages };
  if (!options.expand) return snapshot;
  return (async () => {
    // 保留协议返回和解除附加的时间，避免对象多时后台继续递归读取。
    const deadline = Date.now() + Math.max(0, Math.min(4000, options.readBudgetMs ?? 4000));
    let remaining = 1000;

    /** 有界读取属性描述符，不使用 callFunction、JSON.stringify 或 getter 求值。 */
    async function expandValue(remote, depth, path, ancestors, issues) {
      /** 在参数内保留路径和原因，区分真实 null 与读取不完整。 */
      function missing(reason) {
        issues.push({ path, reason });
        return null;
      }
      if (!remote) return missing('object-unavailable');
      if (remote.subtype === 'null') return null;
      if (['string', 'boolean', 'number'].includes(remote.type)) {
        const value = remote.value;
        if (typeof value === remote.type && (remote.type !== 'number' || Number.isFinite(value))) return value;
        issues.push({ path, reason: 'non-json-value' });
        return remote.description ?? (typeof remote.unserializableValue === 'string' ? remote.unserializableValue : null);
      }
      if (remote.type === 'undefined') return missing('non-json-value');
      // Proxy、Map、Date 等对象不按普通 JSON 对象展开，避免结果看似完整。
      if (remote.type !== 'object' || (remote.subtype && remote.subtype !== 'array')) {
        issues.push({ path, reason: 'unsupported-type' });
        return remote.description?.slice(0, 300) ?? null;
      }
      if (depth <= 0) return missing('max-depth');
      if (remote.objectId && ancestors.has(remote.objectId)) return missing('circular-reference');
      if (remaining <= 0) return missing('property-budget');
      if (Date.now() >= deadline) return missing('timeout');
      if (typeof remote.getOwnProperties !== 'function') return missing('object-unavailable');

      let properties;
      let timer;
      try {
        const result = await Promise.race([
          remote.getOwnProperties(false),
          new Promise(resolve => { timer = setTimeout(() => resolve(null), Math.max(0, deadline - Date.now())); }),
        ]);
        if (!result) return missing('timeout');
        if (!Array.isArray(result.properties)) return missing('object-unavailable');
        properties = result.properties;
      } catch { return missing('object-unavailable'); }
      finally { clearTimeout(timer); }

      const isArray = remote.subtype === 'array';
      // 使用无原型对象保留名为 __proto__ 的普通响应字段。
      const value = isArray ? [] : Object.create(null);
      let fields = properties;
      let propertyLimitReached = false;
      if (isArray) {
        const length = properties.find(property => property.name === 'length')?.value?.value;
        if (!Number.isInteger(length) || length < 0) return missing('object-unavailable');
        value.length = Math.min(length, 100);
        propertyLimitReached = length > 100;
        fields = properties.filter(property => property.name !== 'length');
      }
      if (propertyLimitReached || fields.length > 100) {
        issues.push({ path, reason: 'property-limit' });
      }
      const nextAncestors = new Set(ancestors);
      if (remote.objectId) nextAncestors.add(remote.objectId);
      for (const property of fields.slice(0, 100)) {
        if (remaining <= 0) { issues.push({ path, reason: 'property-budget' }); break; }
        remaining--;
        const key = isArray ? Number(property.name) : property.name;
        if (property.symbol || (isArray && (!/^(0|[1-9]\d*)$/.test(property.name) || key >= value.length))) {
          issues.push({ path: [...path, property.name], reason: 'unsupported-property' });
          continue;
        }
        const childPath = [...path, key];
        if (property.getter || property.setter || property.wasThrown) {
          value[key] = null;
          issues.push({ path: childPath, reason: property.wasThrown ? 'property-threw' : 'accessor-skipped' });
        } else {
          value[key] = await expandValue(property.value, depth - 1, childPath, nextAncestors, issues);
        }
      }
      if (isArray) {
        for (let index = 0; index < value.length; index++) {
          if (!Object.hasOwn(value, index)) {
            value[index] = null;
            issues.push({ path: [...path, index], reason: remaining <= 0 ? 'property-budget' : 'array-hole' });
          }
        }
      }
      return value;
    }

    for (let index = 0; index < selected.length; index++) {
      const message = selected[index];
      for (let position = 0; position < (message.parameters?.length || 0); position++) {
        const raw = message.parameters[position];
        const output = messages[index].parameters[position];
        const issues = [];
        try {
          const remote = raw.objectId ? message.runtimeModel()?.createRemoteObject(raw) : raw;
          output.value = await expandValue(remote, options.depth ?? 3, [], new Set(), issues);
        } catch {
          output.value = null;
          issues.push({ path: [], reason: 'object-unavailable' });
        }
        if (issues.length) output.issues = issues;
      }
    }
    return snapshot;
  })();
}

/** 读取一次快照，任何结束路径都尝试释放自身附加的会话。 */
async function readLogs(client, targetId, options, { signal, deadlineAt }) {
  let sessionId;
  let result;
  let failure;
  try {
    // 附加命令等待确认，给整体超时后的清理保留获取会话 ID 的机会。
    const attached = await client.request('Target.attachToTarget', { targetId, flatten: false }, {
      timeoutMs: Math.max(1, Math.min(5000, deadlineAt - Date.now() - 1000)),
    });
    if (typeof attached.sessionId !== 'string' || !attached.sessionId) {
      throw new ConsoleError('INTERFACE_INCOMPATIBLE', 'IDE 未返回本次附加的会话 ID');
    }
    sessionId = attached.sessionId;
    if (signal.aborted) throw new ConsoleError('TIMEOUT', '读取日志超过总时间限制');
    const expression = `(${snapshotConsole.toString()})(${JSON.stringify({
      grep: options.grep, levels: options.levels, limit: options.limit,
      expand: options.expand, depth: options.depth,
      readBudgetMs: Math.max(0, Math.min(4000, deadlineAt - Date.now() - 1500)),
    })})`;
    result = await client.evaluate(sessionId, expression, { signal });
    if (!Number.isInteger(result.total) || !Number.isInteger(result.matched) || !Number.isInteger(result.returned) || !Array.isArray(result.messages)) {
      throw new ConsoleError('INTERFACE_INCOMPATIBLE', '调试器返回的日志快照格式不兼容');
    }
  } catch (error) { failure = error; }
  finally {
    if (sessionId) {
      try {
        await client.request('Target.detachFromTarget', { sessionId }, { timeoutMs: Math.max(1, Math.min(1000, deadlineAt - Date.now())) });
      } catch {
        // 清理无法确认时必须报告，不能把拿到日志误报为完全成功。
        if (failure) failure.details = { ...failure.details, cleanupFailed: true };
        else failure = new ConsoleError('CLEANUP_FAILED', '日志已读取，但无法确认本次附加会话已释放');
      }
    } else if (failure) {
      failure.details = { ...failure.details, cleanupFailed: true };
    }
    client.close();
  }
  if (failure) throw failure;
  return result;
}

/** 执行发现、选择和读取，预留最后一秒清理自身连接。 */
async function run(options) {
  if (process.platform !== 'darwin') throw new ConsoleError('UNSUPPORTED_PLATFORM', '当前版本仅支持 macOS 淘宝开发者工具');
  if (Number(process.versions.node.split('.')[0]) < 22 || typeof WebSocket !== 'function') {
    throw new ConsoleError('UNSUPPORTED_RUNTIME', '需要带内置 WebSocket 的 Node.js 22 或更新版本');
  }
  const deadlineAt = Date.now() + 20000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 19000);
  const services = [];
  try {
    let ports = await discoverPorts(controller.signal);
    if (options.target) ports = ports.filter(port => port === Number(options.target.split(':')[0]));
    if (!ports.length) throw new ConsoleError('TARGET_NOT_FOUND', '指定端口不属于当前运行的淘宝 IDE 主进程');
    const probes = await Promise.allSettled(ports.map(port => probeService(port, controller.signal)));
    for (const probe of probes) if (probe.status === 'fulfilled') services.push(probe.value);
    if (!services.length) {
      if (probes.some(probe => probe.status === 'rejected' && probe.reason.code === 'TIMEOUT')) {
        throw new ConsoleError('TIMEOUT', 'IDE 调试代理探测超时');
      }
      throw new ConsoleError('INTERFACE_INCOMPATIBLE', 'IDE 未提供可用的调试代理接口');
    }
    if (options.list) return { ok: true, readAt: new Date().toISOString(), services: summarizeServices(services) };
    const { service, target } = selectTarget(services, options);
    for (const other of services) if (other !== service) other.client.close();
    const snapshot = await readLogs(service.client, target.targetId, options, { signal: controller.signal, deadlineAt });
    return {
      ok: true,
      project: service.projects.length === 1 ? service.projects[0].title : null,
      projectCandidates: service.projects.map(project => project.title),
      target: `${service.port}:${target.targetId}`,
      readAt: new Date().toISOString(),
      ...snapshot,
    };
  } finally {
    clearTimeout(timer);
    for (const service of services) service.client.close();
  }
}

/** 标准输出始终只有一个 JSON 文档，错误不包含原始日志。 */
async function main() {
  try { console.log(JSON.stringify(await run(parseArgs(process.argv.slice(2))))); }
  catch (error) {
    console.log(JSON.stringify({ ok: false, error: {
      code: error.code || 'READ_FAILED',
      message: error instanceof ConsoleError ? error.message : '读取调试日志失败',
      ...(error.details ? { details: error.details } : {}),
    } }));
    process.exitCode = error.exitCode || 1;
  }
}

module.exports = { ConsoleError, CdpClient, parseArgs, parseListeners, parseMainPids, summarizeServices, selectTarget, snapshotConsole, probeService, readLogs };
if (require.main === module) main();
