import importlib.util
from pathlib import Path
import unittest
spec=importlib.util.spec_from_file_location('list_probes',Path(__file__).parents[1]/'helpers/list_probes.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
class ProbeDescriptorTests(unittest.TestCase):
    def test_nested_probe_is_not_mistaken_for_parent_hub(self):
        probe={'idVendor':0x2e88,'idProduct':0x4604,'USB Product Name':'DAPLink CMSIS_DAP','USB Serial Number':'TEST-PROBE'}
        hub={'idVendor':0x05ac,'idProduct':0x800b,'USB Product Name':'USB Hub','USB Serial Number':'TEST-HUB','IORegistryEntryChildren':[probe]}
        self.assertEqual([p['uid'] for p in module.scan([hub])],['TEST-PROBE'])
    def test_interface_descriptor_finds_generic_probe_but_not_plain_uart(self):
        probe={'idVendor':1,'idProduct':2,'USB Product Name':'Debug Adapter','USB Serial Number':'TEST-PROBE','IORegistryEntryChildren':[{'IORegistryEntryName':'CMSIS-DAP'}]}
        uart={'idVendor':3,'idProduct':4,'USB Product Name':'USB Serial','USB Serial Number':'TEST-UART'}
        self.assertEqual([p['uid'] for p in module.scan([probe,uart])],['TEST-PROBE'])
