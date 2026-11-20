# 淘宝 IDE 调试器日志插件

为 Codex 提供淘宝开发者工具 Console 日志读取能力，支持关键词、日志级别筛选，以及响应对象和数组的嵌套展开。动态发现本机 IDE 端口，无需启动额外服务或安装运行时依赖。

## 运行条件

- macOS、Node.js 22 或更新版本、系统自带 `lsof`。
- 淘宝开发者工具正在运行，已打开目标小程序及调试器。
- 通过本机执行的 Codex 使用；云端执行环境无法访问你电脑上的 IDE。
- 已验证的 IDE 基线为淘宝开发者工具 3.0.6 / Electron 22；其他版本的内部接口可能不同。

## 本地安装

在仓库根目录执行：

```bash
codex plugin marketplace add .
codex plugin add taobao-ide-console@taobao-tools
```

在新聊天中调用：

```text
$taobao-ide-console:taobao-ide-console
读取当前项目的错误日志，并展开相关请求的响应对象
```

如果此前安装过独立的同名 skill，插件验证成功后可自行移除旧副本，避免出现两份入口。

## 从 GitHub 安装

从 [GitHub 仓库](https://github.com/feilwang/codex-taobao-ide-console) 添加插件源并安装：

```bash
codex plugin marketplace add feilwang/codex-taobao-ide-console
codex plugin add taobao-ide-console@taobao-tools
```

marketplace 名为 `taobao-tools`，插件名为 `taobao-ide-console`。manifest 采用根目录 `plugin.json`，技能位于插件的 `skills/` 目录。GitHub 分发与官方公共插件目录审核相互独立。

## 直接运行脚本

将 `PLUGIN_REPO` 设置为本仓库的绝对路径，在要调试的小程序项目目录下执行。默认按当前目录名精确匹配 IDE 项目标题，也可以用 `--project` 指定。

```bash
PLUGIN_REPO="$HOME/Work/workspaces/codex-taobao-ide-console"
node "$PLUGIN_REPO/plugins/taobao-ide-console/skills/taobao-ide-console/scripts/read-console.cjs" --project demo-miniapp --level error,warning
node "$PLUGIN_REPO/plugins/taobao-ide-console/skills/taobao-ide-console/scripts/read-console.cjs" --project demo-miniapp --grep /api/items/query --limit 1 --expand
node "$PLUGIN_REPO/plugins/taobao-ide-console/skills/taobao-ide-console/scripts/read-console.cjs" --project demo-miniapp --grep /api/items/query --limit 1 --depth 5
node "$PLUGIN_REPO/plugins/taobao-ide-console/skills/taobao-ide-console/scripts/read-console.cjs" --list
```

- `--grep` 为区分大小写的普通子串匹配，`--level` 接受 `verbose,info,warning,error`。
- `--limit` 默认 100，范围 1～1000；筛选后取最新消息，保留控制台顺序。
- `--expand` 默认展开三层；`--depth` 支持 1～6 层，隐含启用展开。
- 多窗口存在歧义时使用 `--list`，明确目标后传 `--target "<port>:<targetId>"`。

输出为单个 JSON 文档，包含日志总数、级别统计和消息列表。展开值位于 `messages[].parameters[].value`；不能完整读取时附带 `issues`，其中 `path` 指明字段路径，`reason` 指明原因。正常读取和零命中退出 0，读取失败退出 1，参数错误退出 2。

## 数据边界

日志和对象来自当前 IDE 调试环境。对象展开读取当前值，可能与输出日志当时不同。关闭窗口、重新编译或清空控制台后，历史消息及对象引用可能失效。

读取自有数据属性，跳过 getter/setter 和业务对象方法；每对象最多输出 100 个属性、数组前 100 项、一次遍历最多 1000 个属性，属性读取预算最多 4 秒。截断、循环引用、特殊类型和引用失效通过 `issues` 提示。完整参数说明见 [SKILL.md](plugins/taobao-ide-console/skills/taobao-ide-console/SKILL.md)。

仅读取日志并释放自身调试会话。脚本不主动调用业务接口，不清空控制台，不修改断点。默认不保存日志，但输出可能包含接口数据、凭证和个人信息；分享前请脱敏。日志会作为本地执行工具的结果提供给所用 Codex 会话，不代表数据永不离开设备。

## 开发验证

```bash
npm test
```

测试使用 Node.js 内置测试工具和模拟协议，无需安装依赖，也不要求真实 IDE。测试包含插件目录和清单引用验证、日志筛选、对象展开、访问器跳过、超时及会话释放。

参考：[插件打包与 marketplace](https://developers.openai.com/plugins/build/plugins)、[仅本地执行插件](https://developers.openai.com/plugins/deploy/desktop-only)。

## 许可证

[MIT](LICENSE)。这是社区工具，与淘宝或 OpenAI 无官方隶属关系。
