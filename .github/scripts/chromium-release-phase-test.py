#!/usr/bin/env python3
"""Linux safety controls for build transport, using tiny owned fake builds."""
import json
import os
from pathlib import Path
import runpy
import signal
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

MODULE = runpy.run_path(str(Path(__file__).with_name('chromium-release-phase.py')))


@unittest.skipUnless(sys.platform == 'linux', 'Live /proc and process-group checks require Linux')
class BuildPhaseControls(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='chromium-phase-controls-')
        self.root = Path(self.temp.name)
        self.src = self.root/'src'
        self.ev = self.root/'evidence'
        self.bin = self.root/'bin'
        for p in [self.src/'out/Paired', self.ev, self.bin]:
            p.mkdir(parents=True)
        self.env = patch.dict(os.environ, {
            'CHROMIUM_SRC':str(self.src),'EVIDENCE_DIR':str(self.ev),
            'RUNNER_TEMP':str(self.root),'GITHUB_OUTPUT':str(self.root/'output'),
            'CHROMIUM_DEADLINE':str(int(time.time())+10000),
            'PATH':str(self.bin)+':'+os.environ['PATH']})
        self.env.start()

    def tearDown(self):
        self.env.stop()
        self.temp.cleanup()

    def fake(self, code):
        p=self.bin/'autoninja'
        p.write_text('#!'+sys.executable+'\n'+code)
        p.chmod(0o755)

    def test_completed_binaries_are_not_runtime_qualification(self):
        self.fake("from pathlib import Path\n"
                  "for n in ['chrome','content_browsertests']:\n"
                  " p=Path('out/Paired')/n;p.write_text('fixture');p.chmod(0o755)\n"
                  "print('Build Succeeded: 2 steps')\n")
        MODULE['main']()
        d=json.loads((self.ev/'phase-result.json').read_text())
        self.assertEqual(d['status'],'binaries-built-not-qualified')
        self.assertFalse(d['runtimeQualified'])
        self.assertFalse(d['securityPolicyQualified'])

    def test_compiler_failure_does_not_produce_checkpoint_ready_result(self):
        self.fake("import sys\nprint('Build Failure: 0 done, 1 failed, 1 remaining')\nsys.exit(7)\n")
        with self.assertRaisesRegex(AssertionError, 'Actual compiler/build failure'):
            MODULE['main']()
        self.assertFalse((self.ev/'phase-result.json').exists())

    def test_budget_expiry_is_incomplete_after_clean_shutdown(self):
        self.fake("import signal,time,sys\n"
                  "def stop(*args):\n print('Build Failure: 1 done, 0 failed, 1 remaining',flush=True);sys.exit(0)\n"
                  "signal.signal(signal.SIGTERM,stop)\nwhile True:time.sleep(.1)\n")
        MODULE['main'](max_seconds=1, min_seconds=1)
        d=json.loads((self.ev/'phase-result.json').read_text())
        self.assertEqual(d['status'],'incomplete-build-progress')
        self.assertTrue(d['budgetExpired'])
        self.assertFalse(json.loads((self.ev/'stopped-build-processes.json').read_text())['survivingOwned'])

    def test_detached_writer_prevents_checkpoint_result(self):
        self.fake("import subprocess,sys\nfrom pathlib import Path\n"
                  "p=subprocess.Popen([sys.executable,'-c','import time;time.sleep(90)'],start_new_session=True)\n"
                  "Path('owned-child').write_text(str(p.pid))\n"
                  "for n in ['chrome','content_browsertests']:\n"
                  " q=Path('out/Paired')/n;q.write_text('fixture');q.chmod(0o755)\n"
                  "print('Build Succeeded: 0 steps')\n")
        try:
            with self.assertRaisesRegex(AssertionError, 'not proven stopped/flushed'):
                MODULE['main']()
            self.assertFalse((self.ev/'phase-result.json').exists())
            proof=json.loads((self.ev/'stopped-build-processes.json').read_text())
            self.assertTrue(proof['survivingOwned'] or proof['newSourceCwdProcesses'])
        finally:
            p=self.src/'owned-child'
            if p.exists():
                pid=int(p.read_text())
                try:
                    cmd=Path('/proc',str(pid),'cmdline').read_bytes()
                    if b'time.sleep(90)' in cmd:
                        os.kill(pid,signal.SIGTERM)
                except ProcessLookupError:
                    pass


if __name__ == '__main__':
    unittest.main()
