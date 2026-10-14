"""Explicit synthetic GPS heartbeat for the assessment demo's seeded professional."""
import json
import os
import time
import urllib.request

while True:
    try:
        request = urllib.request.Request('http://api:3001/professionals/me/presence',  # gitleaks:allow -- internal URL, no credential
            data=json.dumps({'latitude':28.6138,'longitude':77.2090,'status':'available'}).encode(),
            headers={'content-type':'application/json','authorization':'Bearer '+os.environ['INTERNAL_SERVICE_TOKEN'],
                     'x-tenant-id':'11111111-1111-4111-8111-111111111111',
                     'x-actor-id':'33333333-3333-4333-8333-333333333333'})
        with urllib.request.urlopen(request,timeout=10) as response:
            if response.status!=201: raise RuntimeError('presence was not accepted')
    except Exception:
        print('Demo professional presence unavailable; retrying',flush=True)
    time.sleep(30)
