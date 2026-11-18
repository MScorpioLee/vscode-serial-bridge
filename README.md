# Serial Bridge

在 Mac 的 VS Code 中，把本机串口或 CMSIS-DAP 探针分别连接到 Linux SSH 主机。

研发版本 **0.2.2** · [English](README.en.md) · [源代码](https://github.com/MScorpioLee/vscode-serial-bridge)

0.2.2 修复频繁收发时停止映射可能卡住的问题：拥塞时仍处理停止指令，停止时取消尚未发送的数据，并正确回收已退出的辅助进程。日志预览合并刷新并限制积压，避免大量日志影响按钮响应。

## 能做什么

- 最多管理 8 个独立通道，分别选择设备、SSH 主机和远端端点。
- 串口支持自定义波特率、数据位、停止位、校验和流控。
- 远端生成 Linux PTY，支持二进制双向收发、轮转日志和连接状态文件。
- 面板提供文本/HEX 发送、换行设置、实时日志和 RX/TX 计数。
- CMSIS-DAP 通过 pyOCD 远程探针协议和 SSH 反向通道接入。
- 各通道独立启动、停止和计数；阻止重复占用同一设备或远端端点。

目前验证范围是 **Mac 本机 + Linux SSH 主机**。尚未验证 Windows 或 WSL，不承诺这些环境可用。

## 安装

需要本机 VS Code 1.95 或更新版本、Python 3，以及能通过密钥免交互登录的 SSH 主机。
Linux 端需要 Python 3；串口辅助程序仅使用 Python 标准库。

### 1. 准备本机独立环境

```sh
python3 -m venv ~/.local/share/serialbridge/venv
~/.local/share/serialbridge/venv/bin/python3 -m pip install "pyserial==3.5" "pyocd==0.46.1"
```

依赖安装在独立环境中，不需要向系统 Python 安装包。
只使用串口时不需要启动 pyOCD 服务；使用探针时需要本机 USB 探针可被 pyOCD 识别。

### 2. 安装 VSIX

发布的安装包放在 [GitHub Releases](https://github.com/MScorpioLee/vscode-serial-bridge/releases)。
开发期间也可以按照下文从源码打包。
在 VS Code 扩展面板菜单中选择 **Install from VSIX…**，或运行：

```sh
code --install-extension ./serial-bridge-0.2.2.vsix
```

此说明使用 VSIX 安装流程，不代表扩展已经上架 Marketplace。
扩展运行在 **Mac 本机的 UI 扩展宿主**，即使当前打开的是 Remote SSH 工作区。
不要只把它安装到 Linux 远端；USB 设备和本机 Python 必须由 Mac 访问。

### 3. 检查 SSH 和设置

在本机 SSH 配置中准备一个主机别名，例如 `ssh-target`，然后确认：

```sh
ssh -o BatchMode=yes ssh-target python3 --version
```

面板会读取本机 SSH 主机别名，选择要连接的主机。
在本机 VS Code 用户设置中配置：

```json
{
  "serialBridge.pythonPath": "~/.local/share/serialbridge/venv/bin/python3",
  "serialBridge.remoteDirectory": "~/.local/share/serialbridge"
}
```

`pythonPath` 是 Mac 的解释器路径；`remoteDirectory` 是 Linux 主机上的运行目录。
后者默认 `~/.local/share/serialbridge`，用于保存串口链接、日志和状态文件；`~` 指远端登录用户的主目录。
连接后以面板返回的完整路径为准，不要求创建 `/dev` 下的系统级别名。

## 使用串口

1. 打开 Serial Bridge 面板，新增或选择一个通道，将类型设为“串口映射”。
2. 选择本机 USB 串口、SSH 主机和波特率；展开高级选项设置其余 UART 参数。
3. 设置虚拟串口名，例如 `ttyBoard`，点击“绑定并启动”。
4. 复制面板中的远端端口路径，交给 Linux 端需要读写串口的程序。
5. 通过面板发送文本或 HEX；也可打开远端日志查看设备输出。

同一个 PTY 应由一个消费程序读取；多个程序同时读取可能分走数据。
需要多个观察者时使用日志文件。消费程序应检查状态文件中的连接状态和心跳时间。
日志有大小限制并轮转；面板仅缓存每通道最近 200,000 个字符，不适合作为完整采集存档。
高负载时面板会略过积压的预览并显示提示；这不改变串口转发和远端日志记录。
点击停止后立即禁止新发送，尚未写入设备的排队数据会被取消。

## 使用 CMSIS-DAP

1. 新增通道，选择“CMSIS-DAP 探针”，再选择探针 UID 和 SSH 主机。
2. 设置远端回环端口，默认 `5555`；同一主机的多个探针需要不同端口。
3. 点击“建立探针通道”，复制端点，例如 `remote:127.0.0.1:5555`。
4. 在远端使用兼容的 pyOCD 客户端，配置目标芯片、工具链及调试/烧录流程。

这是 **CMSIS-DAP 调试探针 RPC**，不是 CDC UART，也不是整台 USB 设备透传。
同一块 DAPLink 设备上的 CDC 串口与调试探针是不同接口，需要分别建立对应类型的通道。

“通道已连接”只表示传输及探针身份核对完成。建立通道仅执行协议 hello、读取缓存身份等检查；
不会连接目标芯片、暂停/复位 MCU 或烧录。目标型号、支持包、Flash 算法及操作由下游工具配置。
本项目不把探针通道验证当作具体芯片烧录或调试已通过。

## 架构与连接行为

```text
Mac VS Code UI → 通道管理器
  ├─ pySerial → 本机 UART ↔ SSH ↔ Linux PTY / 日志 / 状态
  └─ pyOCD 探针服务 ↔ SSH 反向回环通道 ↔ 远端 pyOCD 客户端
```

- 本机串口辅助程序是物理串口的唯一所有者。
- 探针服务和 SSH 转发仅绑定回环地址，不开放公共监听端口。
- 应用层心跳超过 8 秒失联即结束通道；断线后不重放旧数据。
- 打开面板、重载扩展或恢复设置不会自动打开设备，也不会自动重连或发送。
- 通道停止或辅助进程退出后会清理其拥有的资源；界面显示停止中时等待清理完成。
- 保存的是通道设置，不是运行中的连接；各通道消息使用身份令牌避免旧界面消息误发到新设备。

## 常见问题

- **设备列表为空**：检查 USB 连接、本机 Python 路径和依赖，再点击刷新。串口与探针分开枚举。
- **设备被占用**：关闭持有同一串口或探针接口的其他程序，再手动启动通道。
- **SSH 失败**：先确认上面的免交互 SSH 命令可运行，并检查远端 Python 和目录写入权限。
- **探针端口冲突**：为该 SSH 主机选择其他回环端口，再重新启动。
- **探针已连接但芯片不可用**：检查下游工具的目标配置、支持包和硬件接线；通道本身不验证这些条件。

## 从源码构建

需要 Node.js/npm，以及安装了上述 Python 依赖的解释器。

```sh
git clone https://github.com/MScorpioLee/vscode-serial-bridge.git
cd vscode-serial-bridge
npm test
~/.local/share/serialbridge/venv/bin/python3 -m unittest discover -s tests -p 'test_*.py'
npm run package
```

测试覆盖协议、配置、隔离和模拟 PTY；它们不等同于真实目标芯片的烧录验证。
报告问题时请提供系统版本、扩展版本和经脱敏的错误信息，移除 USB UID、主机地址及业务数据。

## 许可

本项目使用 **MIT License**，详见仓库的 `LICENSE`。第三方依赖遵循各自许可证。
