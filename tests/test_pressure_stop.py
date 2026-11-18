"""Stop/rebind integration regression using real helpers and two simulated PTYs.

Run with a Python interpreter that has pySerial 3.5 installed. No serial hardware
or SSH is used. SERIALBRIDGE_PRESSURE_SOURCE_ROOT can point at an older source
snapshot to demonstrate the inherited-output-pipe regression.
"""
import errno
import fcntl
import json
import os
from pathlib import Path
import queue
import select
import signal
import subprocess
import sys
import tempfile
import threading
import time
import unittest

ROOT = Path(__file__).resolve().parents[1]


def read_exact(fd, length, timeout=4):
    result = bytearray()
    deadline = time.monotonic() + timeout
    while len(result) < length and time.monotonic() < deadline:
        if select.select([fd], [], [], .1)[0]:
            try:
                result.extend(os.read(fd, length - len(result)))
            except BlockingIOError:
                pass
    if len(result) != length:
        raise AssertionError(f'Expected {length} PTY bytes, received {len(result)}')
    return bytes(result)


class Controller:
    def __init__(self, runtime, ports, hold_pipe):
        env = dict(os.environ, BRIDGE_PYTHON=sys.executable,
                   BRIDGE_RUNTIME=runtime, BRIDGE_PORTS=json.dumps(ports),
                   BRIDGE_HOLD_REMOTE_PIPE='1' if hold_pipe else '0',
                   SERIALBRIDGE_SIMULATED_PTY='1')
        self.process = subprocess.Popen(
            ['node', str(ROOT / 'tests/pressure_harness.js')],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            env=env, start_new_session=True)
        self.messages = queue.Queue()
        self.sequence = 0
        self.reader = threading.Thread(target=self.read_messages, daemon=True)
        self.reader.start()

    def read_messages(self):
        for line in self.process.stdout:
            try:
                self.messages.put(json.loads(line))
            except ValueError:
                self.messages.put({'type':'error', 'message':'Invalid harness JSON'})
        self.messages.put({'type':'eof'})

    def wait(self, kind, request_id=None, timeout=8):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            try:
                value = self.messages.get(timeout=max(.01, deadline-time.monotonic()))
            except queue.Empty:
                break
            if value['type'] == 'error':
                raise AssertionError(value['message'])
            if value['type'] == 'eof':
                raise AssertionError('Node controller exited before replying')
            if value['type'] == kind and (request_id is None or value.get('requestId') == request_id):
                return value
        raise AssertionError(f'{kind} did not complete within {timeout}s')

    def request(self, kind, index=None, timeout=8):
        self.sequence += 1
        request = {'type':kind, 'requestId':self.sequence}
        if index is not None:
            request['index'] = index
        self.process.stdin.write((json.dumps(request)+'\n').encode())
        self.process.stdin.flush()
        return self.wait('response', self.sequence, timeout)

    def close(self):
        if self.process.poll() is None:
            try:
                self.process.stdin.write(b'{"type":"quit"}\n')
                self.process.stdin.flush()
                self.process.wait(timeout=5)
            except (OSError, subprocess.TimeoutExpired):
                # This process group contains only this fixture and its helpers.
                try:
                    os.killpg(self.process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                self.process.wait(timeout=3)
        for stream in (self.process.stdin, self.process.stdout, self.process.stderr):
            stream.close()
        self.reader.join(timeout=1)


class Traffic:
    """Continuous independent board RX and remote TX, with optional RX pressure."""
    def __init__(self, master, remote, rx_byte, tx_byte):
        self.master, self.remote = master, remote
        self.rx_byte, self.tx_byte = rx_byte, tx_byte
        self.rx = self.tx = 0
        self.error = None
        self.read_remote = True
        self.allow_close = False
        self.done = threading.Event()
        self.thread = threading.Thread(target=self.run, daemon=True)

    def start(self):
        self.thread.start()

    def stop(self):
        self.done.set()
        self.thread.join(timeout=2)
        if self.thread.is_alive():
            raise AssertionError('Simulated traffic pump did not stop')

    def run(self):
        try:
            while not self.done.is_set():
                reads = [self.master] + ([self.remote] if self.read_remote else [])
                readable, writable, _ = select.select(reads, [self.master, self.remote], [], .002)
                for fd in readable:
                    try:
                        data = os.read(fd, 65536)
                    except BlockingIOError:
                        continue
                    expected = self.rx_byte if fd == self.remote else self.tx_byte
                    if data and any(byte != expected for byte in data):
                        raise AssertionError('Data crossed channels or changed direction')
                    if fd == self.remote:
                        self.rx += len(data)
                    else:
                        self.tx += len(data)
                for fd in writable:
                    value = self.rx_byte if fd == self.master else self.tx_byte
                    try:
                        os.write(fd, bytes([value]) * 512)
                    except BlockingIOError:
                        pass
                self.done.wait(.002)
        except OSError as error:
            if not (self.allow_close and error.errno in (errno.EIO, errno.ENXIO, errno.EBADF)):
                self.error = error
        except BaseException as error:
            self.error = error


class PressureStopTest(unittest.TestCase):
    def exercise(self, hold_pipe):
        terminals = [os.openpty(), os.openpty()]
        masters = [item[0] for item in terminals]
        ports = [os.ttyname(item[1]) for item in terminals]
        for fd in masters:
            os.set_blocking(fd, False)
        controller = None
        remote_fds, traffic = [], []
        with tempfile.TemporaryDirectory(prefix='serialbridge-pressure-') as runtime:
            try:
                controller = Controller(runtime, ports, hold_pipe)
                ready = controller.wait('ready')
                for index, mapping in enumerate(ready['mappings']):
                    self.assertEqual(mapping['phase'], 'connected')
                    fd = os.open(mapping['remote']['port'], os.O_RDWR | os.O_NONBLOCK | os.O_NOCTTY)
                    remote_fds.append(fd)
                    payload = bytes(range(256)) + bytes([index])
                    os.write(masters[index], payload)
                    self.assertEqual(read_exact(fd, len(payload)), payload)
                    os.write(fd, payload[::-1])
                    self.assertEqual(read_exact(masters[index], len(payload)), payload[::-1])
                for index in range(2):
                    pump = Traffic(masters[index], remote_fds[index], 65+index, 97+index)
                    pump.start()
                    traffic.append(pump)
                time.sleep(.8)
                for pump in traffic:
                    self.assertIsNone(pump.error)
                    self.assertGreaterEqual(pump.rx, 16384)
                    self.assertGreaterEqual(pump.tx, 16384)
                # Stop while data is still flowing and the virtual RX reader lags.
                traffic[0].read_remote = False
                time.sleep(.2)
                b_before = traffic[1].rx + traffic[1].tx
                traffic[0].allow_close = True
                started = time.monotonic()
                stopped = controller.request('stop', 0, timeout=4)
                elapsed = time.monotonic() - started
                self.assertLess(elapsed, 3.5, 'Stop exceeded its cleanup deadline')
                self.assertEqual(stopped['mappings'][0]['phase'], 'idle')
                self.assertEqual(stopped['mappings'][1]['phase'], 'connected')
                self.assertTrue(all(child['exited'] for child in stopped['children']
                                    if child['name'] == 'ttyPressureA'))
                self.assertFalse(os.path.lexists(Path(runtime)/'ttyPressureA'))
                status = json.loads((Path(runtime)/'ttyPressureA.status.json').read_text())
                self.assertFalse(status['running'])
                self.assertFalse(status['connected'])
                self.assertFalse(any(ports[0] in key or 'ttyPressureA' in key
                                     for key in stopped['reservations']))
                traffic[0].stop()
                self.assertIsNone(traffic[0].error)
                os.close(remote_fds[0])
                remote_fds[0] = -1
                # Both TIOCEXCL and the cooperating owner's flock must be gone.
                probe = os.open(ports[0], os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)
                try:
                    fcntl.flock(probe, fcntl.LOCK_EX | fcntl.LOCK_NB)
                finally:
                    os.close(probe)
                time.sleep(.15)
                self.assertGreater(traffic[1].rx + traffic[1].tx, b_before)
                self.assertIsNone(traffic[1].error)
                controller.request('clearHolders')
                restarted = controller.request('start', 0)
                self.assertEqual(restarted['mappings'][0]['phase'], 'connected')
                self.assertEqual(restarted['mappings'][1]['phase'], 'connected')
                remote_fds[0] = os.open(restarted['mappings'][0]['remote']['port'],
                                        os.O_RDWR | os.O_NONBLOCK | os.O_NOCTTY)
                # Discard fixture traffic left in the master's receive queue.
                while select.select([masters[0]], [], [], 0)[0]:
                    os.read(masters[0], 65536)
                payload = b'fresh-binding\x00\xff\r\n'
                os.write(masters[0], payload)
                self.assertEqual(read_exact(remote_fds[0], len(payload)), payload)
                os.write(remote_fds[0], payload[::-1])
                self.assertEqual(read_exact(masters[0], len(payload)), payload[::-1])
                traffic[1].stop()
                self.assertIsNone(traffic[1].error)
                result = {'held_output_pipe':hold_pipe, 'stop_seconds':round(elapsed, 3),
                          'channel_a_rx':traffic[0].rx, 'channel_a_tx':traffic[0].tx,
                          'channel_b_rx':traffic[1].rx, 'channel_b_tx':traffic[1].tx,
                          'rebound':True, 'other_channel_unaffected':True}
                print('PRESSURE_RESULT '+json.dumps(result), flush=True)
            finally:
                for pump in traffic:
                    pump.allow_close = True
                    pump.stop()
                for fd in remote_fds:
                    if fd >= 0:
                        os.close(fd)
                if controller is not None:
                    controller.close()
                for master, slave in terminals:
                    os.close(slave)
                    os.close(master)

    def test_continuous_duplex_can_stop_and_rebind(self):
        self.exercise(hold_pipe=False)

    def test_inherited_helper_output_pipe_does_not_block_stop_or_other_channel(self):
        self.exercise(hold_pipe=True)


if __name__ == '__main__':
    unittest.main()
