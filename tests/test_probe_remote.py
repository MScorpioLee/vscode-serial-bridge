import json
import importlib.util
import os
from pathlib import Path
import select
import socket
import subprocess
import sys
import tempfile
import threading
import unittest

HELPER = Path(__file__).resolve().parents[1] / 'helpers/probe_remote.py'


class ProbeRemoteTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.server = socket.socket()
        self.server.bind(('127.0.0.1', 0))
        self.server.listen()
        self.port = self.server.getsockname()[1]
        self.requests = []
        self.child = None

    def tearDown(self):
        if self.child:
            if self.child.poll() is None:
                self.child.stdin.close()
                self.child.wait(timeout=3)
            for stream in [self.child.stdin, self.child.stdout, self.child.stderr]:
                stream.close()
        self.server.close()
        self.directory.cleanup()

    def start(self, uid='UID123', opened=False, lease=8, exposed=False):
        def serve():
            try:
                connection, _ = self.server.accept()
            except OSError:
                return
            with connection, connection.makefile('rwb', buffering=0) as stream:
                for result in [None, uid, opened]:
                    line = stream.readline()
                    if not line:
                        return
                    message = json.loads(line)
                    self.requests.append(message)
                    response = {'id': message['id'], 'status': 0}
                    if result is not None:
                        response['result'] = result
                    stream.write(json.dumps(response).encode() + b'\n')
        self.worker = threading.Thread(target=serve, daemon=True)
        self.worker.start()
        binding = "(_ for _ in ()).throw(ValueError('listener is not loopback'))" if exposed else "None"
        wrapper = "import importlib.util,sys; s=importlib.util.spec_from_file_location('probe_remote_test',sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); m.check_listener_binding=lambda port: " + binding + "; sys.argv=sys.argv[1:]; raise SystemExit(m.main())"
        self.child = subprocess.Popen([sys.executable, '-c', wrapper, str(HELPER), '--port', str(self.port), '--uid', 'UID123', '--directory', self.directory.name, '--lease-seconds', str(lease)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        return self.child

    def event(self):
        self.assertTrue(select.select([self.child.stdout], [], [], 4)[0])
        line = self.child.stdout.readline()
        if not line:
            self.fail(self.child.stderr.read().decode())
        return json.loads(line)

    def status(self):
        return json.loads((Path(self.directory.name) / f'cmsis-dap-{self.port}.status.json').read_text())

    def test_runtime_directory_rejects_root_and_home_before_changes(self):
        for directory in ['/', str(Path.home())]:
            process = subprocess.run([sys.executable, str(HELPER), '--port', '5555', '--uid', 'UID123', '--directory', directory], capture_output=True, timeout=3)
            self.assertNotEqual(process.returncode, 0)
            self.assertIn('dedicated', process.stdout.decode().lower())

    def test_hello_only_verifies_identity_and_unopened_state(self):
        self.start()
        event = self.event()
        self.assertEqual(event['type'], 'ready', event)
        self.assertEqual(event['endpoint'], f'remote:127.0.0.1:{self.port}')
        self.assertTrue(self.status()['connected'])
        self.worker.join(timeout=2)
        self.assertEqual(self.requests, [
            {'id': 1, 'request': 'hello', 'arguments': [1]},
            {'id': 2, 'request': 'readprop', 'arguments': ['unique_id']},
            {'id': 3, 'request': 'readprop', 'arguments': ['is_open']},
        ])
        self.assertEqual(os.stat(event['status']).st_mode & 0o777, 0o600)
        self.child.stdin.close()
        self.assertEqual(self.child.wait(timeout=3), 0)
        self.assertFalse(self.status()['connected'])

    def test_wrong_identity_is_rejected(self):
        self.start(uid='OTHER')
        event = self.event()
        self.assertEqual(event['type'], 'error', event)
        self.assertNotEqual(self.child.wait(timeout=3), 0)
        self.assertFalse(self.status()['connected'])

    def test_already_open_probe_is_rejected(self):
        self.start(opened=True)
        self.assertEqual(self.event()['type'], 'error')
        self.assertNotEqual(self.child.wait(timeout=3), 0)
        self.assertFalse(self.status()['connected'])

    def test_lease_expiry_marks_status_offline(self):
        self.start(lease=0.25)
        self.assertEqual(self.event()['type'], 'ready')
        error = self.event()
        self.assertEqual(error['type'], 'error', error)
        self.assertIn('heartbeat', error['message'])
        self.assertNotEqual(self.child.wait(timeout=3), 0)
        self.assertFalse(self.status()['connected'])

    def test_heartbeat_and_stop_cleanup(self):
        self.start(lease=0.5)
        self.assertEqual(self.event()['type'], 'ready')
        self.child.stdin.write(b'{"type":"heartbeat","id":"one"}\n{"type":"stop"}\n')
        self.child.stdin.flush()
        self.assertEqual(self.child.wait(timeout=3), 0)
        self.assertFalse(self.status()['connected'])

    def test_status_symlink_is_rejected_and_preserved(self):
        victim = Path(self.directory.name) / 'unrelated.json'
        victim.write_text('keep me')
        status = Path(self.directory.name) / f'cmsis-dap-{self.port}.status.json'
        status.symlink_to(victim)
        self.start()
        self.assertEqual(self.event()['type'], 'error')
        self.assertNotEqual(self.child.wait(timeout=3), 0)
        self.assertTrue(status.is_symlink())
        self.assertEqual(victim.read_text(), 'keep me')

    def test_exposed_binding_fails_before_any_probe_rpc(self):
        self.start(exposed=True)
        event = self.event()
        self.assertEqual(event['type'], 'error', event)
        self.assertIn('loopback', event['message'])
        self.assertNotEqual(self.child.wait(timeout=3), 0)
        self.assertEqual(self.requests, [])
        self.assertFalse(self.status()['connected'])

    def test_target_command_is_rejected_without_additional_rpc(self):
        self.start()
        self.assertEqual(self.event()['type'], 'ready')
        self.child.stdin.write(b'{"type":"open"}\n')
        self.child.stdin.flush()
        self.assertEqual(self.event()['type'], 'error')
        self.assertNotEqual(self.child.wait(timeout=3), 0)
        self.assertEqual(len(self.requests), 3)
        self.assertFalse(self.status()['connected'])


class ListenerBindingTests(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location('probe_binding_under_test', HELPER)
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)
        self.directory = tempfile.TemporaryDirectory()

    def tearDown(self):
        self.directory.cleanup()

    def table(self, ipv4=(), ipv6=()):
        for name, addresses in [('tcp', ipv4), ('tcp6', ipv6)]:
            rows = ['  sl local_address rem_address st']
            rows.extend(f'0: {address}:15B3 00000000:0000 0A' for address in addresses)
            (Path(self.directory.name) / name).write_text('\n'.join(rows) + '\n')

    def test_loopback_ipv4_and_ipv6_are_accepted(self):
        self.table(ipv4=['0100007F'], ipv6=['00000000000000000000000001000000'])
        self.module.check_listener_binding(5555, self.directory.name)

    def test_gatewayports_ipv4_wildcard_is_rejected(self):
        self.table(ipv4=['00000000'])
        with self.assertRaisesRegex(ValueError, 'loopback'):
            self.module.check_listener_binding(5555, self.directory.name)

    def test_ipv6_wildcard_and_lan_bind_are_rejected(self):
        for v4, v6 in [([], ['00000000000000000000000000000000']), (['0100000A'], [])]:
            self.table(ipv4=v4, ipv6=v6)
            with self.assertRaisesRegex(ValueError, 'loopback'):
                self.module.check_listener_binding(5555, self.directory.name)

    def test_missing_or_no_listener_information_fails_closed(self):
        with self.assertRaises(ValueError):
            self.module.check_listener_binding(5555, self.directory.name)
        self.table()
        with self.assertRaises(ValueError):
            self.module.check_listener_binding(5555, self.directory.name)


if __name__ == '__main__':
    unittest.main()
