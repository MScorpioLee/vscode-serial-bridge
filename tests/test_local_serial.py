import base64
import json
import importlib.util
import os
import pathlib
import select
import subprocess
import sys
import termios
import time
import unittest
from unittest.mock import patch
from types import SimpleNamespace

HELPER = pathlib.Path(__file__).resolve().parents[1] / "helpers" / "local_serial.py"


class LocalSerialTests(unittest.TestCase):
    def setUp(self):
        self.master, slave = os.openpty()
        self.path = os.ttyname(slave)
        os.close(slave)
        os.set_blocking(self.master, False)
        self.children = []
        self.buffers = {}

    def tearDown(self):
        for child in self.children:
            if child.poll() is None:
                child.stdin.close()
                try:
                    child.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait()
            for stream in [child.stdin, child.stdout, child.stderr]:
                stream.close()
        if self.master is not None:
            os.close(self.master)

    def start(self, *extra, baud=115200):
        child = subprocess.Popen([sys.executable, str(HELPER), "--port", self.path,
                                  "--baud", str(baud), *extra], stdin=subprocess.PIPE,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.children.append(child)
        self.buffers[child] = bytearray()
        return child

    def event(self, child, timeout=3):
        deadline = time.monotonic() + timeout
        buffer = self.buffers[child]
        while b"\n" not in buffer:
            remaining = deadline - time.monotonic()
            self.assertGreater(remaining, 0, "No helper event received")
            readable, _, _ = select.select([child.stdout], [], [], remaining)
            self.assertTrue(readable, "No helper event received")
            chunk = os.read(child.stdout.fileno(), 65536)
            if not chunk:
                self.fail("Helper exited before event: " + child.stderr.read().decode())
            buffer.extend(chunk)
        line, _, rest = buffer.partition(b"\n")
        buffer[:] = rest
        return json.loads(line)

    def command(self, child, command):
        child.stdin.write(json.dumps(command).encode() + b"\n")
        child.stdin.flush()

    def ready(self, child):
        event = self.event(child)
        self.assertEqual(event["type"], "ready", event)

    def test_binary_duplex_and_accurate_write_id(self):
        child = self.start()
        self.ready(child)
        payload = bytes(range(256)) * 4
        rx = bytearray()
        # A nonblocking PTY master can accept fewer than 1024 input bytes on macOS.
        for offset in range(0, len(payload), 256):
            chunk = payload[offset:offset + 256]
            self.assertEqual(os.write(self.master, chunk), len(chunk))
            while len(rx) < offset + len(chunk):
                event = self.event(child)
                self.assertEqual(event["type"], "rx", event)
                rx.extend(base64.b64decode(event["data"]))
        self.assertEqual(rx, payload)
        self.command(child, {"type": "write", "data": base64.b64encode(payload).decode(), "id": "binary-1"})
        ack = bytearray()
        while len(ack) < len(payload):
            event = self.event(child)
            self.assertEqual(event["type"], "tx", event)
            self.assertEqual(event["id"], "binary-1")
            ack.extend(base64.b64decode(event["data"]))
        self.assertEqual(ack, payload)
        result = bytearray()
        while len(result) < len(payload):
            readable, _, _ = select.select([self.master], [], [], 3)
            self.assertTrue(readable)
            result.extend(os.read(self.master, 4096))
        self.assertEqual(result, payload)
        self.command(child, {"type": "stop"})
        self.assertEqual(child.wait(timeout=3), 0)

    def test_partial_ack_before_whole_buffer_can_drain(self):
        child = self.start()
        self.ready(child)
        payload = bytes(range(251)) * 4096
        self.command(child, {"type": "write", "data": base64.b64encode(payload).decode(), "id": "partial"})
        event = self.event(child)
        self.assertEqual(event["type"], "tx", event)
        prefix = base64.b64decode(event["data"])
        self.assertGreater(len(prefix), 0)
        self.assertLess(len(prefix), len(payload))
        self.assertEqual(prefix, payload[:len(prefix)])
        self.assertEqual(event["id"], "partial")

    def test_unplug_exits_with_protocol_error_reason(self):
        child = self.start()
        self.ready(child)
        os.close(self.master)
        self.master = None
        event = self.event(child)
        self.assertEqual(event["type"], "error", event)
        self.assertTrue(event["message"])
        self.assertNotEqual(child.wait(timeout=3), 0)
        self.assertTrue(child.stderr.read())

    def test_state_notification_is_ignored_and_stop_is_clean(self):
        child = self.start()
        self.ready(child)
        self.command(child, {"type": "state", "connected": False})
        self.command(child, {"type": "stop"})
        self.assertEqual(child.wait(timeout=3), 0)

    @unittest.skipUnless(sys.platform == "darwin", "Darwin PTYs do not implement IOSSIOSPEED")
    def test_unsupported_custom_baud_keeps_reason_and_releases_lock(self):
        child = self.start(baud=123457)
        event = self.event(child)
        self.assertEqual(event["type"], "error", event)
        self.assertIn("123457", event["message"])
        self.assertNotEqual(child.wait(timeout=3), 0)
        replacement = self.start()
        self.ready(replacement)

    def test_large_write_acknowledgements_equal_bytes_read_from_master(self):
        child = self.start()
        self.ready(child)
        payload = bytes(range(251)) * 1024
        self.command(child, {"type": "write", "data": base64.b64encode(payload).decode(), "id": "large"})
        accepted = bytearray()
        received = bytearray()
        deadline = time.monotonic() + 5
        while len(accepted) < len(payload) or len(received) < len(payload):
            self.assertLess(time.monotonic(), deadline)
            ready, _, _ = select.select([self.master, child.stdout], [], [], 0.1)
            if self.master in ready:
                received.extend(os.read(self.master, 65536))
            if child.stdout in ready or b"\n" in self.buffers[child]:
                event = self.event(child)
                self.assertEqual(event["type"], "tx", event)
                self.assertEqual(event["id"], "large")
                accepted.extend(base64.b64decode(event["data"]))
        self.assertEqual(accepted, payload)
        self.assertEqual(received, payload)

    def test_exclusive_lock_and_reopen_after_eof(self):
        first = self.start()
        self.ready(first)
        second = self.start()
        self.assertEqual(self.event(second)["type"], "error")
        self.assertNotEqual(second.wait(timeout=3), 0)
        first.stdin.close()
        self.assertEqual(first.wait(timeout=3), 0)
        third = self.start()
        self.ready(third)

    def test_bad_base64_is_error_and_not_written(self):
        child = self.start()
        self.ready(child)
        self.command(child, {"type": "write", "data": "##not-base64##", "id": "bad"})
        event = self.event(child)
        self.assertEqual(event["type"], "error", event)
        self.assertTrue(event["message"])
        self.assertNotEqual(child.wait(timeout=3), 0)
        self.assertFalse(select.select([self.master], [], [], 0)[0] and self._read_available())

    def _read_available(self):
        try:
            return os.read(self.master, 4096)
        except OSError:
            return b""

    def test_invalid_settings_fail_before_ready(self):
        child = self.start("--data-bits", "9")
        self.assertEqual(self.event(child)["type"], "error")
        self.assertNotEqual(child.wait(timeout=3), 0)

    def test_queue_limit_reports_failure(self):
        child = self.start()
        self.ready(child)
        payload = base64.b64encode(b"Z" * (4 * 1024 * 1024 + 1)).decode()
        self.command(child, {"type": "write", "data": payload, "id": "too-large"})
        event = self.event(child, timeout=8)
        self.assertEqual(event["type"], "error", event)
        self.assertIn("queue", event["message"].lower())
        self.assertNotEqual(child.wait(timeout=3), 0)


class LocalConfigurationTests(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location("local_serial_under_test", HELPER)
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)

    def test_custom_baud_is_applied_after_hupcl_without_dtr_rts_updates(self):
        import serial
        calls = []

        class FakeSerial:
            def __init__(self, **kwargs):
                self.fd = 42
                self.baudrate = kwargs["baudrate"]
                self.is_open = False

            def open(self):
                self._reconfigure_port(force_update=True)
                self._update_dtr_state()
                self._update_rts_state()
                self.is_open = True

            def _reconfigure_port(self, force_update=False):
                calls.append(("apply_custom_baud", self.baudrate))

            def _update_dtr_state(self):
                calls.append(("forced_dtr",))

            def _update_rts_state(self):
                calls.append(("forced_rts",))

            def fileno(self):
                return self.fd

            def close(self):
                self.is_open = False

        args = self.module.arguments(["--port", "/unused-test-port", "--baud", "460800"])
        with patch.object(serial, "Serial", FakeSerial), \
             patch.object(self.module.fcntl, "flock", side_effect=lambda *a: calls.append(("flock",))), \
             patch.object(self.module.fcntl, "ioctl", side_effect=lambda *a: calls.append(("exclusive",))), \
             patch.object(self.module.termios, "tcgetattr", return_value=[0, 0, termios.HUPCL, 0, 9600, 9600, []]), \
             patch.object(self.module.termios, "tcsetattr", side_effect=lambda *a: calls.append(("set_termios",))):
            port = self.module.open_serial(args)
        self.assertEqual(port.baudrate, 460800)
        self.assertEqual(calls, [("flock",), ("set_termios",), ("apply_custom_baud", 460800), ("exclusive",)])

    def test_enumeration_is_sorted_friendly_and_does_not_open_devices(self):
        from serial.tools import list_ports
        ports = [SimpleNamespace(device="/dev/cu.z", product="USB2.0-Serial", description="", name="z",
                                 vid=0x1a86, pid=0x7523, serial_number="test-z"),
                 SimpleNamespace(device="/dev/cu.a", product="CP2102", description="", name="a",
                                 vid=0x10c4, pid=0xea60, serial_number="test-a")]
        with patch.object(list_ports, "comports", return_value=ports), \
             patch.object(self.module, "open_serial", side_effect=AssertionError("Enumeration must never open a port")):
            result = self.module.list_devices()
        self.assertEqual([item["device"] for item in result], ["/dev/cu.a", "/dev/cu.z"])
        self.assertIn("CP210", result[0]["label"])
        self.assertEqual(result[1]["chip"], "CH340")
        self.assertNotIn("/dev/", result[1]["label"])
        self.assertEqual(result[1]["vid"], 0x1a86)


if __name__ == "__main__":
    unittest.main()
