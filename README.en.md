# Serial Bridge

Connect local serial devices and CMSIS-DAP probes on a Mac to a Linux SSH host from VS Code.

Development version **0.2.2** · [中文](README.md) · [Source](https://github.com/MScorpioLee/vscode-serial-bridge)

0.2.2 fixes stopping a channel under heavy traffic: stop commands remain readable during backpressure, unsent writes are cancelled, and exited helper processes are reaped without waiting for inherited output pipes. Bounded, batched log previews keep the controls responsive.

## Features and scope

- Up to 8 independent channels with separate device, host, settings, counters, and logs.
- Serial: custom baud rate, data/stop bits, parity, flow control, binary duplex transport, remote Linux PTYs, and rotating logs.
- Panel: text/HEX sending, line endings, live logs, and RX/TX counters.
- Probe: pyOCD remote-probe RPC over a loopback-only SSH reverse tunnel.
- Duplicate active devices and remote endpoints are rejected.

The verified platform combination is **macOS locally and Linux over SSH**. Windows and WSL are unverified.

## Requirements

- Local Mac: VS Code 1.95+, Python 3, and SSH key authentication that works without interactive prompts.
- Local isolated Python environment: pySerial 3.5 and pyOCD 0.46.1.
- Remote Linux: Python 3 and a writable runtime directory. Serial helpers use the Python standard library.

```sh
python3 -m venv ~/.local/share/serialbridge/venv
~/.local/share/serialbridge/venv/bin/python3 -m pip install "pyserial==3.5" "pyocd==0.46.1"
```

Dependencies stay outside the system Python environment. A probe must be discoverable by local pyOCD to use probe channels.

## Install and configure

Use a VSIX from [GitHub Releases](https://github.com/MScorpioLee/vscode-serial-bridge/releases), or build one from source below.
In the VS Code Extensions menu, choose **Install from VSIX…**, or run:

```sh
code --install-extension ./serial-bridge-0.2.2.vsix
```

These instructions do not imply Marketplace availability.
The extension runs in the **local Mac UI extension host**, including when a Remote SSH workspace is open.
Installing only on the Linux host does not give it access to your Mac USB devices or Python environment.

Create a local SSH host alias, for example `ssh-target`, and verify:

```sh
ssh -o BatchMode=yes ssh-target python3 --version
```

The panel reads host aliases from the local SSH configuration. Select the intended host and set these local VS Code user settings:

```json
{
  "serialBridge.pythonPath": "~/.local/share/serialbridge/venv/bin/python3",
  "serialBridge.remoteDirectory": "~/.local/share/serialbridge"
}
```

`pythonPath` is local to the Mac. `remoteDirectory` is on Linux and defaults to `~/.local/share/serialbridge`;
its `~` means the remote login user's home. It contains serial links, logs, and status files.
Use the complete paths returned by the panel. A system-wide `/dev` alias is not required.

## Serial channels

1. Add or select a channel and choose the serial mapping type.
2. Select a local USB serial device, SSH host, baud rate, and optional advanced UART settings.
3. Set a virtual port name such as `ttyBoard`, then start the channel explicitly.
4. Copy the remote PTY path into the Linux program that will consume the serial stream.
5. Send text or HEX from the panel, or open the remote log to observe device output.

Use one consuming reader per PTY; competing readers can split the byte stream.
Use log files for additional observers. Consumers should check the status file's connection state and heartbeat freshness.
Remote logs rotate; the panel keeps at most 200,000 characters per channel and is not a complete capture archive.
Under heavy load the panel may skip queued previews and show a notice; serial forwarding and remote logging use separate paths.
Clicking stop immediately disables new sends and cancels queued bytes that have not been written to the device.

## CMSIS-DAP probe channels

1. Add a channel, choose the CMSIS-DAP type, and select the probe UID and SSH host.
2. Choose a remote loopback port, default `5555`; each probe on the same host needs a separate port.
3. Start the transport and copy its endpoint, for example `remote:127.0.0.1:5555`.
4. Configure the target device and flashing/debugging workflow in a compatible remote pyOCD client.

This forwards **CMSIS-DAP probe RPC**. It is neither CDC UART nor whole-device USB forwarding.
A DAPLink device's CDC serial interface and debug-probe interface require separate channel types.

Transport setup checks protocol hello and cached probe identity. It does not connect to, halt, reset, or flash the target MCU.
A connected transport is not proof that a particular chip can be flashed or debugged.
Target definitions, support packs, flash algorithms, and subsequent target operations belong to the downstream tools.

## Architecture and lifecycle

```text
Mac VS Code UI → channel manager
  ├─ pySerial → local UART ↔ SSH ↔ Linux PTY / logs / status
  └─ pyOCD probe server ↔ SSH reverse loopback tunnel ↔ remote pyOCD client
```

- The local serial helper is the sole owner of its physical UART.
- Probe listeners and SSH reverse forwarding bind only to loopback addresses.
- An application heartbeat timeout of 8 seconds terminates the channel.
- No automatic device opening, reconnection, queued-data replay, or unsolicited sends.
- Stopping cleans up resources owned by that channel; wait for the stopping state to finish.
- Settings are saved, running connections are not. Per-channel session tokens reject stale UI commands.

## Troubleshooting

- **No device:** check the USB connection, local Python path and dependencies, then refresh. Serial and probe discovery are separate.
- **Busy device:** close the other serial or probe owner before starting again.
- **SSH failure:** verify noninteractive SSH, remote Python, and runtime-directory permissions.
- **Probe port busy:** select another remote loopback port.
- **Transport works, target does not:** check the downstream target configuration, support pack, and wiring separately.

## Build from source

Node.js/npm and the Python dependencies above are required.

```sh
git clone https://github.com/MScorpioLee/vscode-serial-bridge.git
cd vscode-serial-bridge
npm test
~/.local/share/serialbridge/venv/bin/python3 -m unittest discover -s tests -p 'test_*.py'
npm run package
```

Protocol and simulated PTY tests do not establish real-target flashing compatibility.
When reporting issues, include versions and sanitized errors; remove USB UIDs, host addresses, and application data.

## License

**MIT License**; see the repository's `LICENSE`. Third-party dependencies retain their own licenses.
