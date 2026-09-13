#!/usr/bin/env python3
"""Disposable real-image tests. No host ports or existing volumes are used.

Build containers/mariadb as ragnarokmac/mariadb:11.4, then run this script.
All subprocess output is captured; failures deliberately omit SQL/credentials.
"""
import os
from pathlib import Path
import secrets
import subprocess
import tempfile
import time

IMAGE = os.environ.get('RO_TEST_DB_IMAGE', 'ragnarokmac/mariadb:11.4')
PREFIX = 'ro-db-secret-test-' + secrets.token_hex(6)
containers = []
volumes = []


def docker(*args, data=None, check=True):
    result = subprocess.run(['docker', *args], input=data, text=True,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=120)
    if check and result.returncode:
        raise RuntimeError('Docker test operation failed: ' + args[0] + ' (output suppressed).')
    return result


def assert_safe(condition, reason):
    if not condition:
        raise RuntimeError(reason)


def option_file(path, user, password):
    # MariaDB option-file escaping is separate from SQL literal escaping.
    escaped = password.replace('\\', '\\\\').replace('"', '\\"')
    path.write_text('[client]\nuser=' + user + '\npassword="' + escaped + '"\n')
    path.chmod(0o600)


def sql(name, filename, query, success=True, tcp=False):
    args = ['exec', '-i', name, 'mariadb',
            '--defaults-extra-file=/run/test-secrets/' + filename]
    if tcp:
        args += ['--protocol=TCP', '-h127.0.0.1']
    result = docker(*args, '--batch', '--skip-column-names', data=query, check=False)
    if success:
        assert_safe(result.returncode == 0, 'Expected database credentials were rejected.')
    else:
        assert_safe(result.returncode != 0, 'Unexpected database credentials were accepted.')
    return result.stdout.strip()


def start(label, directory, env, volume=None, init_dir=None):
    name = PREFIX + '-' + label
    if volume is None:
        volume = name
        docker('volume', 'create', volume)
        volumes.append(volume)
    containers.append(name)
    # Test-only ptrace capability permits reading our mysqld /proc environment
    # after its uid drop. Production containers do not receive this capability.
    args = ['run', '-d', '--name', name, '--network', 'none', '--cap-add', 'SYS_PTRACE', '-v', volume + ':/var/lib/mysql',
            '-v', str(directory) + ':/run/test-secrets:ro']
    if init_dir is not None:
        args += ['-v', str(init_dir) + ':/docker-entrypoint-initdb.d:ro']
    for key, value in env.items():
        args += ['-e', key + '=' + value]
    docker(*args, IMAGE)
    return name, volume


def wait_ready(name):
    until = time.monotonic() + 90
    while time.monotonic() < until:
        # Use TCP so the private, half-initialised socket cannot pass readiness.
        result = docker('exec', '-i', name, 'mariadb',
                        '--defaults-extra-file=/run/test-secrets/root.cnf',
                        '--protocol=TCP', '-h127.0.0.1', '--batch', '--skip-column-names',
                        data='SELECT 1;', check=False)
        if result.returncode == 0 and result.stdout.strip() == '1':
            return
        if docker('inspect', '-f', '{{.State.Running}}', name).stdout.strip() != 'true':
            raise RuntimeError('Database exited before readiness (logs suppressed).')
        time.sleep(0.5)
    raise RuntimeError('Database readiness timed out (logs suppressed).')


def wait_failed(name):
    until = time.monotonic() + 90
    while time.monotonic() < until:
        result = docker('inspect', '-f', '{{.State.Running}} {{.State.ExitCode}}', name)
        running, code = result.stdout.strip().split()
        if running == 'false':
            assert_safe(code != '0', 'Invalid bootstrap unexpectedly succeeded.')
            return
        time.sleep(0.5)
    raise RuntimeError('Invalid bootstrap did not fail closed.')


def check_no_secret_output(name, passwords):
    # Only inspect processes belonging to our UUID-named disposable container.
    output = docker('logs', name)
    captured = output.stdout + output.stderr
    inspected = docker('inspect', name).stdout
    processes = docker('top', name, '-eo', 'pid,args').stdout
    environment = docker('exec', name, 'sh', '-c', 'cat /proc/1/environ').stdout
    # Include unique suffixes so SQL/option-file escaping cannot hide leakage.
    passwords = passwords + [password[-33:-1] for password in passwords]
    for password in passwords:
        assert_safe(password not in captured + inspected + processes + environment,
                    'A credential appeared in container metadata, logs or process state.')
    assert_safe('MARIADB_ROOT_PASSWORD=' not in environment and 'MARIADB_PASSWORD=' not in environment,
                'Password environment variables reached the database process.')


def main():
    with tempfile.TemporaryDirectory(prefix=PREFIX) as temp:
        directory = Path(temp)
        # SQL metacharacters, backslashes, quotes, shell syntax and edge spaces
        # must survive unchanged without running SQL or shell instructions.
        root = " Root'\\\";$(false)#" + secrets.token_hex(16) + ' '
        app = " App'\\\";-- " + secrets.token_hex(16) + ' '
        for file, value in [('root.secret', root), ('app.secret', app),
                            ('changed.secret', secrets.token_hex(24)), ('empty.secret', ''),
                            ('newline.secret', 'password\n'), ('nul.secret', 'pass\0word')]:
            (directory / file).write_text(value)
            (directory / file).chmod(0o600)
        option_file(directory / 'root.cnf', 'root', root)
        option_file(directory / 'app.cnf', 'ro_app', app)
        option_file(directory / 'wrong.cnf', 'root', 'ragnarok')
        env = {'MARIADB_ROOT_PASSWORD_FILE': '/run/test-secrets/root.secret',
               'MARIADB_PASSWORD_FILE': '/run/test-secrets/app.secret',
               'MARIADB_DATABASE': 'ro_test', 'MARIADB_USER': 'ro_app'}
        name, volume = start('fresh', directory, env)
        wait_ready(name)
        sql(name, 'wrong.cnf', 'SELECT 1;', success=False, tcp=True)
        sql(name, 'app.cnf', 'CREATE TABLE ro_test.retained (id INT PRIMARY KEY); INSERT INTO ro_test.retained VALUES (42);', tcp=True)
        assert_safe(sql(name, 'root.cnf', 'SELECT COUNT(*) FROM mysql.user WHERE User=\'ro_app\';') == '1',
                    'Application database account was not created exactly once.')
        check_no_secret_output(name, [root, app])
        docker('stop', '-t', '30', name)
        assert_safe(docker('inspect', '-f', '{{.State.ExitCode}}', name).stdout.strip() == '0',
                    'Database did not shut down cleanly.')
        docker('rm', name)
        name, _ = start('existing', directory,
                        {**env, 'MARIADB_ROOT_PASSWORD_FILE': '/run/test-secrets/changed.secret',
                         'MARIADB_PASSWORD_FILE': '/run/test-secrets/changed.secret'}, volume)
        wait_ready(name)
        assert_safe(sql(name, 'app.cnf', 'SELECT id FROM ro_test.retained;', tcp=True) == '42',
                    'Restart modified existing data or credentials.')
        check_no_secret_output(name, [root, app])
        print('PASS: private-file initialization, exact password authentication, clean restart and retained data')

        # Legacy unset defaults still work; explicit empty values do not select
        # the known fallback. Test non-secret default only through env/argv.
        legacy = directory / 'legacy'
        legacy.mkdir(mode=0o700)
        option_file(legacy / 'root.cnf', 'root', 'ragnarok')
        name, _ = start('legacy', legacy, {})
        wait_ready(name)
        assert_safe(sql(name, 'root.cnf', "SELECT COUNT(*) FROM mysql.user WHERE User='ragnarok';") == '1',
                    'Legacy default initialization failed.')
        print('PASS: backward-compatible local bootstrap')

        for label, invalid in [
            ('both', {**env, 'MARIADB_ROOT_PASSWORD': 'unused-test-value'}),
            ('empty', {**env, 'MARIADB_PASSWORD_FILE': '/run/test-secrets/empty.secret'}),
            ('newline', {**env, 'MARIADB_PASSWORD_FILE': '/run/test-secrets/newline.secret'}),
            ('nul', {**env, 'MARIADB_PASSWORD_FILE': '/run/test-secrets/nul.secret'}),
            ('missing', {**env, 'MARIADB_PASSWORD_FILE': '/run/test-secrets/absent.secret'}),
            ('identifier', {**env, 'MARIADB_DATABASE': 'invalid`; DROP DATABASE mysql;--'}),
            ('empty-value', {'MARIADB_PASSWORD': ''}),
            ('empty-file-path', {**env, 'MARIADB_PASSWORD_FILE': ''}),
        ]:
            name, _ = start(label, directory, invalid)
            wait_failed(name)
        print('PASS: conflicting, empty, malformed, missing and unsafe bootstrap inputs rejected')

        bad_schema = directory / 'bad-schema'
        bad_schema.mkdir(mode=0o700)
        (bad_schema / '01-fail.sql').write_text('THIS IS NOT SQL;')
        name, volume = start('interrupted', directory, env, init_dir=bad_schema)
        wait_failed(name)
        docker('rm', name)
        name, _ = start('retry', directory, env, volume)
        wait_failed(name)
        logs = docker('logs', name)
        assert_safe('initialisation was interrupted' in logs.stderr + logs.stdout,
                    'Incomplete database did not retain its fail-closed marker.')
        print('PASS: failed schema import cannot expose a half-initialized database on restart')


try:
    main()
except Exception as error:
    # Never print subprocess input/output or an exception with command arguments.
    print('FAIL: ' + (str(error) if isinstance(error, RuntimeError) else type(error).__name__))
    raise SystemExit(1)
finally:
    for name in containers:
        docker('stop', '-t', '30', name, check=False)
        docker('rm', '-f', name, check=False)
    for volume in volumes:
        docker('volume', 'rm', volume, check=False)
