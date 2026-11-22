"""Optional native-PostgreSQL concurrency probes. Uses ONLY a private /tmp Unix socket.
No Supabase URL, credentials, HTTP calls, real endpoints, or push transport.
Example: G19_NATIVE_PSQL=/path/to/psql G19_NATIVE_SOCKET=/tmp/g19-... python3 scripts/test_private_concurrency.py
"""
import concurrent.futures
import json
import os
from pathlib import Path
import select
import subprocess
import uuid

psql = os.environ['G19_NATIVE_PSQL']
socket = Path(os.environ['G19_NATIVE_SOCKET']).resolve()
assert str(socket).startswith('/tmp/g19-') and socket.is_dir()
assert socket.stat().st_uid == os.getuid() and socket.stat().st_mode & 0o077 == 0
name = 'g19_test_' + uuid.uuid4().hex
root = Path(__file__).resolve().parents[1]
base = [psql, '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', str(socket)]
environment = dict(os.environ, PGCONNECT_TIMEOUT='3', PGAPPNAME='g19-isolated-test')
for key in ['PGHOST', 'PGHOSTADDR', 'PGDATABASE', 'PGSERVICE', 'PGSERVICEFILE', 'PGPASSWORD', 'PGUSER', 'PGOPTIONS', 'PGPASSFILE']:
    environment.pop(key, None)

def command(sql, database=name, check=True):
    result = subprocess.run(base + ['-d', database], input=sql, text=True, capture_output=True,
                            timeout=15, env=environment)
    if check and result.returncode:
        raise AssertionError(result.stderr)
    return result

def q(value):
    if value is None:
        return 'null'
    return "'" + str(value).replace("'", "''") + "'"

def rpc(method, *args):
    return 'select public.g19_' + method + '(' + ','.join(q(v) for v in args) + ');'

def value(sql):
    return command(sql).stdout.strip().splitlines()[-1]

def data(sql):
    return json.loads(value(sql))

def parallel(actor_b, statement_b, statement_a):
    # B holds its actor lock first; A then enters the same conversation while B
    # is briefly paused. Old FOR UPDATE locks deadlock on the peer-device FK.
    script = ('begin;set local role anon;do $guard$ begin perform public.g19_my_devices(' + q(actor_b) + ',null,null);end $guard$;' +
              '\n\\echo G19_ACTOR_LOCKED\nselect pg_sleep(0.35);' + statement_b + '\ncommit;')
    b = subprocess.Popen(base + ['-d', name], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                         stderr=subprocess.PIPE, text=True, env=environment)
    b.stdin.write(script)
    b.stdin.close()
    b.stdin = None
    try:
        while True:
            assert select.select([b.stdout], [], [], 5)[0], 'Actor-lock barrier timed out'
            line = b.stdout.readline()
            assert line, 'Worker exited before barrier'
            if line.strip() == 'G19_ACTOR_LOCKED':
                break
        a = command('set role anon;' + statement_a, check=False)
        _, error_b = b.communicate(timeout=12)
        return [a.returncode, b.returncode], a.stderr + error_b
    finally:
        if b.poll() is None:
            b.kill()
            b.wait()

# Verify the actual server too, not just a potentially symlinked socket path.
server_dir = Path(command('show data_directory;', database='postgres').stdout.strip()).resolve()
assert str(server_dir).startswith('/tmp/g19-') and server_dir.stat().st_uid == os.getuid()
assert server_dir.stat().st_mode & 0o077 == 0
assert command('show listen_addresses;', database='postgres').stdout.strip() == ''
command('create database ' + name + ';', database='postgres')
try:
    command("""do $$begin
      if not exists(select 1 from pg_roles where rolname='anon') then create role anon;end if;
      if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated;end if;
      if not exists(select 1 from pg_roles where rolname='service_role') then create role service_role bypassrls;end if;
    end $$;
    create schema auth;create table auth.users(id uuid primary key);
    create table auth.sessions(id uuid primary key,user_id uuid references auth.users,created_at timestamptz not null default now());
    create function auth.jwt() returns jsonb language sql as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
    create function auth.uid() returns uuid language sql as $$select (auth.jwt()->>'sub')::uuid$$;""")
    for migration in sorted((root / 'supabase/migrations').glob('*.sql')):
        source = migration.read_text()
        # PostgreSQL roles belong to the cluster, not the fresh test database.
        # Reusing this private test cluster must not change production SQL files.
        if migration.name == '202611130008_device_revocation_audit.sql':
            source = source.replace('create role g19_room_admin nologin;',
                "do $$begin if not exists(select 1 from pg_roles where rolname='g19_room_admin') then create role g19_room_admin nologin;end if;end $$;")
        command(source)
    command('update g19_private.private_chat_settings set enabled=true where singleton;')
    tokens = {}
    for room in [1, 2, 3, 4]:
        tokens[room] = data(rpc('bind', room, uuid.uuid4().hex * 2, uuid.uuid4().hex * 2))['token']

    def peer_period(actor, peer):
        return next(i['peerPeriod'] for i in data(rpc('private_list', actor))['items'] if i['room'] == peer)

    def send(actor, peer, body='Local concurrency fixture'):
        return rpc('private_send', actor, peer, peer_period(actor, peer), uuid.uuid4(), body, None)

    def free_rate():
        command('update g19_private.devices set next_message_at=null where next_message_at is not null;')

    conversation = data(send(tokens[1], 2))['conversation']
    fixed = command(
        "select pg_get_functiondef('g19_private.lock_device(text)'::regprocedure);").stdout.strip()
    assert 'for no key update' in fixed
    command(fixed.replace('for no key update', 'for update'))
    free_rate()
    old_codes, old_errors = parallel(tokens[2], send(tokens[2], 1), send(tokens[1], 2))
    assert any(old_codes) and 'deadlock detected' in old_errors, 'Old-lock regression was not reproduced'
    command(fixed)
    free_rate()
    count_before = int(value('select count(*) from g19_private.private_messages;'))
    codes, errors = parallel(tokens[2], send(tokens[2], 1), send(tokens[1], 2))
    assert codes == [0, 0], errors
    assert int(value('select count(*) from g19_private.private_messages;')) == count_before + 2

    # Multiple devices in one room can read all dialogs concurrently, in a
    # deterministic cursor order; neither session needs another device's lock.
    pairing = data(rpc('pair_start', 2, uuid.uuid4().hex * 2))
    command(rpc('pair_decide', tokens[2], pairing['code'], 'true'))
    roommate = data(rpc('pair_claim', pairing['secret']))['token']
    for peer in [3, 4]:
        free_rate()
        command(send(tokens[peer], 2))
    read_all = lambda token: rpc('notification_read_v2', token, None, '{messages}')
    codes, errors = parallel(roommate, read_all(roommate), read_all(tokens[2]))
    assert codes == [0, 0], errors
    assert data(rpc('private_list', tokens[2]))['unread'] == 0

    # A release holds the target room lock; the waiting old-context send must
    # fail after the release commits instead of reaching a new resident.
    free_rate()
    expected = peer_period(tokens[2], 1)
    generation = value('select generation from g19_private.rooms where room=1;')
    release = ('begin;do $guard$ begin perform public.g19_admin_change_resident(1,' + generation + ',1);end $guard$;' +
               '\n\\echo G19_RELEASED\nselect pg_sleep(0.35);commit;')
    process = subprocess.Popen(base + ['-d', name], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE, text=True, env=environment)
    process.stdin.write(release)
    process.stdin.close()
    process.stdin = None
    try:
        while True:
            assert select.select([process.stdout], [], [], 5)[0]
            line = process.stdout.readline()
            assert line
            if line.strip() == 'G19_RELEASED':
                break
        result = command('set role anon;' + rpc('private_send', tokens[2], 1, expected, uuid.uuid4(), 'Must not cross a residency boundary', None), check=False)
        _, release_error = process.communicate(timeout=10)
        assert process.returncode == 0, release_error
        assert result.returncode and 'private_context_changed' in result.stderr
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()
    assert data(rpc('private_read', tokens[2], conversation, None, None))['readOnly']
    print(json.dumps({'postgres': value('show server_version;'), 'oldDeadlockReproduced': True,
                      'simultaneousSendsPassed': True, 'simultaneousReadAllPassed': True,
                      'releaseSendRaceBlocked': True, 'survivorArchiveReadable': True}))
finally:
    command('drop database ' + name + ' with(force);', database='postgres')
