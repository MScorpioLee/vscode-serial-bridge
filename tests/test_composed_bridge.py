import base64
import json
import os
from pathlib import Path
import select
import subprocess
import sys
import tempfile
import time
import unittest

ROOT=Path(__file__).resolve().parents[1]

class ComposedBridgeTest(unittest.TestCase):
    def test_actual_helpers_binary_duplex_and_cleanup(self):
        master,slave=os.openpty()
        with tempfile.TemporaryDirectory() as runtime:
            env=dict(os.environ,BRIDGE_PYTHON=sys.executable,BRIDGE_RUNTIME=runtime,BRIDGE_PORT=os.ttyname(slave))
            process=subprocess.Popen(['node',str(ROOT/'tests/integration_harness.js')],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,env=env)
            try:
                port=None
                limit=time.monotonic()+8
                while time.monotonic()<limit:
                    ready,_,_=select.select([process.stdout],[],[],2)
                    if not ready: continue
                    line=process.stdout.readline()
                    if not line: self.fail(process.stderr.read().decode())
                    message=json.loads(line)
                    if message.get('phase')=='error' or 'error' in message: self.fail(str(message))
                    if message.get('phase')=='connected':
                        port=message['remote']['port'];break
                self.assertIsNotNone(port)
                fd=os.open(port,os.O_RDWR|os.O_NONBLOCK|os.O_NOCTTY)
                try:
                    payload=bytes(range(256))+b'\xe4\xbd\xa0\xe5\xa5\xbd\r\n'
                    os.write(master,payload)
                    received=bytearray()
                    end=time.monotonic()+4
                    while len(received)<len(payload) and time.monotonic()<end:
                        if select.select([fd],[],[],.2)[0]: received.extend(os.read(fd,4096))
                    self.assertEqual(bytes(received),payload)
                    reply=b'\0\xffremote command\r\n'+bytes(range(256))
                    os.write(fd,reply)
                    received=bytearray()
                    end=time.monotonic()+4
                    while len(received)<len(reply) and time.monotonic()<end:
                        if select.select([master],[],[],.2)[0]: received.extend(os.read(master,4096))
                    self.assertEqual(bytes(received),reply)
                    deadline=time.monotonic()+3
                    while time.monotonic()<deadline:
                        status=json.loads((Path(runtime)/'ttyTest.status.json').read_text())
                        if status['tx_bytes']==len(reply):break
                        time.sleep(.05)
                    self.assertEqual(status['rx_bytes'],len(payload))
                    self.assertEqual(status['tx_bytes'],len(reply))
                    self.assertTrue(status['connected'])
                    self.assertEqual((Path(runtime)/'serial-ttyTest.log.raw').read_bytes(),payload)
                finally: os.close(fd)
                process.stdin.write(b'stop\n');process.stdin.flush()
                process.wait(timeout=4)
                self.assertEqual(process.returncode,0,process.stderr.read().decode())
                self.assertFalse(os.path.lexists(port))
                self.assertFalse(json.loads((Path(runtime)/'ttyTest.status.json').read_text())['connected'])
            finally:
                if process.poll() is None:process.terminate();process.wait(timeout=3)
                process.stdin.close();process.stdout.close();process.stderr.close()
        os.close(slave);os.close(master)

if __name__=='__main__':unittest.main()
