#!/usr/bin/env python3
"""POSIX serial owner. stdout is exclusively the documented NDJSON protocol.

pySerial configures the UART; nonblocking POSIX writes let each tx acknowledge
exactly the prefix the driver accepted, even if a later write fails. One select
loop services input, RX, TX and output concurrently, with bounded queues.
"""
import argparse
import base64
import binascii
from collections import deque
import errno
import fcntl
import json
import os
import re
import select
import signal
import sys
import termios
import time

MAX_PENDING = 4 * 1024 * 1024
MAX_OUTPUT = 4 * 1024 * 1024
MAX_LINE = 6 * 1024 * 1024
CHUNK = 16384


def frame(message):
    return (json.dumps(message, separators=(",", ":"), ensure_ascii=True) + "\n").encode("ascii")


class ProtocolArgumentParser(argparse.ArgumentParser):
    def error(self, message):
        raise ValueError(message)


def arguments(argv):
    parser = ProtocolArgumentParser(description=__doc__)
    parser.add_argument("--list", action="store_true")
    parser.add_argument("--port")
    parser.add_argument("--baud", type=int, default=460800)
    parser.add_argument("--data-bits", type=int, choices=[5, 6, 7, 8], default=8)
    parser.add_argument("--stop-bits", type=float, choices=[1, 1.5, 2], default=1)
    parser.add_argument("--parity", choices=["none", "even", "odd", "mark", "space"], default="none")
    parser.add_argument("--flow-control", choices=["none", "hardware", "software"], default="none")
    args = parser.parse_args(argv)
    if not args.list:
        if not args.port or "\x00" in args.port:
            raise ValueError("--port is required and must be a valid device path")
        if not 0 < args.baud <= 2147483647:
            raise ValueError("baud must be a positive 32-bit integer")
    return args


def list_devices():
    from serial.tools import list_ports
    result = []
    for port in list_ports.comports():
        product = port.product or port.description or port.name or "Serial port"
        chip = {(0x1A86, 0x7523): "CH340", (0x1A86, 0x5523): "CH341",
                (0x10C4, 0xEA60): "CP210x"}.get((port.vid, port.pid))
        if chip is None:
            match = re.search(r"CH34[0-9]|CH91[0-9][0-9]|CP210[0-9X]?|FT232", product, re.I)
            chip = match.group(0).upper() if match else "USB Serial" if port.vid is not None else "Serial"
        name = chip if product.lower() in ["usb serial", "usb2.0-serial", "n/a"] else f"{chip} · {product}"
        result.append({"device": port.device, "name": name, "label": f"串口 · {name}", "product": product, "chip": chip,
                       "vid": port.vid, "pid": port.pid, "serial_number": port.serial_number})
    return sorted(result, key=lambda item: (item["device"].casefold(), item["device"]))


def open_serial(args):
    import serial

    class NoResetSerial(serial.Serial):
        # pySerial 3.5's open() otherwise forces its initial DTR/RTS state. Do not
        # pulse or force either line; hardware RTS flow, if requested, is kernel-owned.
        # A USB driver may itself change modem lines on open; software cannot promise
        # that every adapter preserves electrical state across open/close.
        def _reconfigure_port(self, force_update=False):
            # Acquire before touching termios; super() takes this same lock again.
            fcntl.flock(self.fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            # Darwin stores a standard placeholder in termios for IOSSIOSPEED
            # rates. Any tcsetattr after pySerial applies the custom rate would
            # overwrite it, so HUPCL must be cleared before that final operation.
            attrs = termios.tcgetattr(self.fd)
            if attrs[2] & termios.HUPCL:
                attrs[2] &= ~termios.HUPCL
                termios.tcsetattr(self.fd, termios.TCSANOW, attrs)
            super()._reconfigure_port(force_update=force_update)

        def _update_dtr_state(self):
            pass

        def _update_rts_state(self):
            pass

    port = NoResetSerial(port=None, baudrate=args.baud, bytesize=args.data_bits,
                         stopbits=args.stop_bits,
                         parity={"none": "N", "even": "E", "odd": "O", "mark": "M", "space": "S"}[args.parity],
                         xonxoff=args.flow_control == "software",
                         rtscts=args.flow_control == "hardware", dsrdtr=False,
                         timeout=0, write_timeout=0, exclusive=True)
    port.port = args.port
    exclusive = False
    try:
        port.open()
        # flock covers cooperating owners; TIOCEXCL also rejects other tty opens.
        fcntl.ioctl(port.fileno(), termios.TIOCEXCL)
        exclusive = True
        return port
    except Exception as error:
        if port.is_open and exclusive:
            try:
                fcntl.ioctl(port.fileno(), termios.TIOCNXCL)
            except OSError:
                pass
        try:
            port.close()
        except OSError:
            pass
        raise RuntimeError(f"Cannot open/configure serial port at {args.baud} baud: {error}") from error


class Bridge:
    def __init__(self, port):
        self.port = port
        self.fd = port.fileno()
        self.running = True
        self.exit_code = 0
        self.drain_deadline = None
        self.incoming = bytearray()
        self.pending = deque()
        self.pending_size = 0
        self.output = deque()
        self.output_size = 0

    def emit(self, event):
        data = frame(event)
        self.output.append(memoryview(data))
        self.output_size += len(data)

    def stop(self):
        self.running = False
        self.drain_deadline = time.monotonic() + 2

    def fail(self, error):
        if self.exit_code:
            return
        self.exit_code = 1
        message = str(error) or type(error).__name__
        if self.pending_size:
            message += f"; {self.pending_size} queued bytes were not written"
        self.emit({"type": "error", "message": message})
        print(message, file=sys.stderr, flush=True)
        self.stop()

    def command(self, command):
        if not isinstance(command, dict):
            raise ValueError("protocol message must be an object")
        if command.get("type") == "stop":
            self.stop()
            return
        if command.get("type") == "state":
            return
        if command.get("type") != "write":
            raise ValueError("unsupported protocol message type")
        identifier = command.get("id")
        if not isinstance(identifier, str) or len(identifier) > 256:
            raise ValueError("write id must be a string of at most 256 characters")
        encoded = command.get("data")
        if not isinstance(encoded, str):
            raise ValueError("write data must be base64 text")
        try:
            data = base64.b64decode(encoded, validate=True)
        except (ValueError, binascii.Error) as error:
            raise ValueError("invalid base64 write data") from error
        if not data:
            raise ValueError("write data must not be empty")
        if len(data) > MAX_PENDING - self.pending_size:
            raise ValueError("serial write queue limit exceeded (4 MiB)")
        self.pending.append((memoryview(data), identifier))
        self.pending_size += len(data)

    def read_commands(self):
        chunk = os.read(sys.stdin.fileno(), 65536)
        if not chunk:
            if self.incoming:
                raise ValueError("stdin ended in an incomplete protocol frame")
            self.stop()
            return
        self.incoming.extend(chunk)
        while self.running:
            newline = self.incoming.find(b"\n")
            if newline < 0:
                if len(self.incoming) > MAX_LINE:
                    raise ValueError("protocol frame limit exceeded (6 MiB)")
                return
            if newline > MAX_LINE:
                raise ValueError("protocol frame limit exceeded (6 MiB)")
            line = bytes(self.incoming[:newline])
            del self.incoming[:newline + 1]
            self.command(json.loads(line))

    def read_serial(self):
        data = os.read(self.fd, CHUNK)
        if not data:
            raise OSError("serial device disconnected")
        self.emit({"type": "rx", "data": base64.b64encode(data).decode("ascii")})

    def write_serial(self):
        data, identifier = self.pending[0]
        count = os.write(self.fd, data[:CHUNK])
        if not count:
            raise OSError("serial write accepted zero bytes")
        self.pending_size -= count
        self.emit({"type": "tx", "data": base64.b64encode(data[:count]).decode("ascii"), "id": identifier})
        if count == len(data):
            self.pending.popleft()
        else:
            self.pending[0] = (data[count:], identifier)

    def write_output(self):
        data = self.output[0]
        count = os.write(sys.stdout.fileno(), data)
        if not count:
            raise BrokenPipeError("protocol output closed")
        self.output_size -= count
        if count == len(data):
            self.output.popleft()
        else:
            self.output[0] = data[count:]

    def run(self):
        os.set_blocking(sys.stdin.fileno(), False)
        os.set_blocking(sys.stdout.fileno(), False)
        self.emit({"type": "ready"})
        signal.signal(signal.SIGTERM, lambda *_: self.stop())
        signal.signal(signal.SIGINT, lambda *_: self.stop())
        while self.running or self.output:
            if not self.running and time.monotonic() > self.drain_deadline:
                print("protocol output did not drain before shutdown", file=sys.stderr, flush=True)
                return 1
            # Pause ingress and UART writes when protocol output is backed up.
            capacity = self.output_size < MAX_OUTPUT - 4 * CHUNK
            reads = [sys.stdin.fileno(), self.fd] if self.running and capacity else []
            writes = [sys.stdout.fileno()] if self.output else []
            if self.running and capacity and self.pending:
                writes.append(self.fd)
            try:
                readable, writable, _ = select.select(reads, writes, [], 0.1)
                if sys.stdout.fileno() in writable:
                    self.write_output()
                if self.running and sys.stdin.fileno() in readable:
                    self.read_commands()
                if self.running and self.fd in readable:
                    self.read_serial()
                if self.running and self.fd in writable and self.pending:
                    self.write_serial()
            except (BrokenPipeError, ConnectionResetError):
                print("protocol output disconnected", file=sys.stderr, flush=True)
                return 1
            except OSError as error:
                if error.errno not in [errno.EAGAIN, errno.EWOULDBLOCK, errno.EINTR]:
                    self.fail(error)
            except (ValueError, TypeError, OverflowError, RecursionError) as error:
                self.fail(error)
        return self.exit_code


def main(argv=None):
    port = None
    try:
        args = arguments(argv)
        if args.list:
            print(json.dumps(list_devices(), ensure_ascii=True))
            return 0
        port = open_serial(args)
        return Bridge(port).run()
    except Exception as error:
        message = str(error) or type(error).__name__
        try:
            sys.stdout.buffer.write(frame({"type": "error", "message": message}))
            sys.stdout.buffer.flush()
        except (BrokenPipeError, OSError):
            pass
        print(message, file=sys.stderr, flush=True)
        return 1
    finally:
        if port is not None:
            try:
                fcntl.ioctl(port.fileno(), termios.TIOCNXCL)
            except OSError:
                pass
            port.close()


if __name__ == "__main__":
    raise SystemExit(main())
