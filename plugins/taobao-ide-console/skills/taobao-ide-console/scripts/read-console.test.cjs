'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const {
  CdpClient, parseArgs, parseListeners, parseMainPids,
  selectTarget, summarizeServices, snapshotConsole, probeService, readLogs,
} = require('./read-console.cjs');

/** 用可控消息顺序模拟 WebSocket，不连接真实 IDE。 */
class FakeSocket extends EventTarget {
  constructor(handler = () => {}) {
    super();
    this.handler = handler;
    this.sent = [];
    this.closed = false;
  }
  /** 记录命令，并让用例决定响应顺序。 */
  send(data) {
    const message = JSON.parse(data);
    this.sent.push(message);
    this.handler(message, this);
  }
  /** 在微任务中投递消息，覆盖快速响应的竞争条件。 */
  emit(message) {
    queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(message) })));
  }
  /** 模拟连接中断和主动关闭。 */
  close() {
    if (this.closed) return;
    this.closed = true;
    this.dispatchEvent(new Event('close'));
  }
}

/** 构造可以区分项目、端口和前端目标的发现结果。 */
function service(port, titles = ['demo'], ids = ['frontend']) {
  return {
    port,
    projects: titles.map((title, index) => ({ title, targetId: `page-${index}` })),
    targets: ids.map(targetId => ({ targetId, url: 'file:///mini-devtools-frontend/index.html?token=secret' })),
  };
}

/** 在隔离上下文执行实际快照函数，确保不存在脚本闭包依赖。 */
function snapshot(messages, options = {}, withSdk = true) {
  const context = withSdk ? { SDK: { consoleModel: { messages: () => messages } } } : {};
  return JSON.parse(JSON.stringify(vm.runInNewContext(
    `(${snapshotConsole.toString()})(${JSON.stringify({ levels: [], grep: '', limit: 100, ...options })})`, context,
  )));
}

test('参数默认值、过滤和显式目标优先配置', () => {
  assert.deepEqual(parseArgs([], '/work/demo'), { project: 'demo', grep: '', levels: [], limit: 100, list: false, expand: false, depth: 3 });
  const options = parseArgs(['--level', 'warning,error', '--grep', 'a.*', '--limit', '2', '--target', '50123:ABC']);
  assert.deepEqual(options.levels, ['warning', 'error']);
  assert.equal(options.grep, 'a.*');
  assert.equal(options.target, '50123:ABC');
  assert.equal(parseArgs(['--expand']).expand, true);
  assert.equal(parseArgs(['--depth', '4']).expand, true);
  assert.equal(parseArgs(['--depth', '4']).depth, 4);
});

test('无效参数稳定退出 2，并保持标准输出为 JSON', () => {
  for (const args of [['--limit', '0'], ['--limit', '1001'], ['--limit', '1.5'], ['--level', 'debug'],
    ['--target', 'http://remote'], ['--target', '0:ABC'], ['--target', '65536:ABC'], ['--project', ''],
    ['--list', '--target', '123:ABC'], ['--unknown'], ['--grep'], ['--depth'],
    ['--depth', '0'], ['--depth', '7'], ['--depth', '1.5']]) {
    assert.throws(() => parseArgs(args), error => error.exitCode === 2);
  }
  const result = spawnSync(process.execPath, [require.resolve('./read-console.cjs'), '--limit', '0'], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.equal(JSON.parse(result.stdout).error.code, 'INVALID_ARGUMENT');
  assert.equal(result.stderr, '');
});

test('动态端口解析去重，排除 Helper 和其他应用', () => {
  for (const port of [51478, 61234]) {
    const listeners = parseListeners(`p10\nf1\nn*:${port}\nf2\nn[::1]:${port}\np20\nn127.0.0.1:3000\n`);
    assert.deepEqual([...listeners.get('10')], [port]);
  }
  const pids = parseMainPids('p10\nn/Applications/淘宝开发者工具.app/Contents/MacOS/淘宝开发者工具\np20\nn/Applications/淘宝开发者工具.app/Contents/Frameworks/淘宝开发者工具 Helper.app/Contents/MacOS/淘宝开发者工具 Helper\np30\nn/Applications/Other.app/Contents/MacOS/Other\n');
  assert.deepEqual([...pids], ['10']);
});

test('项目精确匹配、重复窗口和显式目标', () => {
  const first = service(51000);
  assert.equal(selectTarget([first, service(52000, ['other'])], { project: 'demo' }).service, first);
  for (const services of [[first, service(52000)], [service(51000, ['demo', 'demo'])], [service(51000, ['demo'], ['a', 'b'])]]) {
    assert.throws(() => selectTarget(services, { project: 'demo' }), { code: 'AMBIGUOUS_TARGET' });
  }
  const ambiguous = service(51000, ['demo', 'other'], ['a', 'b']);
  assert.equal(selectTarget([ambiguous], { project: 'unrelated', target: '51000:b' }).target.targetId, 'b');
  assert.throws(() => selectTarget([first], { project: 'Demo' }), { code: 'PROJECT_NOT_FOUND' });
  assert.throws(() => selectTarget([service(51000, ['demo'], [])], { project: 'demo' }), { code: 'DEBUGGER_NOT_OPEN' });
  assert.throws(() => selectTarget([first], { target: '51000:stale' }), { code: 'TARGET_NOT_FOUND' });
  assert.ok(!JSON.stringify(summarizeServices([first])).includes('secret'));
});

test('筛选采用普通子串，取最新记录并保留原始顺序与统计', () => {
  const messages = [
    { level: 'info', messageText: 'API a.*', timestamp: 5, line: 0, column: 4 },
    { level: 'error', messageText: 'API abc', timestamp: 4 },
    { level: 'warning', messageText: 'API a.*', timestamp: 3 },
    { level: 'error', messageText: 'API a.*', timestamp: 2 },
  ];
  const result = snapshot(messages, { grep: 'a.*', limit: 2 });
  assert.equal(result.total, 4);
  assert.deepEqual(result.levels, { info: 1, error: 2, warning: 1 });
  assert.equal(result.matched, 3);
  assert.equal(result.returned, 2);
  assert.deepEqual(result.messages.map(message => message.timestamp), [3, 2]);
  assert.equal(snapshot(messages, { grep: 'api' }).returned, 0);
  assert.equal(snapshot(messages, { levels: ['warning', 'error'] }).matched, 3);
  const first = snapshot(messages).messages[0];
  assert.equal(first.line, 1);
  assert.equal(first.column, 5);
  assert.equal(first.url, null);
  assert.equal(snapshot([]).returned, 0);
});

test('参数只读取已有描述，不展开 getter 或调用获取属性方法', () => {
  let expanded = false;
  const parameter = { type: 'object', description: 'x'.repeat(400), getProperties() { expanded = true; } };
  Object.defineProperty(parameter, 'value', { get() { expanded = true; throw new Error('不应读取'); } });
  const result = snapshot([{ parameters: [parameter], line: -1 }]);
  assert.equal(result.messages[0].parameters[0].description.length, 300);
  assert.equal(result.messages[0].line, null);
  assert.equal(expanded, false);
  assert.throws(() => snapshot([], {}, false), /SDK.consoleModel.messages/);
});

test('代理返回空错误对象或缺少结果时失败', async () => {
  for (const response of [{ error: {} }, {}]) {
    const socket = new FakeSocket((message, connection) => connection.emit({ id: message.id, ...response }));
    const client = new CdpClient(socket);
    await assert.rejects(client.request('Browser.getVersion'), { code: 'PROTOCOL_ERROR' });
    assert.equal(client.waiters.size, 0);
    client.close();
  }
});

test('请求超时、取消和连接中断均移除等待器', async () => {
  const client = new CdpClient(new FakeSocket());
  await assert.rejects(client.request('NoReply', {}, { timeoutMs: 10 }), { code: 'TIMEOUT' });
  const controller = new AbortController();
  const pending = client.request('Cancel', {}, { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { code: 'TIMEOUT' });
  const disconnected = client.request('Disconnect');
  client.socket.close();
  await assert.rejects(disconnected, { code: 'CONNECTION_CLOSED' });
  assert.equal(client.waiters.size, 0);
});

test('握手超时会关闭连接', async () => {
  let socket;
  /** 该连接始终不发送 open，验证握手超时路径。 */
  class NeverOpenSocket extends FakeSocket {
    constructor() { super(); socket = this; }
  }
  await assert.rejects(CdpClient.connect(12345, { WebSocketImpl: NeverOpenSocket, timeoutMs: 10 }), { code: 'TIMEOUT' });
  assert.equal(socket.closed, true);
});

test('已取消的命令不再发送到 IDE', async () => {
  const client = new CdpClient(new FakeSocket());
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(client.request('Runtime.evaluate', {}, { signal: controller.signal }), { code: 'TIMEOUT' });
  assert.equal(client.socket.sent.length, 0);
  client.close();
});

test('探测动态端口并验证淘宝身份，拒绝其他服务和不兼容目标结果', async () => {
  const original = globalThis.WebSocket;
  try {
    for (const mode of ['success', 'other-app', 'bad-targets']) {
      const sockets = [];
      /** 用假握手验证真实探测流程，不访问外部端口。 */
      class ProbeSocket extends FakeSocket {
        constructor(url) {
          super((message, connection) => {
            const result = message.method === 'Browser.getVersion'
              ? { userAgent: mode === 'other-app' ? 'OtherApp' : 'taobao-dev-tool/3.0.6' }
              : mode === 'bad-targets' ? {} : { targetInfos: [
                { type: 'page', title: 'demo', targetId: 'project', url: 'file:///editor/browser/index.html' },
                { type: 'webview', targetId: 'frontend', url: 'file:///mini-devtools-frontend/index.html' },
                { type: 'webview', targetId: 'simulator', url: 'file:///lyra/index.html' },
              ] };
            connection.emit({ id: message.id, result });
          });
          this.url = url;
          sockets.push(this);
          queueMicrotask(() => this.dispatchEvent(new Event('open')));
        }
      }
      globalThis.WebSocket = ProbeSocket;
      for (const port of [51478, 61234]) {
        if (mode === 'success') {
          const result = await probeService(port, new AbortController().signal);
          assert.equal(result.port, port);
          assert.deepEqual(result.targets.map(target => target.targetId), ['frontend']);
          assert.equal(sockets.at(-1).url, `ws://127.0.0.1:${port}`);
          result.client.close();
        } else {
          await assert.rejects(probeService(port, new AbortController().signal), { code: 'INTERFACE_INCOMPATIBLE' });
          assert.equal(sockets.at(-1).closed, true);
        }
      }
    }
  } finally { globalThis.WebSocket = original; }
});

/** 模拟真实的嵌套调试协议，并让事件先于转发命令确认到达。 */
function debuggerClient(mode = 'success') {
  const socket = new FakeSocket(async (message, connection) => {
    if (message.method === 'Target.attachToTarget') return connection.emit({ id: message.id, result: { sessionId: 'own-session' } });
    if (message.method === 'Target.detachFromTarget') {
      return connection.emit({ id: message.id, ...(mode === 'detach-fail' ? { error: {} } : { result: {} }) });
    }
    if (message.method === 'Target.sendMessageToTarget') {
      const inner = JSON.parse(message.params.message);
      if (mode === 'disconnect') return connection.close();
      if (mode !== 'timeout') {
        let result;
        try {
          const context = mode === 'missing-model' ? {} : {
            SDK: { consoleModel: { messages: () => [{
              messageText: 'hello', level: 'info',
              parameters: mode === 'objects' ? [remoteObject({ total: 52, list: [{ title: '商品' }] })] : [],
              runtimeModel: () => ({ createRemoteObject: parameter => parameter }),
            }] } }, setTimeout, clearTimeout,
          };
          result = { result: { value: await vm.runInNewContext(inner.params.expression, context) } };
        } catch { result = { exceptionDetails: { text: '模型不可用' } }; }
        connection.emit({ method: 'Target.receivedMessageFromTarget', params: {
          sessionId: 'other-session', message: JSON.stringify({ id: inner.id, result: { result: { value: '其他会话' } } }),
        } });
        connection.emit({ method: 'Target.receivedMessageFromTarget', params: {
          sessionId: message.params.sessionId, message: JSON.stringify({ id: inner.id, result }),
        } });
      }
      connection.emit({ id: message.id, result: {} });
    }
  });
  return new CdpClient(socket);
}

test('真实协议顺序：成功读取后只释放自身会话，ID 不重复', async () => {
  const client = debuggerClient();
  const result = await readLogs(client, 'frontend', parseArgs([]), { signal: new AbortController().signal, deadlineAt: Date.now() + 1000 });
  assert.equal(result.total, 1);
  const sent = client.socket.sent;
  assert.deepEqual(sent.filter(message => message.method === 'Target.detachFromTarget').map(message => message.params.sessionId), ['own-session']);
  const ids = sent.map(message => message.id).concat(sent.filter(message => message.method === 'Target.sendMessageToTarget').map(message => JSON.parse(message.params.message).id));
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(client.waiters.size, 0);
  assert.equal(client.socket.closed, true);
});

test('模型缺失和整体取消后仍释放自身附加会话', async () => {
  for (const mode of ['missing-model', 'timeout']) {
    const client = debuggerClient(mode);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15);
    try {
      await assert.rejects(readLogs(client, 'frontend', parseArgs([]), {
        signal: controller.signal, deadlineAt: Date.now() + 2000,
      }), { code: mode === 'timeout' ? 'TIMEOUT' : 'INTERFACE_INCOMPATIBLE' });
      assert.equal(client.socket.sent.at(-1).method, 'Target.detachFromTarget');
      assert.equal(client.socket.sent.at(-1).params.sessionId, 'own-session');
      assert.equal(client.waiters.size, 0);
      assert.equal(client.socket.closed, true);
    } finally { clearTimeout(timer); }
  }
});

test('断线和解除附加失败不会被误报为成功', async () => {
  for (const mode of ['disconnect', 'detach-fail']) {
    const client = debuggerClient(mode);
    await assert.rejects(readLogs(client, 'frontend', parseArgs([]), {
      signal: new AbortController().signal, deadlineAt: Date.now() + 2000,
    }), error => mode === 'disconnect' ? error.details.cleanupFailed === true : error.code === 'CLEANUP_FAILED');
    assert.equal(client.socket.closed, true);
  }
});

/** 根据自有属性描述符模拟 SDK RemoteObject，不执行原对象 getter。 */
function remoteObject(value, seen = new Map()) {
  if (value === null) return { type: 'object', subtype: 'null', value: null };
  if (typeof value !== 'object') return { type: typeof value, value, description: String(value) };
  if (seen.has(value)) return seen.get(value);
  const remote = {
    type: 'object', subtype: Array.isArray(value) ? 'array' : undefined,
    description: Array.isArray(value) ? `Array(${value.length})` : 'Object', objectId: String(seen.size + 1),
    /** 模拟真实 SDK 的异步描述符读取。 */
    async getOwnProperties() {
      const descriptors = Object.getOwnPropertyDescriptors(value);
      return { properties: Reflect.ownKeys(descriptors).map(name => {
        const descriptor = descriptors[name];
        return {
          name: String(name), symbol: typeof name === 'symbol' ? {} : undefined,
          getter: descriptor.get ? {} : undefined, setter: descriptor.set ? {} : undefined,
          value: 'value' in descriptor ? remoteObject(descriptor.value, seen) : undefined,
        };
      }) };
    },
  };
  seen.set(value, remote);
  return remote;
}

/** 在独立前端环境执行实际展开函数，模拟控制台参数和 SDK 包装。 */
async function expanded(parameters, options = {}) {
  const context = { setTimeout, clearTimeout, SDK: { consoleModel: { messages: () => [{
    messageText: 'Response', parameters,
    runtimeModel: () => ({ createRemoteObject: parameter => parameter }),
  }] } } };
  const result = await vm.runInNewContext(
    `(${snapshotConsole.toString()})(${JSON.stringify({ levels: [], grep: '', limit: 1, expand: true, depth: 3, ...options })})`, context,
  );
  return JSON.parse(JSON.stringify(result)).messages[0].parameters;
}

test('对象展开保留真实标量、数组和列表项字段，深度可以调整', async () => {
  const response = { total: 52, empty: {}, nil: null, list: [{ title: '商品', price: 12.5, details: { enabled: true } }] };
  const [result, text] = await expanded([remoteObject(response), remoteObject('hello')]);
  assert.equal(result.value.total, 52);
  assert.equal(result.value.list[0].title, '商品');
  assert.equal(result.value.list[0].price, 12.5);
  assert.deepEqual(result.value.empty, {});
  assert.equal(result.value.nil, null);
  assert.equal(text.value, 'hello');
  assert.equal(result.value.list[0].details, null);
  assert.deepEqual(result.issues, [{ path: ['list', 0, 'details'], reason: 'max-depth' }]);
  const [deeper] = await expanded([remoteObject(response)], { depth: 4 });
  assert.equal(deeper.value.list[0].details.enabled, true);
  assert.equal(deeper.issues, undefined);
});

test('跳过 getter、setter 和业务方法，并保留 __proto__ 响应字段', async () => {
  let calls = 0;
  const value = { toJSON() { calls++; throw new Error('不应调用'); } };
  Object.defineProperty(value, 'getter', { enumerable: true, get() { calls++; throw new Error('不应调用'); } });
  Object.defineProperty(value, 'setter', { enumerable: true, set(_) { calls++; } });
  Object.defineProperty(value, '__proto__', { enumerable: true, value: { polluted: true } });
  const [result] = await expanded([remoteObject(value)]);
  assert.equal(calls, 0);
  assert.equal(result.value.getter, null);
  assert.equal(result.value.setter, null);
  assert.ok(result.issues.some(issue => issue.reason === 'accessor-skipped' && issue.path[0] === 'getter'));
  assert.ok(result.issues.some(issue => issue.reason === 'unsupported-type' && issue.path[0] === 'toJSON'));
  assert.equal(Object.hasOwn(result.value, '__proto__'), true);
  assert.equal(result.value.__proto__.polluted, true);
  assert.equal({}.polluted, undefined);
});

test('循环引用不无限递归，普通共享引用仍可读取', async () => {
  const shared = { count: 1 };
  const value = { first: shared, second: shared };
  value.self = value;
  const [result] = await expanded([remoteObject(value)]);
  assert.deepEqual(result.value.first, { count: 1 });
  assert.deepEqual(result.value.second, { count: 1 });
  assert.equal(result.value.self, null);
  assert.deepEqual(result.issues, [{ path: ['self'], reason: 'circular-reference' }]);
});

test('单对象和数组的输出上限为 100，并记录截断', async () => {
  const value = Object.fromEntries(Array.from({ length: 105 }, (_, index) => [`field${index}`, index]));
  const [object, array] = await expanded([remoteObject(value), remoteObject(Array.from({ length: 105 }, (_, index) => index))]);
  assert.equal(Object.keys(object.value).length, 100);
  assert.ok(object.issues.some(issue => issue.reason === 'property-limit'));
  assert.equal(array.value.length, 100);
  assert.equal(array.value[99], 99);
  assert.ok(array.issues.some(issue => issue.reason === 'property-limit'));
});

test('所有参数共享 1000 个属性的总预算', async () => {
  const value = Object.fromEntries(Array.from({ length: 20 }, (_, index) => [
    `object${index}`, Object.fromEntries(Array.from({ length: 100 }, (_, field) => [`field${field}`, field])),
  ]));
  const [first, second] = await expanded([remoteObject(value), remoteObject({ later: true })]);
  assert.ok(first.issues.some(issue => issue.reason === 'property-budget'));
  assert.equal(second.value, null);
  assert.equal(second.issues[0].reason, 'property-budget');
  const count = Object.keys(first.value).length + Object.values(first.value).reduce((sum, item) => sum + Object.keys(item).length, 0);
  assert.equal(count, 1000);
});

test('引用失效时保留日志并标记对象不可读取', async () => {
  for (const getOwnProperties of [async () => { throw new Error('引用已失效'); }, async () => ({ properties: null })]) {
    const [result] = await expanded([{ type: 'object', objectId: 'expired', getOwnProperties }]);
    assert.equal(result.value, null);
    assert.deepEqual(result.issues, [{ path: [], reason: 'object-unavailable' }]);
  }
});

test('稀疏数组、自定义数组属性和非 JSON 类型不静默丢失', async () => {
  const sparse = new Array(3);
  sparse[1] = 'middle';
  sparse.extra = true;
  const special = remoteObject({ missing: undefined, number: NaN, big: 10n, [Symbol('name')]: 'symbol' });
  const [array, object, proxy] = await expanded([remoteObject(sparse), special, {
    type: 'object', subtype: 'proxy', objectId: 'proxy', description: 'Proxy',
    getOwnProperties() { throw new Error('不应读取 Proxy'); },
  }]);
  assert.deepEqual(array.value, [null, 'middle', null]);
  assert.ok(array.issues.some(issue => issue.reason === 'array-hole'));
  assert.ok(array.issues.some(issue => issue.reason === 'unsupported-property' && issue.path[0] === 'extra'));
  assert.equal(object.value.missing, null);
  assert.equal(object.value.number, 'NaN');
  assert.equal(object.value.big, '10');
  assert.ok(object.issues.some(issue => issue.reason === 'unsupported-property'));
  assert.equal(proxy.issues[0].reason, 'unsupported-type');
});

test('对象读取超时后停止后续对象请求，不阻塞整个日志结果', async () => {
  let requests = 0;
  const delayed = { type: 'object', objectId: 'delayed', getOwnProperties() { requests++; return new Promise(() => {}); } };
  const [first, second] = await expanded([delayed, delayed], { readBudgetMs: 10 });
  assert.equal(first.issues[0].reason, 'timeout');
  assert.equal(second.issues[0].reason, 'timeout');
  assert.equal(requests, 1);
});

test('展开模式端到端等待异步属性结果并释放会话', async () => {
  const client = debuggerClient('objects');
  const result = await readLogs(client, 'frontend', parseArgs(['--expand']), {
    signal: new AbortController().signal, deadlineAt: Date.now() + 6000,
  });
  assert.equal(result.messages[0].parameters[0].value.total, 52);
  assert.equal(result.messages[0].parameters[0].value.list[0].title, '商品');
  const forwarded = client.socket.sent.find(message => message.method === 'Target.sendMessageToTarget');
  assert.equal(JSON.parse(forwarded.params.message).params.awaitPromise, true);
  assert.equal(client.socket.sent.at(-1).method, 'Target.detachFromTarget');
  assert.equal(client.socket.closed, true);
});
