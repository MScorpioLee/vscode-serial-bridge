import base64
import json
import os
from pathlib import Path
import select
import stat
import subprocess
import sys
import tempfile
import termios
import threading
import time
import unittest

HELPER = Path(__file__).resolve().parents[1] / "helpers" / "remote_bridge.py"


class RemoteProcess:
    def __init__(self, directory, *extra):
        self.process = subprocess.Popen(
            [sys.executable, "-u", str(HELPER), "--directory", str(directory), *extra],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )
        self.pending = bytearray()
        try:
            self.ready = self.message()
            if self.ready.get("type") != "ready":
                raise AssertionError(f"Helper did not become ready: {self.ready}")
            self.slave = os.open(self.ready["port"], os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)
        except BaseException:
            if self.process.poll() is None:
                self.process.kill()
            self.process.wait(timeout=3)
            for stream in (self.process.stdin, self.process.stdout, self.process.stderr):
                stream.close()
            raise

    def send(self, message):
        self.process.stdin.write(json.dumps(message).encode() + b"\n")
        self.process.stdin.flush()

    def message(self, timeout=3):
        deadline = time.monotonic() + timeout
        while b"\n" not in self.pending:
            remaining = deadline - time.monotonic()
            if remaining <= 0 or not select.select([self.process.stdout], [], [], remaining)[0]:
                raise AssertionError("Timed out waiting for helper JSON")
            chunk = os.read(self.process.stdout.fileno(), 65536)
            if not chunk:
                detail = self.process.stderr.read().decode(errors="replace")
                raise AssertionError(f"Helper exited before JSON: {detail}")
            self.pending.extend(chunk)
        line, _, tail = self.pending.partition(b"\n")
        self.pending = bytearray(tail)
        return json.loads(line)

    def state(self, connected=True, baud=460800):
        self.send({"type": "state", "connected": connected, "baud": baud})
        return self.wait_status(lambda value: value["connected"] is connected and value["baud"] == baud)

    def wait_status(self, predicate):
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            try:
                value = json.loads(Path(self.ready["status"]).read_text())
                if predicate(value):
                    return value
            except (FileNotFoundError, json.JSONDecodeError):
                pass
            time.sleep(0.01)
        raise AssertionError("Status did not reach expected state")

    def read_slave(self, count, timeout=3):
        data = bytearray()
        deadline = time.monotonic() + timeout
        while len(data) < count and time.monotonic() < deadline:
            if select.select([self.slave], [], [], max(0, deadline - time.monotonic()))[0]:
                try:
                    data.extend(os.read(self.slave, count - len(data)))
                except BlockingIOError:
                    pass
        return bytes(data)

    def close(self):
        if self.process.poll() is None:
            try:
                self.send({"type": "stop"})
                self.process.wait(timeout=3)
            except (BrokenPipeError, subprocess.TimeoutExpired):
                self.process.kill()
                self.process.wait(timeout=3)
        os.close(self.slave)
        for stream in (self.process.stdin, self.process.stdout, self.process.stderr):
            stream.close()


class RemoteBridgeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.directory = Path(self.temp.name) / "logs"
        self.clients = []

    def tearDown(self):
        for client in reversed(self.clients):
            client.close()
        self.temp.cleanup()

    def start(self, *extra):
        client = RemoteProcess(self.directory, *extra)
        self.clients.append(client)
        return client

    def test_runtime_directory_rejects_root_and_home_before_changes(self):
        for directory in ['/', str(Path.home())]:
            process = subprocess.run([sys.executable, str(HELPER), '--directory', directory], capture_output=True, timeout=3)
            self.assertNotEqual(process.returncode, 0)
            self.assertIn('dedicated', process.stdout.decode().lower())

    def test_non_t3_mapping_log_uses_its_own_name(self):
        with tempfile.TemporaryDirectory() as directory:
            client = RemoteProcess(directory, '--name', 'ttyCP2102')
            try:
                self.assertEqual(Path(client.ready['log']).name, 'serial-ttyCP2102.log')
            finally:
                client.close()

    def test_binary_duplex_and_private_ready_paths(self):
        client = self.start()
        self.assertEqual(Path(client.ready["port"]).name, "ttyT3")
        self.assertEqual(Path(client.ready["log"]).name, "t3-ch340-460800.log")
        self.assertEqual(stat.S_IMODE(self.directory.stat().st_mode), 0o700)
        initial = json.loads(Path(client.ready["status"]).read_text())
        self.assertFalse(initial["connected"])
        client.state()
        payload = bytes(range(256)) * 80
        client.send({"type": "rx", "data": base64.b64encode(payload).decode()})
        self.assertEqual(client.read_slave(len(payload)), payload)
        # The raw terminal must not echo RX back as a remote write request.
        self.assertFalse(select.select([client.process.stdout], [], [], 0.05)[0])
        outgoing = b"\x00\xff\r\n\x03remote-tool"
        os.write(client.slave, outgoing)
        forwarded = bytearray()
        while len(forwarded) < len(outgoing):
            message = client.message()
            self.assertEqual(message["type"], "write")
            self.assertIsInstance(message["id"], str)
            forwarded.extend(base64.b64decode(message["data"], validate=True))
        self.assertEqual(bytes(forwarded), outgoing)
        client.send({"type": "tx", "data": base64.b64encode(outgoing).decode()})
        status = client.wait_status(lambda value: value["counters"]["tx_bytes"] == len(outgoing))
        self.assertEqual(status["counters"]["rx_bytes"], len(payload))
        for key in ("log", "raw", "events", "status"):
            self.assertEqual(stat.S_IMODE(Path(client.ready[key]).stat().st_mode), 0o600)

    def test_disconnected_pty_writes_are_dropped_and_not_replayed(self):
        client = self.start()
        client.state(False)
        os.write(client.slave, b"must-drop")
        client.wait_status(lambda value: value["counters"]["dropped_pty_bytes"] >= 9)
        self.assertFalse(select.select([client.process.stdout], [], [], 0.1)[0])
        client.state(True)
        os.write(client.slave, b"live")
        message = client.message()
        self.assertEqual(base64.b64decode(message["data"]), b"live")
        client.state(False)
        os.write(client.slave, b"drop-again")
        client.wait_status(lambda value: value["counters"]["dropped_pty_bytes"] >= 19)
        self.assertFalse(select.select([client.process.stdout], [], [], 0.1)[0])

    def test_incremental_utf8_and_raw_capture_are_not_chunk_decorated(self):
        client = self.start()
        client.state()
        text = "T3 启动\r\n温度=25.1°C\n"
        encoded = text.encode()
        for byte in encoded:
            client.send({"type": "rx", "data": base64.b64encode(bytes([byte])).decode()})
        self.assertEqual(client.read_slave(len(encoded)), encoded)
        client.wait_status(lambda value: value["counters"]["rx_bytes"] == len(encoded))
        self.assertEqual(Path(client.ready["log"]).read_bytes(), encoded)
        self.assertEqual(Path(client.ready["raw"]).read_bytes(), encoded)
        # Multiple observers read the regular log independently.
        with open(client.ready["log"], "rb") as first, open(client.ready["log"], "rb") as second:
            self.assertEqual(first.read(), encoded)
            self.assertEqual(second.read(), encoded)

    def test_actual_baud_and_heartbeat_update_without_renaming_log(self):
        client = self.start()
        initial = client.state(True, 921600)
        self.assertEqual(Path(client.ready["log"]).name, "t3-ch340-460800.log")
        newer = client.wait_status(lambda value: value["updated_at_unix"] > initial["updated_at_unix"] + 0.5)
        self.assertEqual(newer["baud"], 921600)
        self.assertTrue(newer["connected"])
        self.assertIn("updated_at", newer)

    def test_stdin_eof_cleans_owned_link_and_marks_offline(self):
        client = self.start()
        client.state()
        client.process.stdin.close()
        self.assertEqual(client.process.wait(timeout=3), 0)
        self.assertFalse(os.path.lexists(client.ready["port"]))
        status = json.loads(Path(client.ready["status"]).read_text())
        self.assertFalse(status["connected"])
        self.assertFalse(status["running"])

    def test_cleanup_preserves_replacement_link(self):
        client = self.start()
        port = Path(client.ready["port"])
        port.unlink()
        port.symlink_to("/somebody-elses-endpoint")
        client.send({"type": "stop"})
        self.assertEqual(client.process.wait(timeout=3), 0)
        self.assertTrue(port.is_symlink())
        self.assertEqual(os.readlink(port), "/somebody-elses-endpoint")

    def test_second_mapping_is_locked_and_does_not_remove_first_link(self):
        client = self.start()
        other = subprocess.run([sys.executable, str(HELPER), "--directory", str(self.directory)],
                               input=b"", stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=3)
        self.assertNotEqual(other.returncode, 0)
        self.assertEqual(json.loads(other.stdout.splitlines()[0])["type"], "error")
        self.assertTrue(Path(client.ready["port"]).is_symlink())
        client.state()
        client.send({"type": "rx", "data": base64.b64encode(b"still-alive").decode()})
        self.assertEqual(client.read_slave(11), b"still-alive")

    def test_invalid_json_schema_reports_error_without_forwarding_or_dying(self):
        client = self.start()
        for message in [[], {"type": "rx", "data": "!notbase64"},
                        {"type": "state", "connected": "yes", "baud": 460800},
                        {"type": "state", "connected": True, "baud": True},
                        {"type": "unknown"}]:
            client.send(message)
            self.assertEqual(client.message()["type"], "error")
        self.assertIsNone(client.process.poll())
        client.state()
        client.send({"type": "rx", "data": base64.b64encode(b"valid").decode()})
        self.assertEqual(client.read_slave(5), b"valid")

    def test_sustained_binary_rx_keeps_up_with_460800_baud(self):
        client = self.start()
        client.state()
        payload = bytes(range(256)) * 768
        received = bytearray()
        def consume():
            deadline = time.monotonic() + 6
            while len(received) < len(payload) and time.monotonic() < deadline:
                if select.select([client.slave], [], [], 0.05)[0]:
                    try:
                        received.extend(os.read(client.slave, 65536))
                    except BlockingIOError:
                        pass
        reader = threading.Thread(target=consume, daemon=True)
        reader.start()
        started = time.monotonic()
        for offset in range(0, len(payload), 8192):
            client.send({"type": "rx", "data": base64.b64encode(payload[offset:offset + 8192]).decode()})
            # Four times the 46 kB/s payload rate of a 460800 8N1 serial link.
            time.sleep(0.04)
        reader.join(timeout=6)
        self.assertFalse(reader.is_alive())
        self.assertEqual(bytes(received), payload)
        self.assertLess(time.monotonic() - started, len(payload) / 46080)
        status = client.wait_status(lambda value: value["counters"]["rx_bytes"] == len(payload))
        self.assertEqual(status["counters"]["dropped_pty_rx_bytes"], 0)
        self.assertEqual(Path(client.ready["raw"]).read_bytes(), payload)

    def test_log_capture_continues_when_pty_has_no_reader(self):
        client = self.start()
        client.state()
        payload = b"T3 log-only capture\n" * 4096
        total = payload * 8
        for offset in range(0, len(total), 32768):
            client.send({"type": "rx", "data": base64.b64encode(total[offset:offset + 32768]).decode()})
        status = client.wait_status(lambda value: value["counters"]["rx_bytes"] == len(total))
        self.assertIsNone(client.process.poll())
        self.assertLessEqual(status["pending_pty_bytes"], 256 * 1024)
        self.assertGreater(status["counters"]["dropped_pty_rx_bytes"], 0)
        self.assertEqual(Path(client.ready["raw"]).read_bytes(), total)
        self.assertEqual(Path(client.ready["log"]).read_bytes(), total)

    def test_unread_stdout_has_bounded_backpressure_and_stop_still_works(self):
        client = self.start()
        client.state()
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            try:
                os.write(client.slave, b"x" * 32768)
            except BlockingIOError:
                time.sleep(0.002)
            try:
                status = json.loads(Path(client.ready["status"]).read_text())
                if status["pending_output_bytes"] > 65536:
                    break
            except json.JSONDecodeError:
                pass
        status = client.wait_status(lambda value: value["pending_output_bytes"] > 65536)
        self.assertLessEqual(status["pending_output_bytes"], 256 * 1024)
        client.send({"type": "stop"})
        self.assertEqual(client.process.wait(timeout=3), 0)
        self.assertFalse(os.path.lexists(client.ready["port"]))

    def test_oversized_frames_fail_closed_and_existing_links_are_preserved(self):
        client = self.start()
        client.process.stdin.write(b"x" * (128 * 1024 + 1))
        client.process.stdin.flush()
        self.assertEqual(client.message()["type"], "error")
        self.assertNotEqual(client.process.wait(timeout=3), 0)
        self.assertFalse(os.path.lexists(client.ready["port"]))
        preserved = self.directory / "ttyT3"
        preserved.symlink_to("/another-owner")
        other = subprocess.run([sys.executable, str(HELPER), "--directory", str(self.directory)],
                               input=b"", stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=3)
        self.assertNotEqual(other.returncode, 0)
        self.assertEqual(os.readlink(preserved), "/another-owner")

    def test_peer_lease_expires_despite_state_and_rx_traffic(self):
        client = self.start("--lease-seconds", "0.3")
        client.state()
        client.send({"type": "heartbeat", "id": "peer-start"})
        client.wait_status(lambda value: value.get("last_heartbeat_id") == "peer-start")
        deadline = time.monotonic() + 0.6
        while time.monotonic() < deadline and client.process.poll() is None:
            try:
                client.send({"type": "state", "connected": True, "baud": 460800})
                client.send({"type": "rx", "data": "bGl2ZQo="})
            except BrokenPipeError:
                break
            time.sleep(0.04)
        error = client.message()
        self.assertEqual(error["type"], "error")
        self.assertIn("lease", error["message"].lower())
        self.assertNotEqual(client.process.wait(timeout=3), 0)
        final = json.loads(Path(client.ready["status"]).read_text())
        self.assertFalse(final["connected"])
        self.assertFalse(final["running"])
        self.assertGreaterEqual(final["peer_heartbeat_age"], 0.3)
        self.assertFalse(os.path.lexists(client.ready["port"]))

    def test_offline_state_does_not_pause_an_already_started_peer_lease(self):
        client = self.start("--lease-seconds", "0.3")
        client.state()
        client.send({"type": "heartbeat", "id": "last-peer"})
        client.state(False)
        message = client.message(timeout=1)
        self.assertEqual(message["type"], "error")
        self.assertIn("lease", message["message"].lower())
        self.assertNotEqual(client.process.wait(timeout=3), 0)

    def test_cycling_connection_state_cannot_renew_started_peer_lease(self):
        client = self.start("--lease-seconds", "0.3")
        client.state()
        client.send({"type": "heartbeat", "id": "only-heartbeat"})
        client.wait_status(lambda value: value.get("last_heartbeat_id") == "only-heartbeat")
        deadline = time.monotonic() + 0.6
        while time.monotonic() < deadline and client.process.poll() is None:
            try:
                client.send({"type": "state", "connected": False, "baud": 460800})
                client.send({"type": "state", "connected": True, "baud": 460800})
            except BrokenPipeError:
                break
            time.sleep(0.04)
        self.assertIsNotNone(client.process.poll(), "Connection-state cycling cannot act as a heartbeat")
        self.assertEqual(client.message()["type"], "error")

    def test_fresh_heartbeat_keeps_lease_and_labels_every_write(self):
        client = self.start("--lease-seconds", "0.3")
        client.state()
        for index in range(6):
            client.send({"type": "heartbeat", "id": "peer-" + str(index)})
            time.sleep(0.08)
        status = client.wait_status(lambda value: value.get("last_heartbeat_id") == "peer-5")
        self.assertLess(status["peer_heartbeat_age"], 0.3)
        self.assertTrue(status["connected"])
        os.write(client.slave, b"lease-checked")
        message = client.message()
        self.assertEqual(message["type"], "write")
        self.assertEqual(message["last_heartbeat_id"], "peer-5")
        self.assertEqual(base64.b64decode(message["data"]), b"lease-checked")

    def test_rx_does_not_echo_back_even_after_tool_enables_canonical_echo(self):
        client = self.start()
        client.state()
        attributes = termios.tcgetattr(client.slave)
        attributes[3] |= termios.ECHO | termios.ICANON
        termios.tcsetattr(client.slave, termios.TCSANOW, attributes)
        payload = b"RX-only\r\n\x00\xff"
        client.send({"type": "rx", "data": base64.b64encode(payload).decode()})
        self.assertEqual(client.read_slave(len(payload)), payload)
        self.assertFalse(select.select([client.process.stdout], [], [], 0.2)[0], "Kernel echo must never become a board TX command")

    def test_sigkill_restart_recovers_only_recorded_owned_link(self):
        client = self.start()
        client.process.kill()
        client.process.wait(timeout=3)
        self.assertTrue(os.path.lexists(client.ready["port"]))
        restarted = self.start()
        restarted.state()
        restarted.send({"type": "rx", "data": base64.b64encode(b"recovered").decode()})
        self.assertEqual(restarted.read_slave(9), b"recovered")
        restarted.process.kill()
        restarted.process.wait(timeout=3)
        port = Path(restarted.ready["port"])
        port.unlink()
        port.symlink_to("/replacement-must-survive")
        other = subprocess.run([sys.executable, str(HELPER), "--directory", str(self.directory)],
                               input=b"", stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=3)
        self.assertNotEqual(other.returncode, 0)
        self.assertEqual(os.readlink(port), "/replacement-must-survive")

    def test_rotated_logs_remain_bounded(self):
        client = self.start("--log-limit", "1024")
        client.state()
        payload = b"a" * 6000
        client.send({"type": "rx", "data": base64.b64encode(payload).decode()})
        self.assertEqual(client.read_slave(len(payload)), payload)
        client.wait_status(lambda value: value["counters"]["rx_bytes"] == len(payload))
        for key in ("log", "raw"):
            path = Path(client.ready[key])
            self.assertLessEqual(path.stat().st_size, 1024)
            self.assertTrue(Path(str(path) + ".1").exists())
            self.assertTrue(Path(str(path) + ".2").exists())
            self.assertFalse(Path(str(path) + ".3").exists())
            self.assertTrue(all(p.stat().st_size <= 1024 for p in path.parent.glob(path.name + "*")))


if __name__ == "__main__":
    unittest.main()
