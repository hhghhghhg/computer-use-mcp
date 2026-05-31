# Sky Computer Use MCP 使用说明

这个目录是 Codex 本地的 Computer Use 插件缓存目录。

我在下面这个版本目录的 `scripts` 里加入了一套自定义 MCP 兼容层：

```text
C:\Users\admin\.codex\plugins\cache\openai-curated\computer-use\26.527.31326\scripts
```

新增的自定义文件是：

```text
sky-computer-use-mcp.mjs
sky-computer-use-bridge.mjs
verify-sky-mcp.mjs
```

原本就存在的官方脚本是：

```text
computer-use-client.mjs
```

## 这套东西是干什么的

`sky-computer-use-mcp.mjs` 会把本机 Codex Computer Use / Sky 运行时包装成一个 stdio MCP server。

只要其他 Agent 工具支持 MCP stdio，就可以连接这个 server，然后获得桌面控制相关工具。

当前会暴露这些工具：

```text
list_apps
list_windows
launch_app
get_window
activate_window
get_window_state
click
press_key
type_text
scroll
drag
set_value
perform_secondary_action
```

`sky-computer-use-mcp.mjs` 负责 MCP 协议。

`sky-computer-use-bridge.mjs` 负责启动并连接本地 Computer Use helper：

```text
node_modules\@oai\sky\bin\windows\codex-computer-use.exe
```

这几个脚本现在使用相对路径推导插件根目录，所以它们可以稳定放在：

```text
26.527.31326\scripts
```

不再依赖临时 Codex 会话目录。

## 运行要求

需要满足这些条件：

- Windows 系统。
- 已安装 Node.js。

## 快速验证

在 当前项目控制台 里运行：

```
node "scripts\verify-sky-mcp.mjs"
```

成功时会看到类似输出：

```json
{
  "ok": true,
  "toolCount": 13,
  "firstTool": "list_apps",
  "appCount": 40
}
```

其中 `appCount` 不同机器可能不一样，这是正常的。

## Codex 里的 MCP 配置

Codex 配置文件位置：

```text
C:\Users\admin\.codex\config.toml
```
以下的args替换成当前项目sky-computer-use-mcp.mjs在你电脑的路径
推荐配置：

```toml
[mcp_servers.sky_computer_use]
enabled = true
command = 'node'
args = ['C:\Users\admin\.codex\plugins\cache\openai-curated\computer-use\26.527.31326\scripts\sky-computer-use-mcp.mjs']
```

## 其他 Agent 工具的 JSON 配置

如果其他 Agent 工具使用 JSON 格式配置 MCP，一般可以这样写：

```json
{
  "mcpServers": {
    "sky_computer_use": {
      "command": "node",
      "args": [
        "C:\\Users\\admin\\.codex\\plugins\\cache\\openai-curated\\computer-use\\26.527.31326\\scripts\\sky-computer-use-mcp.mjs"
      ]
    }
  }
}
```

如果工具支持环境变量，可以加日志路径：

```json
{
  "mcpServers": {
    "sky_computer_use": {
      "command": "node",
      "args": [
        "C:\\Users\\admin\\.codex\\plugins\\cache\\openai-curated\\computer-use\\26.527.31326\\scripts\\sky-computer-use-mcp.mjs"
      ],
      "env": {
        "SKY_COMPUTER_USE_MCP_LOG": "C:\\Users\\admin\\.codex\\sky-computer-use-mcp.log"
      }
    }
  }
}
```

## 环境变量

`CODEX_COMPUTER_USE_PLUGIN_ROOT`

手动指定插件根目录。

示例：

```powershell
$env:CODEX_COMPUTER_USE_PLUGIN_ROOT = "C:\Users\admin\.codex\plugins\cache\openai-curated\computer-use\26.527.31326"
```

`SKY_COMPUTER_USE_MCP_LOG`

手动指定 MCP 日志路径。

示例：

```powershell
$env:SKY_COMPUTER_USE_MCP_LOG = "C:\Users\admin\.codex\sky-computer-use-mcp.log"
```

## 工作原理

MCP server 通过 stdio 收发 JSON-RPC 消息。

目前兼容两种常见 MCP stdio 消息格式：

```text
Content-Length framed messages
line-delimited JSON messages
```

启动流程大概是：

```text
Agent 工具启动 sky-computer-use-mcp.mjs
MCP client 发送 initialize
MCP client 发送 tools/list
MCP server 返回工具 schema
Agent 调用 tools/call
MCP server 懒加载 Sky bridge
Sky bridge 启动 codex-computer-use.exe
Sky bridge 通过 named pipe 连接 computer-use-client.mjs 和 helper
工具结果作为 MCP text content 返回
```

helper 是懒加载的。

也就是说，MCP 启动和 `tools/list` 阶段不会立刻启动桌面控制 helper，只有真正调用工具时才会启动。

这样可以减少启动失败和 502，也能避免只是构建工具列表时就触发桌面自动化。

## 关于浏览器应用

当前代码里对这些浏览器 app id 有识别逻辑：

```text
msedge
chrome
firefox
brave
opera
```

但是浏览器自动化可能仍然受到 Codex / Computer Use 的 URL policy 限制。

如果浏览器操作报类似下面的错误：

```text
Computer Use has been stopped for this turn because it could not determine the current browser URL on Windows with enough confidence to enforce policy.
```

说明宿主策略层拦截了浏览器操作。

这种情况下建议：

- 优先用非浏览器桌面应用测试。
- 浏览器场景单独使用 Playwright、browser MCP 或其他专用浏览器自动化工具。
- 不要把这个 MCP 当成稳定绕过浏览器 policy 的方案。


## 安全说明

这个 MCP server 会暴露桌面自动化能力。

拥有这个 MCP 权限的 Agent 可以尝试：

- 列出应用和窗口。
- 启动应用。
- 获取窗口状态。
- 点击、输入、滚动、拖拽。
- 操作可访问性 UI 元素。

所以只建议在你信任的 Agent 和会话里启用。

不要把它提供给不可信的远程 Agent。


## 本地新增文件清单

本地新增了这些兼容层文件：

```text
scripts\sky-computer-use-mcp.mjs
scripts\sky-computer-use-bridge.mjs
scripts\verify-sky-mcp.mjs
README.md
```

这些文件是本机自定义兼容层，不属于原始 Codex Computer Use 插件发行内容。
