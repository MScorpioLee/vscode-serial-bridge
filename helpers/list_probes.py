"""Descriptor-only macOS CMSIS-DAP discovery. Never uses a debug-probe driver."""
import json
import plistlib
import subprocess


def scan(nodes):
    result = []
    def names(node):
        yield str(node.get('IORegistryEntryName', ''))
        yield str(node.get('USB Product Name', ''))
        for child in node.get('IORegistryEntryChildren', []):
            if 'idVendor' not in child or 'idProduct' not in child:
                yield from names(child)
    def visit(node):
        if 'idVendor' in node and 'idProduct' in node:
            product = str(node.get('USB Product Name') or node.get('IORegistryEntryName') or '')
            identifiers = ' '.join(names(node)).lower().replace('_', '-').replace(' ', '-')
            uid = node.get('USB Serial Number')
            if isinstance(uid, str) and uid and ('cmsis-dap' in identifiers or 'daplink' in identifiers):
                result.append({'uid': uid, 'label': product.replace('_', '-') or 'CMSIS-DAP', 'vid': node['idVendor'], 'pid': node['idProduct']})
        for child in node.get('IORegistryEntryChildren', []):
            visit(child)
    for node in nodes:
        visit(node)
    return sorted({item['uid']: item for item in result}.values(), key=lambda item:item['uid'])

if __name__ == '__main__':
    data = subprocess.check_output(['ioreg', '-a', '-r', '-c', 'IOUSBHostDevice'], timeout=5)
    print(json.dumps(scan(plistlib.loads(data)), ensure_ascii=True))
