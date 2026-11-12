# Third-party runtime dependencies

Serial Bridge is licensed under MIT. Python dependencies are installed separately and are not bundled in the VSIX:

- pySerial 3.5 — BSD-3-Clause. [License](https://github.com/pyserial/pyserial/blob/v3.5/LICENSE.txt)
- pyOCD 0.46.1 — Apache-2.0. [License](https://github.com/pyocd/pyOCD/blob/v0.46.1/LICENSE)
- pyOCD's transitive dependencies retain their respective licenses; see the installed distributions and upstream projects.

The VSIX is built with Microsoft `vsce` (MIT); the build tool is not bundled in the extension. [License](https://github.com/microsoft/vscode-vsce/blob/main/LICENSE)

The extension communicates with OpenSSH and Python installations supplied by the host environment. It does not bundle firmware, vendor device packs, a flash algorithm or USB drivers.
