#!/usr/bin/env python3
"""Private, read-only-until-connected remote PTY/log endpoint. Python stdlib only."""
import argparse
import base64
import binascii
from collections import deque
import codecs
from datetime import datetime, timezone
import errno
import fcntl
import json
import os
from pathlib import Path
import re
import selectors
import signal
import stat
import sys
import tempfile
import termios
import time
import tty

MAX_DATA = 64 * 1024
MAX_LINE = 128 * 1024
MAX_QUEUE = 256 * 1024
LOG_LIMIT = 5 * 1024 * 1024


def timestamp():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def private_open(path, flags):
    fd = os.open(path, flags | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid():
        os.close(fd)
        raise ValueError("Runtime file must be a regular file owned by this user")
    os.fchmod(fd, 0o600)
    return fd


class RingLog:
    """At most three files including the active file; never follow a log symlink."""
    def __init__(self, path, limit):
        self.path = Path(path)
        self.limit = limit
        self.fd = private_open(self.path, os.O_WRONLY | os.O_CREAT | os.O_APPEND)
        self.size = os.fstat(self.fd).st_size

    def write(self, data):
        view = memoryview(data)
        while view:
            if self.size >= self.limit:
                self.rotate()
            part = view[:self.limit - self.size]
            count = os.write(self.fd, part)
            if count <= 0:
                raise OSError("Unable to append serial log")
            self.size += count
            view = view[count:]

    def rotate(self):
        os.close(self.fd)
        self.fd = -1
        old = Path(str(self.path) + ".1")
        if os.path.lexists(old):
            os.replace(old, str(self.path) + ".2")
        os.replace(self.path, old)
        self.fd = private_open(self.path, os.O_WRONLY | os.O_CREAT | os.O_APPEND)
        self.size = 0

    def close(self):
        if self.fd >= 0:
            os.close(self.fd)
            self.fd = -1


class RemoteBridge:
    def __init__(self, args):
        self.args = args
        self.directory = Path(os.path.abspath(os.path.expanduser(args.directory)))
        if self.directory == Path(self.directory.anchor) or self.directory == Path.home().resolve():
            raise ValueError("Use a dedicated runtime subdirectory, not the filesystem root or home directory")
        self.port = self.directory / args.name
        slug = args.name[3:] if args.name.lower().startswith("tty") else args.name
        self.log = self.directory / ("t3-ch340-460800.log" if args.name == "ttyT3" else "serial-" + args.name + ".log")
        self.raw = Path(str(self.log) + ".raw")
        self.events = self.directory / (self.log.stem + ".events.jsonl")
        self.status = self.directory / (args.name + ".status.json")
        self.owner_metadata = self.directory / ("." + args.name + ".owner.json")
        self.metadata_identity = None
        self.master = self.slave = self.lock = -1
        self.selector = None
        self.logs = []
        self.owned_links = []
        self.running = True
        self.connected = False
        self.baud = args.baud
        self.last_error = None
        self.counters = {"rx_bytes": 0, "tx_bytes": 0, "pty_requested_bytes": 0,
                         "dropped_pty_bytes": 0, "dropped_rx_bytes": 0, "dropped_pty_rx_bytes": 0}
        self.input = bytearray()
        self.to_pty = bytearray()
        self.output = deque()
        self.output_size = 0
        self.request_id = 0
        self.decoder = codecs.getincrementaldecoder("utf-8")("replace")
        self.last_status = 0.0
        self.last_peer_heartbeat = None
        self.last_heartbeat_id = None
        self.connected_since = None
        self.exit_code = 0
        self.status_owned = False
        try:
            self.setup()
        except BaseException:
            self.close()
            raise

    def setup(self):
        self.directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        info = self.directory.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid():
            raise ValueError("Log directory must be a real directory owned by this user")
        os.chmod(self.directory, 0o700)
        self.lock = private_open(self.directory / ("." + self.log.stem + ".lock"), os.O_RDWR | os.O_CREAT)
        try:
            fcntl.flock(self.lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ValueError("This virtual port mapping is already running") from None
        self.recover_owned_links()
        self.master, self.slave = os.openpty()
        tty.setraw(self.slave)
        os.fchmod(self.slave, 0o600)
        os.set_blocking(self.master, False)
        target = os.ttyname(self.slave)
        self.make_link(self.port, target)
        self.dev_alias = None
        if self.args.dev_alias:
            alias = Path("/dev") / self.args.name
            try:
                self.make_link(alias, target)
                self.dev_alias = str(alias)
            except OSError as error:
                print("Optional /dev alias unavailable: " + str(error), file=sys.stderr, flush=True)
        for path in (self.log, self.raw, self.events):
            self.logs.append(RingLog(path, self.args.log_limit))
        self.text_log, self.raw_log, self.event_log = self.logs
        os.set_blocking(0, False)
        os.set_blocking(1, False)
        self.selector = selectors.DefaultSelector()
        self.selector.register(0, selectors.EVENT_READ, "stdin")
        self.status_owned = True
        self.write_status()
        self.queue_json({"type": "ready", "port": str(self.port), "log": str(self.log),
                         "status": str(self.status), "raw": str(self.raw), "events": str(self.events),
                         "dev_alias": self.dev_alias})

    def make_link(self, path, target):
        # Never replace an existing file/link, even if its target looks stale.
        os.symlink(target, path)
        info = path.lstat()
        self.owned_links.append((path, target, info.st_dev, info.st_ino))
        self.save_owned_links()

    def recover_owned_links(self):
        try:
            fd = private_open(self.owner_metadata, os.O_RDONLY)
        except FileNotFoundError:
            return
        with os.fdopen(fd, "rb") as stream:
            raw = stream.read(65537)
        if len(raw) > 65536:
            raise ValueError("Ownership metadata exceeds its size limit")
        record = json.loads(raw)
        if not isinstance(record, dict) or not isinstance(record.get("links"), list) or len(record["links"]) > 2:
            raise ValueError("Invalid virtual port ownership metadata")
        allowed = {str(self.port), str(Path("/dev") / self.args.name)}
        for link in record["links"]:
            if not isinstance(link, dict) or link.get("path") not in allowed:
                raise ValueError("Ownership metadata contains an unexpected link path")
            if not isinstance(link.get("target"), str) or type(link.get("device")) is not int or type(link.get("inode")) is not int:
                raise ValueError("Invalid recorded link identity")
            path = Path(link["path"])
            try:
                info = path.lstat()
                if stat.S_ISLNK(info.st_mode) and (info.st_dev, info.st_ino) == (link["device"], link["inode"]) and os.readlink(path) == link["target"]:
                    path.unlink()
            except FileNotFoundError:
                pass
            except PermissionError:
                if path == self.port:
                    raise
                print("Unable to reclaim optional /dev alias", file=sys.stderr, flush=True)

    def save_owned_links(self):
        record = {"version": 1, "pid": os.getpid(), "links": [
            {"path": str(path), "target": target, "device": device, "inode": inode}
            for path, target, device, inode in self.owned_links]}
        fd, temporary = tempfile.mkstemp(prefix="." + self.args.name + ".owner-", dir=self.directory)
        try:
            with os.fdopen(fd, "wb") as stream:
                stream.write(json.dumps(record).encode() + b"\n")
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, self.owner_metadata)
            info = self.owner_metadata.lstat()
            self.metadata_identity = (info.st_dev, info.st_ino)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)

    def queue_json(self, message):
        data = json.dumps(message, ensure_ascii=True, separators=(",", ":")).encode() + b"\n"
        if self.output_size + len(data) > MAX_QUEUE:
            raise RuntimeError("Remote stdout backpressure limit exceeded; stopping without replay")
        self.output.append([message["type"], data, 0])
        self.output_size += len(data)

    def report_error(self, message):
        self.last_error = str(message)[:300]
        self.queue_json({"type": "error", "message": self.last_error})

    def write_status(self, final=False):
        now = time.time()
        value = {"connected": self.connected and not final, "running": not final,
                 "baud": self.baud, "updated_at": timestamp(), "updated_at_unix": now,
                 "last_seen": now,
                 "peer_heartbeat_age": None if self.last_peer_heartbeat is None else max(0.0, time.monotonic() - self.last_peer_heartbeat),
                 "last_heartbeat_id": self.last_heartbeat_id,
                 "port": str(self.port), "log": str(self.log),
                 "raw": str(self.raw), "events": str(self.events), "pid": os.getpid(),
                 "counters": dict(self.counters), "rx_bytes": self.counters["rx_bytes"],
                 "tx_bytes": self.counters["tx_bytes"], "pending_pty_bytes": len(self.to_pty),
                 "pending_output_bytes": self.output_size, "last_error": self.last_error}
        fd, temporary = tempfile.mkstemp(prefix="." + self.args.name + ".status-", dir=self.directory)
        try:
            with os.fdopen(fd, "wb") as stream:
                stream.write(json.dumps(value, ensure_ascii=True).encode() + b"\n")
            os.replace(temporary, self.status)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
        self.last_status = time.monotonic()

    def interest(self, fd, events, label):
        try:
            key = self.selector.get_key(fd)
        except KeyError:
            if events:
                self.selector.register(fd, events, label)
        else:
            if events:
                if key.events != events:
                    self.selector.modify(fd, events, label)
            else:
                self.selector.unregister(fd)

    def check_lease(self):
        if self.connected_since is not None:
            anchor = max(self.connected_since, self.last_peer_heartbeat or self.connected_since)
            if time.monotonic() - anchor >= self.args.lease_seconds:
                self.connected = False
                self.running = False
                self.exit_code = 1
                self.to_pty.clear()
                self.drop_unwritten_requests()
                self.report_error("Peer heartbeat lease expired; virtual port closed without replay")
                self.write_status(final=True)
                self.flush_stdout()  # Nonblocking: a stalled tunnel cannot delay cleanup.
                return False
        return True

    def drop_unwritten_requests(self):
        kept = deque(frame for frame in self.output if frame[0] != "write" or frame[2] != 0)
        self.output = kept
        self.output_size = sum(len(frame[1]) - frame[2] for frame in kept)

    def run(self):
        while self.running:
            if not self.check_lease():
                break
            # Leave headroom for one complete PTY chunk/base64 frame.
            events = selectors.EVENT_READ if not self.connected or self.output_size < MAX_QUEUE - MAX_DATA else 0
            if self.to_pty:
                events |= selectors.EVENT_WRITE
            self.interest(self.master, events, "pty")
            self.interest(1, selectors.EVENT_WRITE if self.output else 0, "stdout")
            for key, mask in self.selector.select(timeout=0.2):
                if not self.running or not self.check_lease():
                    break
                if key.data == "stdin":
                    self.read_stdin()
                elif key.data == "stdout":
                    self.flush_stdout()
                else:
                    if mask & selectors.EVENT_READ:
                        self.read_pty()
                    if mask & selectors.EVENT_WRITE and self.to_pty:
                        self.flush_pty()
            if time.monotonic() - self.last_status >= 1:
                self.write_status()
        return self.exit_code

    def read_stdin(self):
        try:
            data = os.read(0, 65536)
        except BlockingIOError:
            return
        if not data:
            self.running = False
            return
        self.input.extend(data)
        while b"\n" in self.input and self.running:
            if not self.check_lease():
                break
            line, _, rest = self.input.partition(b"\n")
            self.input = bytearray(rest)
            if len(line) > MAX_LINE:
                raise ValueError("Input JSON line exceeds framing limit")
            try:
                message = json.loads(line)
                self.handle_message(message)
            except (ValueError, TypeError, binascii.Error) as error:
                self.report_error(error)
        if len(self.input) > MAX_LINE:
            raise ValueError("Input JSON line exceeds framing limit")

    @staticmethod
    def decode_payload(message):
        encoded = message.get("data")
        if not isinstance(encoded, str) or len(encoded) > (MAX_DATA + 2) // 3 * 4:
            raise ValueError("data must be base64 text containing at most 65536 bytes")
        try:
            data = base64.b64decode(encoded, validate=True)
        except (ValueError, binascii.Error):
            raise ValueError("data must contain valid base64") from None
        if len(data) > MAX_DATA:
            raise ValueError("Decoded payload exceeds 65536 bytes")
        return data

    def handle_message(self, message):
        if not isinstance(message, dict) or not isinstance(message.get("type"), str):
            raise ValueError("Message must be a JSON object with a string type")
        kind = message["type"]
        if kind == "stop":
            self.running = False
        elif kind == "heartbeat":
            identifier = message.get("id")
            if not isinstance(identifier, str) or not identifier or len(identifier) > 128:
                raise ValueError("heartbeat requires a nonempty id of at most 128 characters")
            self.last_peer_heartbeat = time.monotonic()
            self.last_heartbeat_id = identifier
            self.write_status()
        elif kind == "state":
            connected, baud = message.get("connected"), message.get("baud", self.baud)
            if type(connected) is not bool or type(baud) is not int or not 0 < baud <= 20_000_000:
                raise ValueError("state requires boolean connected and a positive integer baud")
            # Drain bytes that arrived while offline before enabling the next session.
            if not self.connected or not connected:
                self.discard_pty()
                termios.tcflush(self.slave, termios.TCIOFLUSH)
            if self.connected and not connected:
                tail = self.decoder.decode(b"", final=True)
                if tail:
                    self.text_log.write(tail.encode("utf-8"))
                self.decoder = codecs.getincrementaldecoder("utf-8")("replace")
            if connected and self.connected_since is None:
                self.connected_since = time.monotonic()
            self.connected, self.baud = connected, baud
            if connected and not self.check_lease():
                return
            if not connected:
                self.to_pty.clear()
                self.drop_unwritten_requests()
            self.write_status()
        elif kind == "rx":
            data = self.decode_payload(message)
            if not self.connected:
                self.counters["dropped_rx_bytes"] += len(data)
                return
            self.raw_log.write(data)
            text = self.decoder.decode(data)
            if text:
                self.text_log.write(text.encode("utf-8"))
            self.counters["rx_bytes"] += len(data)
            self.to_pty.extend(data)
            excess = len(self.to_pty) - MAX_QUEUE
            if excess > 0:
                # The PTY is a single-consumer live view, not the durable capture.
                # A missing/slow consumer must not stop the complete text/raw logs.
                if self.counters["dropped_pty_rx_bytes"] == 0:
                    self.last_error = "PTY reader is behind; use log/raw capture for complete RX history"
                    print(self.last_error, file=sys.stderr, flush=True)
                self.counters["dropped_pty_rx_bytes"] += excess
                del self.to_pty[:excess]
        elif kind == "tx":
            data = self.decode_payload(message)
            self.counters["tx_bytes"] += len(data)
            event = {"type": "tx", "updated_at": timestamp(), "baud": self.baud,
                     "data": base64.b64encode(data).decode("ascii")}
            self.event_log.write(json.dumps(event, separators=(",", ":")).encode() + b"\n")
        else:
            raise ValueError("Unknown message type")

    def discard_pty(self):
        budget = MAX_QUEUE
        while budget > 0:
            try:
                data = os.read(self.master, min(16384, budget))
                if not data:
                    break
                self.counters["dropped_pty_bytes"] += len(data)
                budget -= len(data)
            except BlockingIOError:
                break
            except OSError as error:
                if error.errno == errno.EIO:
                    break
                raise

    def read_pty(self):
        if not self.check_lease():
            return
        # A terminal program may run stty sane after opening the slave. Reassert
        # raw/no-echo on both directions so RX is never mistaken for board TX.
        tty.setraw(self.slave, termios.TCSANOW)
        try:
            data = os.read(self.master, 16384)
        except BlockingIOError:
            return
        if not data:
            raise RuntimeError("Virtual terminal closed")
        if not self.connected:
            self.counters["dropped_pty_bytes"] += len(data)
            return
        self.request_id += 1
        self.queue_json({"type": "write", "data": base64.b64encode(data).decode("ascii"),
                         "id": "remote-" + str(self.request_id),
                         "last_heartbeat_id": self.last_heartbeat_id})
        self.counters["pty_requested_bytes"] += len(data)

    def flush_pty(self):
        tty.setraw(self.slave, termios.TCSANOW)
        try:
            count = os.write(self.master, self.to_pty)
            del self.to_pty[:count]
        except BlockingIOError:
            pass

    def flush_stdout(self):
        budget = 65536
        while self.output and budget > 0:
            frame = self.output[0]
            try:
                count = os.write(1, memoryview(frame[1])[frame[2]:frame[2] + budget])
            except BlockingIOError:
                return
            if count <= 0:
                raise BrokenPipeError("Protocol output closed")
            frame[2] += count
            self.output_size -= count
            budget -= count
            if frame[2] == len(frame[1]):
                self.output.popleft()

    def close(self):
        self.connected = False
        self.to_pty.clear()
        if self.logs:
            tail = self.decoder.decode(b"", final=True)
            if tail:
                try:
                    self.logs[0].write(tail.encode())
                except OSError:
                    pass
        if self.status_owned:
            try:
                self.write_status(final=True)
            except OSError:
                pass
        if self.selector:
            self.selector.close()
        for path, target, device, inode in reversed(self.owned_links):
            try:
                info = path.lstat()
                if stat.S_ISLNK(info.st_mode) and (info.st_dev, info.st_ino) == (device, inode) and os.readlink(path) == target:
                    path.unlink()
            except FileNotFoundError:
                pass
        if self.metadata_identity is not None:
            try:
                info = self.owner_metadata.lstat()
                if (info.st_dev, info.st_ino) == self.metadata_identity:
                    self.owner_metadata.unlink()
            except FileNotFoundError:
                pass
        for log in self.logs:
            log.close()
        for fd in (self.master, self.slave, self.lock):
            if fd >= 0:
                os.close(fd)
        self.master = self.slave = self.lock = -1


def arguments():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", default="/workspace/.serial-logs")
    parser.add_argument("--name", default="ttyT3")
    parser.add_argument("--baud", type=int, default=460800)
    parser.add_argument("--dev-alias", action="store_true")
    parser.add_argument("--lease-seconds", type=float, default=8.0, help=argparse.SUPPRESS)
    parser.add_argument("--log-limit", type=int, default=LOG_LIMIT, help=argparse.SUPPRESS)
    args = parser.parse_args()
    if not re.fullmatch(r"[A-Za-z][A-Za-z0-9_-]{0,63}", args.name):
        parser.error("name must be a short identifier without path separators")
    if not 0 < args.baud <= 20_000_000 or not 256 <= args.log_limit <= LOG_LIMIT or not 0.1 <= args.lease_seconds <= 60:
        parser.error("invalid baud or log limit")
    return args


def main():
    bridge = None
    try:
        bridge = RemoteBridge(arguments())
        def stop(_signal, _frame):
            bridge.running = False
        signal.signal(signal.SIGTERM, stop)
        signal.signal(signal.SIGINT, stop)
        return bridge.run()
    except (OSError, ValueError, RuntimeError) as error:
        if bridge:
            bridge.last_error = str(error)[:300]
        payload = json.dumps({"type": "error", "message": str(error)[:300]}).encode() + b"\n"
        try:
            os.write(1, payload)
        except OSError:
            pass
        return 1
    finally:
        if bridge:
            bridge.close()


if __name__ == "__main__":
    sys.exit(main())
