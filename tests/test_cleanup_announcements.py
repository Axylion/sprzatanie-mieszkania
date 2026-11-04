import base64
from datetime import datetime, timezone
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('cleanup', ROOT / 'scripts/cleanup-announcements.py')
cleanup = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(cleanup)


def instant(value):
    return datetime.fromisoformat(value.replace('Z', '+00:00'))


def item(id, expires=None, **extra):
    result = {'id': id, 'title': 'Tytuł ' + id, 'body': 'Polska treść 🏠',
              'publishedAt': '2026-01-01T12:00:00+01:00', **extra}
    if expires is not None:
        result['expiresAt'] = expires
    return result


class RetentionTests(unittest.TestCase):
    def test_29_days_kept_30_days_removed(self):
        entry = item('old', '2026-11-16T00:00:00+01:00')
        for now in ['2026-12-15T00:00:00+01:00', '2026-12-15T23:59:59.999+01:00']:
            self.assertEqual(cleanup.filter_announcements([entry], instant(now)), ([entry], []))
        self.assertEqual(cleanup.filter_announcements([entry], instant('2026-12-16T00:00:00+01:00')), ([], ['old']))

    def test_warsaw_calendar_not_720_hours_in_spring(self):
        self.assertEqual(cleanup.deletion_instant('2026-02-28T12:00:00+01:00'), instant('2026-03-30T10:00:00Z'))
        entry = item('spring', '2026-02-28T12:00:00+01:00')
        self.assertEqual(cleanup.filter_announcements([entry], instant('2026-03-30T09:59:59Z')), ([entry], []))
        self.assertEqual(cleanup.filter_announcements([entry], instant('2026-03-30T10:00:00Z')), ([], ['spring']))

    def test_warsaw_calendar_not_720_hours_in_autumn(self):
        self.assertEqual(cleanup.deletion_instant('2026-10-01T12:00:00+02:00'), instant('2026-10-31T11:00:00Z'))
        entry = item('autumn', '2026-10-01T12:00:00+02:00')
        self.assertEqual(cleanup.filter_announcements([entry], instant('2026-10-31T10:00:00Z')), ([entry], []))

    def test_retention_boundary_in_dst_gap_or_overlap_is_conservative(self):
        self.assertEqual(cleanup.deletion_instant('2026-02-27T02:30:00+01:00'), instant('2026-03-29T01:30:00Z'))
        self.assertEqual(cleanup.deletion_instant('2026-09-25T02:30:00+02:00'), instant('2026-10-25T01:30:00Z'))

    def test_date_only_is_valid_through_end_of_warsaw_day(self):
        self.assertEqual(cleanup.expiry_instant('2026-11-15'), instant('2026-11-15T23:00:00Z'))
        self.assertEqual(cleanup.deletion_instant('2026-11-15'), instant('2026-12-15T23:00:00Z'))
        self.assertEqual(cleanup.expiry_instant('2026-03-29'), instant('2026-03-29T22:00:00Z'))
        self.assertEqual(cleanup.expiry_instant('2026-10-25'), instant('2026-10-25T23:00:00Z'))

    def test_local_and_explicit_offsets_match_browser(self):
        for value in ['2026-11-05T00:00:02','2026-11-05T00:00:02+01:00',
                      '2026-11-04T23:00:02Z','2026-11-05T08:00:02+09:00']:
            self.assertEqual(cleanup.expiry_instant(value), instant('2026-11-04T23:00:02Z'))
        self.assertEqual(cleanup.expiry_instant('2026-10-25T02:30'), instant('2026-10-25T00:30:00Z'))
        self.assertEqual(cleanup.expiry_instant('2026-07-01T12:30:00.125'), instant('2026-07-01T10:30:00.125Z'))

    def test_invalid_dates_are_kept_and_logged(self):
        values = ['bad','',123,False,{},[], '2026-02-30', '2026-11-04T24:00',
                  '2026-03-29T02:30', '2026-11-04T12:00:00+25:00', '2026-11-04T12:00:00+01:99']
        entries = [item(str(i), value) for i, value in enumerate(values)]
        with self.assertLogs(cleanup.LOG, level='WARNING') as logs:
            self.assertEqual(cleanup.filter_announcements(entries, instant('2099-01-01T00:00:00Z')), (entries, []))
        self.assertEqual(len(logs.output), len(values))

    def test_missing_or_null_expiry_never_removed(self):
        entries = [item('forever'), {**item('null'), 'expiresAt':None}]
        self.assertEqual(cleanup.filter_announcements(entries, instant('2099-01-01T00:00:00Z')), (entries, []))

    def test_preserves_order_ids_and_all_other_fields(self):
        entries = [item('forever', custom={'numbers':[1,2], 'polski':'żółty'}),
                   item('remove','2026-01-01T00:00:00Z'),
                   item('recent','2026-11-01T00:00:00+01:00'),
                   item('future','2027-01-01T00:00:00+01:00')]
        kept, removed = cleanup.filter_announcements(entries, instant('2026-11-04T12:00:00Z'))
        self.assertEqual(kept, [entries[0],entries[2],entries[3]])
        self.assertEqual(removed, ['remove'])
        self.assertIs(kept[0],entries[0])

    def test_malformed_records_are_kept_and_logged(self):
        entries = [None, 42, 'bad', {'expiresAt':'2026-01-01'}]
        with self.assertLogs(cleanup.LOG, level='WARNING'):
            self.assertEqual(cleanup.filter_announcements(entries, instant('2026-11-04T12:00:00Z')), (entries,[]))

    def test_file_noop_is_byte_for_byte_identical(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/'announcements.json'
            original = '[  {"id":"permanent", "body":"ą"}  ]'
            path.write_text(original)
            before = path.stat().st_mtime_ns
            self.assertEqual(cleanup.cleanup_file(path, instant('2026-11-04T12:00:00Z')), [])
            self.assertEqual(path.read_text(),original)
            self.assertEqual(path.stat().st_mtime_ns,before)

    def test_file_cleanup_produces_valid_json_and_is_idempotent(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/'announcements.json'
            retained = item('keep', custom={'test':[True,None,'ą']})
            path.write_text(json.dumps([item('old','2026-01-01'),retained]))
            self.assertEqual(cleanup.cleanup_file(path, instant('2026-11-04T12:00:00Z')), ['old'])
            self.assertEqual(json.loads(path.read_text()),[retained])
            output = path.read_bytes()
            self.assertEqual(cleanup.cleanup_file(path, instant('2026-11-04T12:00:00Z')), [])
            self.assertEqual(path.read_bytes(),output)

    def test_bad_json_or_structure_never_overwrites_original(self):
        for content in ['{bad', '{}', '[{"id":"a","expiresAt":"2026-01-01","expiresAt":"2099-01-01"}]', '[NaN]']:
            with self.subTest(content=content), tempfile.TemporaryDirectory() as directory:
                path=Path(directory)/'announcements.json'
                path.write_text(content)
                with self.assertRaises(ValueError):
                    cleanup.cleanup_file(path,instant('2026-11-04T12:00:00Z'))
                self.assertEqual(path.read_text(),content)

    def test_failed_atomic_replace_leaves_original_and_cleans_temp_file(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'announcements.json'
            content=json.dumps([item('old','2026-01-01')])
            path.write_text(content)
            with patch.object(Path,'replace',side_effect=OSError('write failure')):
                with self.assertRaises(OSError):
                    cleanup.cleanup_file(path,instant('2026-11-04T12:00:00Z'))
            self.assertEqual(path.read_text(),content)
            self.assertEqual(list(Path(directory).iterdir()),[path])

    def test_cli_reports_error_and_returns_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'bad.json'
            path.write_text('{bad')
            result=subprocess.run(['python3',str(ROOT/'scripts/cleanup-announcements.py'),'--file',str(path)],capture_output=True,text=True)
            self.assertNotEqual(result.returncode,0)
            self.assertIn('ERROR',result.stderr)
            self.assertEqual(path.read_text(),'{bad')


class PublicationTests(unittest.TestCase):
    def setUp(self):
        self.directory=tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.work=Path(self.directory.name)
        def git(*args):
            return subprocess.check_output(['git',*args],cwd=self.work,text=True,stderr=subprocess.DEVNULL).strip()
        self.git=git
        git('init','-b','main')
        git('config','user.name','Test')
        git('config','user.email','test@example.invalid')
        self.original=[item('old','2026-01-01'),item('keep')]
        (self.work/'announcements.json').write_text(json.dumps(self.original))
        git('add','announcements.json')
        git('commit','-m','Initial test data')
        self.sha=git('rev-parse','HEAD:announcements.json')
        self.bin=self.work/'bin'
        self.bin.mkdir()
        gh=self.bin/'gh'
        gh.write_text('''#!/usr/bin/env python3
import json,os,sys
from pathlib import Path
payload=json.loads(Path(sys.argv[sys.argv.index('--input')+1]).read_text())
Path(os.environ['CALL_RECORD']).write_text(json.dumps({'args':sys.argv[1:],'payload':payload}))
sys.exit(int(os.environ.get('GH_STUB_EXIT','0')))
''')
        gh.chmod(0o755)
        self.output=self.work/'output'
        self.record=self.work/'record'
        self.env={**os.environ,'PATH':str(self.bin)+os.pathsep+os.environ['PATH'],
                  'GITHUB_OUTPUT':str(self.output),'GITHUB_REPOSITORY':'Axylion/sprzatanie-mieszkania',
                  'CALL_RECORD':str(self.record)}

    def publish(self):
        return subprocess.run(['bash',str(ROOT/'scripts/publish-announcements.sh')],cwd=self.work,env=self.env,capture_output=True,text=True)

    def test_no_change_makes_no_api_request_or_commit(self):
        head=self.git('rev-parse','HEAD')
        result=self.publish()
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertFalse(self.record.exists())
        self.assertEqual(self.output.read_text(),'changed=false\n')
        self.assertEqual(self.git('rev-parse','HEAD'),head)

    def test_only_json_is_published_with_original_sha_for_conflict_protection(self):
        cleanup.cleanup_file(self.work/'announcements.json',instant('2026-11-04T12:00:00Z'))
        (self.work/'unrelated.txt').write_text('Must never be included')
        result=self.publish()
        self.assertEqual(result.returncode,0,result.stderr)
        record=json.loads(self.record.read_text())
        self.assertEqual(record['args'][:4],['api','--method','PUT','repos/Axylion/sprzatanie-mieszkania/contents/announcements.json'])
        self.assertEqual(record['payload']['sha'],self.sha)
        self.assertEqual(record['payload']['branch'],'main')
        self.assertEqual(json.loads(base64.b64decode(record['payload']['content'])),[self.original[1]])
        self.assertEqual(self.output.read_text(),'changed=true\n')

    def test_api_conflict_fails_without_claiming_publication_or_retrying(self):
        cleanup.cleanup_file(self.work/'announcements.json',instant('2026-11-04T12:00:00Z'))
        self.env['GH_STUB_EXIT']='1'
        result=self.publish()
        self.assertNotEqual(result.returncode,0)
        self.assertFalse(self.output.exists())
        self.assertEqual(json.loads(self.record.read_text())['payload']['sha'],self.sha)


if __name__ == '__main__':
    unittest.main()
