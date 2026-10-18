# Windows Node 与 API Key

插件的 `launch.js` 先读取本机非秘密配置。如果 `nodePath` 指定的 Node 不同于 PATH 版本，它会用该可执行文件重新启动自身。无需更改系统 PATH 或下载第二套 Node。请将本机现有 Node 24.21 的绝对路径写入 `%LOCALAPPDATA%\DeepSeekHarnessBridge\config.json`：

```json
{"nodePath": "C:\\path\\to\\node.exe"}
```

默认 MCP 使用 `node launch.js`；`index.js` 是底层入口，直接调用它会跳过 Node 选择和加密凭据加载。更新插件后非秘密配置仍在独立目录中。

在用户自己的 PowerShell 窗口运行包内 `scripts/set-api-key.ps1`。脚本通过 `Read-Host -AsSecureString` 隐藏输入，以 Windows DPAPI 加密保存 `api-key.dpapi`，并将目录 ACL 限制为当前用户。不要把 Key 粘贴到聊天、工具参数、命令行字面量、仓库、`.mcp.json` 或 `config.json`。

设置脚本和启动器都优先使用 `DSH_BRIDGE_CONFIG_DIR`；显式的 `-Directory` 参数可覆盖设置脚本的目录。启动器转发可捕获的 SIGINT/SIGTERM 并等待子进程退出；Windows 强制终止等无法被 JavaScript 捕获的情况仍须依据所有权锁核实恢复，不能保证自动清理。

```powershell
powershell.exe -NoProfile -File "C:\实际插件目录\scripts\set-api-key.ps1"
```

启动时，凭据通过无窗口 PowerShell 子进程解密到桥接进程内存，再以 `DEEPSEEK_API_KEY` 传给受限工作者。密钥不作为进程参数，不打印到诊断输出，也不读取 `.dsh/.credentials.yaml`。已存在的 `DEEPSEEK_API_KEY` 环境变量优先，适合已有秘密管理器的环境。DPAPI 保护磁盘上的凭据；同一 Windows 账户下能够运行代码的进程仍可能解密它，不是进程间安全隔离。

在实际安装目录用 `node launch.js --doctor` 核对 Node 版本、依赖和 `credentialConfigured`。诊断不发模型请求，`true` 只表示有凭据，不代表服务端接受。

轮换 Key 时，重新运行同一脚本并重新连接 MCP。撤销时先在 DeepSeek 平台撤销 Key，再删除本机加密文件；不要在 Key 撤销前把旧文件当作安全备份分享。

## 一次真实连接测试

明确授权后，只提交一次：`capabilityProfile: inference-only`、`access: read-only`、`maxModelRequests: 1`、`maxTokens: 512`、`maxRequestBytes: 8192`、`maxToolCalls: 0`、`timeoutMs: 60000`、`effort: high`。prompt 只要求返回固定标记，不包含项目资料。失败或截断如实记录，不自动重试。

请求次数和序列化输入字节数在 provider adapter 前检查，输出上限发送给官方 API；只有初始化及能力检查完成后才解锁调用。每次 attempt 返回 `budget`：请求数、输入字节和逐调用 provider usage；未报告 usage 时保留 `null`，不能当作零费用。`maxTokens` 包含服务提供方在该上限内计量的输出；本插件不将字节数等同于精确输入 token，也不承诺人民币/美元硬扣费上限。最终账单以提供方为准。
