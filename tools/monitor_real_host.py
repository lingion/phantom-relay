#!/usr/bin/env python3
import datetime
import pathlib
import subprocess
import time
import urllib.request

ROOT = pathlib.Path('/Users/lingion_k/Desktop/phantom-relay')
LOG = ROOT / 'docs/regression/rounds/20260722-101100-monitor.log'
DURATION = 7200


def now():
    return datetime.datetime.now().astimezone().isoformat()


def canary_processes():
    result = subprocess.run(
        ['ps', '-axo', 'pid=,command='],
        capture_output=True,
        text=True,
        check=False,
    )
    matches = []
    for line in result.stdout.splitlines():
        if '/Google Chrome Canary/' in line or 'Google Chrome Canary.app' in line:
            matches.append(line.strip())
    return matches[:3]


def clients():
    try:
        with urllib.request.urlopen('http://127.0.0.1:8765/browser/clients', timeout=2) as response:
            return response.read().decode('utf-8', 'replace')
    except Exception as exc:
        return 'API_UNAVAILABLE:' + type(exc).__name__


def main():
    end = time.time() + DURATION
    LOG.parent.mkdir(parents=True, exist_ok=True)
    with LOG.open('a', encoding='utf-8') as stream:
        stream.write('START ' + now() + '\n')
        stream.flush()
        while time.time() < end:
            stream.write(
                now() + ' canary=' + repr(canary_processes()) +
                ' clients=' + clients() + '\n'
            )
            stream.flush()
            time.sleep(60)
        stream.write('END ' + now() + '\n')
        stream.flush()


if __name__ == '__main__':
    main()
