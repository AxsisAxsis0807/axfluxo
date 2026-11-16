"""Offline allowlist tests; fake media is never accepted as render evidence."""
import json, os, shutil, subprocess, tempfile, unittest
from pathlib import Path
SAMPLE=Path(__file__).with_name('sample.py').resolve()
class Allowlist(unittest.TestCase):
    def test_values_and_secrets(self):
        for value in ['true','false','TRUE','1','yes','']:
            with self.subTest(value=value), tempfile.TemporaryDirectory(prefix='av-v3-test-') as tmp:
                root=Path(tmp); fixture=root/'baseline.mjs'
                fixture.write_text('console.log(JSON.stringify({flag:process.env.VIDEO_RENDER_STATIC_COMPOSITE,secret:process.env.AUDIT_TEST_SECRET,options:process.env.NODE_OPTIONS}))')
                env=dict(os.environ, VIDEO_RENDER_STATIC_COMPOSITE=value,AUDIT_TEST_SECRET='must-not-propagate',NODE_OPTIONS='--max-old-space-size=96')
                out=root/'result'
                r=subprocess.run(['python3',str(SAMPLE),str(out),'--',shutil.which('node'),str(fixture)],env=env,capture_output=True,text=True)
                if value not in ['true','false']:
                    self.assertNotEqual(r.returncode,0); self.assertFalse((out/'stdout.jsonl').exists())
                else:
                    self.assertEqual(r.returncode,0,r.stderr)
                    result=json.loads((out/'stdout.jsonl').read_text())
                    self.assertEqual(result,dict(flag=value,options='--max-old-space-size=128'))
                    self.assertEqual(json.loads((out/'effective-env.json').read_text())['VIDEO_RENDER_STATIC_COMPOSITE'],value)
    def test_inline_rejected(self):
        with tempfile.TemporaryDirectory(prefix='av-v3-test-') as tmp:
            r=subprocess.run(['python3',str(SAMPLE),str(Path(tmp)/'result'),'--','node','-e','baseline.mjs'],capture_output=True)
            self.assertNotEqual(r.returncode,0)
if __name__=='__main__': unittest.main()
