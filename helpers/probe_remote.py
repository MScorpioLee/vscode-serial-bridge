#!/usr/bin/env python3
"""Verify only pyOCD hello and cached identity/open-state properties; never open a probe."""
import argparse
from datetime import datetime, timezone
import fcntl
import json
import ipaddress
import os
from pathlib import Path
import re
import select
import signal
import socket
import stat
import sys
import tempfile
import time


def emit(message):
    print(json.dumps(message, separators=(',', ':')), flush=True)


def check_listener_binding(port, proc_root='/proc/net'):
    """Inspect actual Linux listeners; ssh GatewayPorts may override -R's bind IP."""
    inspected = False
    addresses = []
    for name, size in [('tcp', 4), ('tcp6', 16)]:
        path = Path(proc_root) / name
        if not path.exists():
            continue
        inspected = True
        try:
            rows = path.read_text().splitlines()
        except OSError as error:
            raise ValueError('Cannot verify reverse listener loopback binding') from error
        for row in rows:
            fields = row.split()
            if len(fields) < 4 or fields[3] != '0A':
                continue
            address, separator, encoded_port = fields[1].rpartition(':')
            if not separator:
                raise ValueError('Invalid Linux listener information')
            if int(encoded_port, 16) != port:
                continue
            raw = bytes.fromhex(address)
            if len(raw) != size:
                raise ValueError('Invalid Linux listener address')
            # /proc encodes each native-endian 32-bit word in hexadecimal.
            if sys.byteorder == 'little':
                raw = b''.join(raw[index:index + 4][::-1] for index in range(0, size, 4))
            ip = ipaddress.ip_address(raw)
            effective = ip.ipv4_mapped if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped else ip
            if not effective.is_loopback:
                raise ValueError('Reverse probe listener is not restricted to loopback; refusing exposed endpoint')
            addresses.append(str(ip))
    if not inspected or not addresses:
        raise ValueError('Cannot confirm an actual loopback-only reverse probe listener')
    return addresses


def verify(port, uid):
    # Deliberately do not use TCPClientProbe.open(): it sends the forbidden open RPC.
    with socket.create_connection(('127.0.0.1', port), timeout=3) as connection:
        connection.settimeout(3)
        with connection.makefile('rwb', buffering=0) as stream:
            results = []
            for identifier, request, arguments in [(1, 'hello', [1]), (2, 'readprop', ['unique_id']), (3, 'readprop', ['is_open'])]:
                connection.sendall((json.dumps({'id': identifier, 'request': request, 'arguments': arguments}) + '\n').encode())
                line = stream.readline(65537)
                if not line or len(line) > 65536 or not line.endswith(b'\n'):
                    raise ValueError('Invalid pyOCD protocol response frame')
                message = json.loads(line)
                if not isinstance(message, dict) or message.get('id') != identifier or message.get('status') != 0:
                    raise ValueError('pyOCD protocol request was rejected')
                results.append(message.get('result'))
    if results[1] != uid:
        raise ValueError('Probe identity does not match selected unique_id')
    if results[2] is not False:
        raise ValueError('Probe is already open; transport-only verification refused')


class Endpoint:
    def __init__(self, args):
        self.args = args
        self.directory = Path(os.path.abspath(os.path.expanduser(args.directory)))
        if self.directory == Path(self.directory.anchor) or self.directory == Path.home().resolve():
            raise ValueError("Use a dedicated runtime subdirectory, not the filesystem root or home directory")
        self.status = self.directory / f'cmsis-dap-{args.port}.status.json'
        self.lock = None
        self.can_write_status = False
        self.running = True
        self.connected = False
        self.error = None
        self.last_heartbeat_id = None

    def prepare(self):
        self.directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        info = self.directory.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid():
            raise ValueError('Status directory must be owned by this user and not a symlink')
        os.chmod(self.directory, 0o700)
        lock_path = self.directory / f'.cmsis-dap-{self.args.port}.lock'
        fd = os.open(lock_path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid():
                raise ValueError('Unsafe probe endpoint lock file')
            os.fchmod(fd, 0o600)
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except Exception:
            os.close(fd)
            raise
        self.lock = fd
        if os.path.lexists(self.status):
            info = self.status.lstat()
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid():
                raise ValueError('Probe status must be a regular file owned by this user')
        self.can_write_status = True
        self.write_status()

    def write_status(self):
        if self.lock is None or not self.can_write_status:
            return
        if self.status.is_symlink():
            raise ValueError('Probe status path was replaced with a symlink')
        state = {'kind': 'probe', 'connected': self.connected, 'probe_uid': self.args.uid,
                 'port': f'127.0.0.1:{self.args.port}', 'endpoint': f'remote:127.0.0.1:{self.args.port}',
                 'rx_bytes': 0, 'tx_bytes': 0, 'last_seen': datetime.now(timezone.utc).isoformat(timespec='milliseconds'),
                 'last_heartbeat_id': self.last_heartbeat_id, 'last_error': self.error, 'pid': os.getpid()}
        fd, temporary = tempfile.mkstemp(prefix='.probe-status-', dir=self.directory)
        try:
            with os.fdopen(fd, 'w') as stream:
                os.fchmod(stream.fileno(), 0o600)
                json.dump(state, stream)
            os.replace(temporary, self.status)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)

    def stop(self, *_):
        self.running = False

    def run(self):
        self.prepare()
        check_listener_binding(self.args.port)
        verify(self.args.port, self.args.uid)
        self.connected = True
        self.write_status()
        emit({'type': 'ready', 'port': f'127.0.0.1:{self.args.port}', 'endpoint': f'remote:127.0.0.1:{self.args.port}', 'status': str(self.status)})
        signal.signal(signal.SIGTERM, self.stop)
        signal.signal(signal.SIGINT, self.stop)
        last_heartbeat = last_status = time.monotonic()
        incoming = bytearray()
        while self.running:
            now = time.monotonic()
            if now - last_heartbeat > self.args.lease_seconds:
                raise ValueError('Controller heartbeat lease expired; probe transport is offline')
            if now - last_status > 0.5:
                self.write_status()
                last_status = now
            if not select.select([sys.stdin], [], [], 0.05)[0]:
                continue
            data = os.read(sys.stdin.fileno(), 8193)
            if not data:
                break
            incoming.extend(data)
            if len(incoming) > 8192:
                raise ValueError('Probe controller frame is too large')
            while b'\n' in incoming and self.running:
                line, _, tail = incoming.partition(b'\n')
                incoming[:] = tail
                message = json.loads(line)
                if not isinstance(message, dict):
                    raise ValueError('Probe controller message must be an object')
                if message.get('type') == 'stop':
                    self.stop()
                elif message.get('type') == 'heartbeat':
                    identifier = message.get('id')
                    if not isinstance(identifier, str) or len(identifier) > 256:
                        raise ValueError('Invalid probe heartbeat id')
                    last_heartbeat = time.monotonic()
                    self.last_heartbeat_id = identifier
                elif message.get('type') != 'state':
                    raise ValueError('Probe transport does not accept writes or target commands')
        return 0

    def close(self):
        if self.lock is not None:
            self.connected = False
            try:
                self.write_status()
            except (OSError, ValueError) as error:
                print(f'Could not mark owned probe status offline: {error}', file=sys.stderr, flush=True)
            finally:
                os.close(self.lock)
                self.lock = None


def main():
    endpoint = None
    try:
        parser = argparse.ArgumentParser(description=__doc__)
        parser.add_argument('--port', type=int, required=True)
        parser.add_argument('--uid', required=True)
        parser.add_argument('--directory', default='/workspace/.serial-logs')
        parser.add_argument('--lease-seconds', type=float, default=8)
        args = parser.parse_args()
        if not 1024 <= args.port <= 65535 or not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,199}', args.uid) or not 0.1 <= args.lease_seconds <= 60:
            raise ValueError('Invalid probe endpoint, unique ID or heartbeat lease')
        endpoint = Endpoint(args)
        return endpoint.run()
    except Exception as error:
        message = str(error) or type(error).__name__
        if endpoint is not None:
            endpoint.error = message
        emit({'type': 'error', 'message': message})
        print(message, file=sys.stderr, flush=True)
        return 1
    finally:
        if endpoint is not None:
            endpoint.close()


if __name__ == '__main__':
    raise SystemExit(main())
