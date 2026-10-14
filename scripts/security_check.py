#!/usr/bin/env python3
"""Live negative tests against local Compose. No remote identities or real data."""
import json
import urllib.error
import urllib.request

BASE='http://localhost:3001'
TENANT='11111111-1111-4111-8111-111111111111'
CUSTOMER='22222222-2222-4222-8222-222222222222'
HEADERS={'x-tenant-id':TENANT,'x-actor-id':CUSTOMER,'content-type':'application/json'}

def status(method,path,body=None,headers=None,base=BASE):
    req=urllib.request.Request(base+path,method=method,headers={**HEADERS,**(headers or {})},data=json.dumps(body).encode() if body is not None else None)
    try:
        with urllib.request.urlopen(req,timeout=10) as response:return response.status
    except urllib.error.HTTPError as error:return error.code

def main():
    checks = {
        'forged finance role rejected': status('GET','/payments/reconciliation/report',headers={'x-roles':'finance'}) in (401,403),
        'unknown actor rejected': status('GET','/categories/electrician',headers={'x-actor-id':'99999999-9999-4999-8999-999999999999'}) in (401,403),
        'wrong tenant rejected': status('GET','/categories/electrician',headers={'x-tenant-id':'99999999-9999-4999-8999-999999999999'}) in (401,403),
        'forged knowledge role rejected': status('POST','/rag/documents',{'external_key':'should-not-exist','title':'No','text':'Unauthorized text','allowed_roles':[]},headers={'authorization':'Bearer local-ai-token','x-roles':'knowledge_admin'},base='http://localhost:8000')==403,
        'unsigned webhook rejected': status('POST','/webhooks/sandbox',{'eventId':'bad'}) in (400,401),
        'cross-origin web booking rejected': status('POST','/api/agent',{'message':'confirm'},headers={'origin':'https://attacker.example'},base='http://localhost:3000')==403,
        'missing-origin web booking rejected': status('POST','/api/agent',{'message':'confirm'},base='http://localhost:3000')==403,
    }
    print(json.dumps(checks,indent=2))
    assert all(checks.values()), 'A security boundary regressed'

if __name__=='__main__':main()
