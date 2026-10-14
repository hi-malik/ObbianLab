#!/usr/bin/env python3
"""Exercise the strict, offline profile internally without printing credentials."""
import os
from pathlib import Path
import subprocess

root=Path(__file__).resolve().parents[1]
command=['docker','compose','-f',str(root/'.deploy/compose.yaml')]
if os.getenv('ORACLE_COMPOSE_PROJECT'):command+=['-p',os.environ['ORACLE_COMPOSE_PROJECT']]
code=r'''
import base64,hashlib,hmac,json,os,time,urllib.request,urllib.error
from datetime import datetime,UTC,timedelta
from uuid import uuid4
tenant='11111111-1111-4111-8111-111111111111'
customer='22222222-2222-4222-8222-222222222222'
professional='33333333-3333-4333-8333-333333333333'
admin='77777777-7777-4777-8777-777777777777'
def call(base,path,body=None,actor=customer,auth=True):
    headers={'content-type':'application/json','x-tenant-id':tenant,'x-actor-id':actor}
    if auth:headers['authorization']='Bearer '+os.environ['AI_SERVICE_TOKEN' if base=='ai' else 'INTERNAL_SERVICE_TOKEN']
    raw=json.dumps(body).encode() if body is not None else None
    req=urllib.request.Request(('http://ai:8000' if base=='ai' else 'http://api:3001')+path,data=raw,headers=headers)
    try:
        with urllib.request.urlopen(req,timeout=15) as response:return response.status,json.load(response)
    except urllib.error.HTTPError as response:return response.code,json.load(response)
assert os.environ['AUTH_MODE']=='strict' and os.environ['AI_PROVIDER_MODE']=='offline'
assert call('ai','/agent/messages',{'message':'electrician'},auth=False)[0]==401
assert call('api','/categories/electrician',auth=False)[0]==401
assert call('ai','/rag/documents',{'external_key':'forbidden','title':'Forbidden','text':'No access','allowed_roles':['customer']})[0]==403
call('api','/professionals/me/presence',{'latitude':28.6138,'longitude':77.2090,'status':'available'},professional)
when=(datetime.now(UTC)+timedelta(days=3,minutes=int(uuid4().int%1000))).isoformat()
status,proposal=call('ai','/agent/messages',{'message':f'electrician at: 12 Lake Road; 28.6139,77.2090 on {when}'})
assert status==200 and proposal['stage']=='awaiting_confirmation',(status,proposal)
status,reply=call('ai','/agent/messages',{'message':'confirm','conversation_id':proposal['conversation_id']})
assert status==200 and reply['stage']=='completed',(status,reply)
booking=reply['booking_id']
for _ in range(30):
    status,offers=call('api','/professionals/me/offers',actor=professional)
    offer=next((o for o in offers if o['bookingId']==booking),None)
    if offer:break
    time.sleep(.5)
else:raise AssertionError('allocator produced no offer')
assert call('api','/offers/'+offer['id']+'/accept',{},professional)[0]==201
status,quote=call('api','/payments/quote/'+booking)
assert status==200 and int(quote['amountMinor'])==250000,(status,quote)
key='oracle-profile-'+str(uuid4())
status,doc=call('ai','/rag/documents',{'external_key':key,'title':'Circuit breaker field guide','text':'Switch off and isolate the main supply before inspecting a distribution board. Never bypass the breaker.','allowed_roles':['customer']},admin)
assert status in (200,201),(status,doc)
status,answer=call('ai','/rag/query',{'question':'What should I do before inspecting a distribution board?'})
assert status==200 and answer['grounded'] and answer['citations'],(status,answer)
assert call('api','/bookings/'+booking+'/cancel',{})[0]==201
def token(exp):
    encode=lambda x:base64.urlsafe_b64encode(json.dumps(x,separators=(',',':')).encode()).decode().rstrip('=')
    body=encode({'alg':'HS256','typ':'JWT'})+'.'+encode({'sub':customer,'tenantId':tenant,'aud':'obbian','exp':exp})
    signature=base64.urlsafe_b64encode(hmac.new(os.environ['AUTH_SIGNING_SECRET'].encode(),body.encode(),hashlib.sha256).digest()).decode().rstrip('=')
    return body+'.'+signature
def web(method,path,body=None,cookie=None,origin='https://localhost'):
    headers={'content-type':'application/json','origin':origin}
    if cookie:headers['cookie']=cookie
    req=urllib.request.Request('http://web:3000'+path,method=method,headers=headers,data=json.dumps(body).encode() if body is not None else None)
    try:
        with urllib.request.urlopen(req,timeout=20) as res:return res.status,json.load(res),res.headers
    except urllib.error.HTTPError as res:return res.code,json.load(res),res.headers
# Read the configured public origin from the caller instead of assuming a test hostname.
origin=os.environ['PROFILE_PUBLIC_ORIGIN']
assert web('GET','/api/session')[1]=={'authenticated':False,'demo':False,'offline':True}
assert web('POST','/api/agent',{'message':'hello'},origin=origin)[0]==401
assert web('POST','/api/session',{'token':token(time.time()+120)},origin='https://attacker.example')[0]==403
assert web('POST','/api/session',{'token':token(time.time()-1)},origin=origin)[0]==401
assert web('POST','/api/session',{'token':token(time.time()+120)+'tamper'},origin=origin)[0]==401
status,_,headers=web('POST','/api/session',{'token':token(time.time()+120)},origin=origin)
assert status==200
cookie=headers['Set-Cookie']
assert all(value in cookie for value in ['HttpOnly','Secure','SameSite=strict'])
cookie=cookie.split(';')[0]
assert web('GET','/api/session',cookie=cookie)[1]['authenticated']
status,reply,_=web('POST','/api/agent',{'message':'electrician'},cookie,origin)
assert status==200 and reply['stage']=='collecting',(status,reply)
assert web('DELETE','/api/session',cookie=cookie,origin=origin)[0]==200
print(json.dumps({'status':'passed','checks':['strict anonymous rejection','knowledge admin authorization','offline AI with real DB roles','confirmation and backend booking','Go allocation and professional acceptance','server-owned price quote','cited retrieval','authorized cancellation','web sign-in and secure cookies','CSRF, expiry and tamper rejection','authenticated web proxy']}))
'''
import yaml
config=yaml.safe_load((root/'.deploy/compose.yaml').read_text())
origin=config['services']['web']['environment']['PUBLIC_ORIGIN']
subprocess.run(command+['exec','-T','-e','PROFILE_PUBLIC_ORIGIN='+origin,'ai','python','-'],input=code,text=True,check=True)
