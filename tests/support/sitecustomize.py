"""Test-only network boundary: never contact real services from CLI fixtures."""
import io
import json
import os
import platform
import socket
import urllib.error
import urllib.request

if os.environ.get('RELAY_TEST_HOME'):
    # Exercise the file credential adapter even on macOS; Keychain is never used.
    platform.system = lambda: 'Linux'

    def denied(*args, **kwargs):
        raise OSError('External network disabled by Relay test harness')

    socket.create_connection = denied
    socket.socket.connect = denied
    socket.socket.connect_ex = denied

    def urlopen(request, *args, **kwargs):
        url = request if isinstance(request, str) else request.full_url
        fixture_path = os.environ.get('RELAY_TEST_HTTP')
        fixtures = json.load(open(fixture_path)) if fixture_path else {}
        if url not in fixtures:
            raise OSError('No HTTP fixture for ' + url)
        response = fixtures[url]
        if 'error' in response:
            raise urllib.error.HTTPError(url, response['error'], 'fixture', {}, io.BytesIO(b'{}'))
        if 'body_file' in response:
            with open(response['body_file'], 'rb') as body:
                return io.BytesIO(body.read())
        return io.BytesIO(json.dumps(response).encode())

    urllib.request.urlopen = urlopen
