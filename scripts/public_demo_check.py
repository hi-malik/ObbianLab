#!/usr/bin/env python3
"""Check the public TLS boundary using a customer token file, without printing it."""
import argparse
from datetime import datetime, timedelta, UTC
from http.cookiejar import CookieJar
import json
from pathlib import Path
import time
import urllib.error
import urllib.parse
import urllib.request


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--origin', required=True)
    parser.add_argument('--token-file', type=Path, required=True)
    args = parser.parse_args()
    url = urllib.parse.urlsplit(args.origin)
    if url.scheme != 'https' or not url.hostname or url.path not in ('', '/') or url.query or url.fragment or url.username:
        parser.error('Provide a plain HTTPS origin')
    origin = args.origin.rstrip('/')
    jar = CookieJar()
    client = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
    timings = []

    def call(method, path, body=None, request_origin=origin):
        request = urllib.request.Request(origin + path, method=method,
            data=json.dumps(body).encode() if body is not None else None,
            headers={'content-type': 'application/json', 'origin': request_origin})
        started = time.monotonic()
        try:
            with client.open(request, timeout=60) as response:
                result = response.status, json.load(response), response.headers
        except urllib.error.HTTPError as response:
            result = response.code, json.load(response), response.headers
        timings.append(round(time.monotonic() - started, 3))
        return result

    assert call('GET', '/api/session')[1] == {'authenticated': False, 'demo': False, 'offline': True}
    assert call('POST', '/api/agent', {'message': 'electrician'})[0] == 401
    assert call('POST', '/api/session', {'token': 'invalid'})[0] == 401
    assert call('POST', '/api/session', {'token': 'invalid'}, 'https://attacker.example')[0] == 403
    status, _, headers = call('POST', '/api/session', {'token': args.token_file.read_text().strip()})
    assert status == 200
    assert all(value in headers['Set-Cookie'] for value in ('Secure', 'HttpOnly', 'SameSite=strict'))
    assert call('GET', '/api/session')[1]['authenticated']
    when = (datetime.now(UTC) + timedelta(days=4, minutes=int(time.time()) % 1000)).isoformat()
    status, reply, _ = call('POST', '/api/agent', {'message': f'electrician at: 12 Lake Road; 28.6139,77.2090 on {when}'})
    assert status == 200 and reply['stage'] == 'awaiting_confirmation', (status, reply)
    # Availability proposal does not create a booking without customer confirmation.
    status, answer, _ = call('POST', '/api/knowledge', {'question': 'What should I do before inspecting a distribution board?'})
    assert status == 200 and answer['grounded'] and answer['citations'], (status, answer)
    assert call('DELETE', '/api/session')[0] == 200
    assert not call('GET', '/api/session')[1]['authenticated']
    print(json.dumps({'status': 'passed', 'origin': origin,
        'checks': ['verified HTTPS', 'strict anonymous access', 'invalid token rejection', 'CSRF rejection',
                   'signed customer login', 'secure session cookie', 'AI availability proposal', 'cited retrieval', 'logout'],
        'request_seconds': timings}))


if __name__ == '__main__':
    main()
