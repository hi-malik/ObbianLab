#!/usr/bin/env python3
"""Verify the production Next.js boundary using only synthetic test credentials."""
import base64
import hashlib
import hmac
import json
import socket
import subprocess
import time
import urllib.error
import urllib.request
from uuid import uuid4

SECRET='local-development-only-secret-32-characters'
NAME='obbian-web-auth-test-'+uuid4().hex[:8]

def token(exp, sub='22222222-2222-4222-8222-222222222222'):
    encode=lambda x:base64.urlsafe_b64encode(json.dumps(x,separators=(',',':')).encode()).decode().rstrip('=')
    body=encode({'alg':'HS256','typ':'JWT'})+'.'+encode({'sub':sub,'tenantId':'11111111-1111-4111-8111-111111111111','aud':'obbian','exp':exp})
    return body+'.'+base64.urlsafe_b64encode(hmac.new(SECRET.encode(),body.encode(),hashlib.sha256).digest()).decode().rstrip('=')

def main():
    with socket.socket() as probe:probe.bind(('127.0.0.1',0));port=probe.getsockname()[1]
    origin=f'http://localhost:{port}'
    subprocess.run(['docker','run','-d','--name',NAME,'--network','obbian-assessment_default','-p',f'127.0.0.1:{port}:3000',
                    '-e','AUTH_MODE=strict','-e',f'AUTH_SIGNING_SECRET={SECRET}','-e',f'PUBLIC_ORIGIN={origin}',
                    '-e','AI_SERVICE_URL=http://ai:8000','-e','AI_SERVICE_TOKEN=local-ai-token','obbian-assessment-web'],check=True,stdout=subprocess.DEVNULL)
    def request(method,path,body=None,cookie=None,request_origin=origin):
        headers={'content-type':'application/json','origin':request_origin}
        if cookie:headers['cookie']=cookie
        req=urllib.request.Request(origin+path,method=method,headers=headers,data=json.dumps(body).encode() if body is not None else None)
        try:
            with urllib.request.urlopen(req,timeout=30) as res:return res.status,json.load(res),res.headers
        except urllib.error.HTTPError as res:return res.code,json.load(res),res.headers
    try:
        for attempt in range(50):
            try:
                code,body,_=request('GET','/api/session');break
            except OSError:time.sleep(.2)
        else:raise AssertionError('web never became ready')
        assert code==200 and body=={'authenticated':False,'demo':False}
        assert request('POST','/api/agent',{'message':'hello'})[0]==401
        assert request('POST','/api/session',{'token':token(time.time()+100)},request_origin='https://attacker.example')[0]==403
        assert request('POST','/api/session',{'token':token(time.time()-1)})[0]==401
        assert request('POST','/api/session',{'token':token(time.time()+100)+'tamper'})[0]==401
        code,_,headers=request('POST','/api/session',{'token':token(time.time()+100)})
        assert code==200
        cookie=headers['Set-Cookie']
        assert 'HttpOnly' in cookie and 'Secure' in cookie and 'SameSite=strict' in cookie
        cookie=cookie.split(';')[0]
        assert request('GET','/api/session',cookie=cookie)[1]['authenticated']
        code,reply,_=request('POST','/api/agent',{'message':'electrician'},cookie=cookie)
        assert code==200 and reply.get('stage')=='collecting', (code,reply)
        assert request('DELETE','/api/session',cookie=cookie)[0]==200
        print('PASS: strict auth, origin checks, expiry/tamper rejection, secure cookies and authenticated proxy')
    finally:subprocess.run(['docker','rm','-f',NAME],stdout=subprocess.DEVNULL,check=False)

if __name__=='__main__':main()
