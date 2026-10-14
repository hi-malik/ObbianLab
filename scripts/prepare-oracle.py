#!/usr/bin/env python3
"""Generate private configuration for a single free VM. No credentials are printed."""
import argparse
import base64
import copy
import hashlib
import hmac
import json
from pathlib import Path
import re
import secrets
import time
import yaml

ROOT=Path(__file__).resolve().parents[1]

def prepare(hostname, prebuilt_prefix=None, micro=False):
    if not re.fullmatch(r'[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?',hostname) or '..' in hostname:
        raise ValueError('Provide a valid public DNS hostname')
    if prebuilt_prefix and not re.fullmatch(r'[a-z0-9][a-z0-9._-]*',prebuilt_prefix):
        raise ValueError('Provide a local Docker image prefix')
    directory=ROOT/'.deploy'
    directory.mkdir(mode=0o700,exist_ok=True);directory.chmod(0o700)
    secret_file=directory/'secrets.json'
    keys=['ADMIN_PASSWORD','MIGRATION_PASSWORD','API_PASSWORD','ALLOCATION_PASSWORD','PIPELINE_PASSWORD','AI_PASSWORD',
          'AUTH_SIGNING_SECRET','INTERNAL_SERVICE_TOKEN','AI_SERVICE_TOKEN','SANDBOX_WEBHOOK_SECRET']
    credentials=json.loads(secret_file.read_text()) if secret_file.exists() else {key:secrets.token_hex(32) for key in keys}
    if not all(isinstance(credentials.get(key),str) and re.fullmatch('[a-f0-9]{64}',credentials[key]) for key in keys):
        raise ValueError('Invalid existing deployment secrets; do not regenerate keys for an existing database')
    secret_file.write_text(json.dumps(credentials,indent=2)+'\n');secret_file.chmod(0o600)
    config=yaml.safe_load((ROOT/'docker-compose.yml').read_text())
    config.pop('x-database-url',None);config['name']='obbianlab-live'
    services=config['services']
    for name,service in services.items():
        service.pop('ports',None)
        build=service.get('build')
        if isinstance(build,str):service['build']=str((ROOT/build).resolve())
        elif isinstance(build,dict):build['context']=str((ROOT/build.get('context','.')).resolve())
        if service.get('restart')!='no':
            service['logging']={'driver':'json-file','options':{'max-size':'10m','max-file':'3'}}
    def url(key): return f"postgres://obbian_{key.lower()}:{credentials[key+'_PASSWORD']}@database:5432/obbian"
    database=services['database']
    database['environment']={'POSTGRES_DB':'obbian','POSTGRES_USER':'obbian_admin','POSTGRES_PASSWORD':credentials['ADMIN_PASSWORD'],
        **{'DB_'+key+'_PASSWORD':credentials[key+'_PASSWORD'] for key in ['MIGRATION','API','ALLOCATION','PIPELINE','AI']}}
    database['volumes'].append(str(ROOT/'infra/oracle/db-init.sh')+':/docker-entrypoint-initdb.d/001-roles.sh:ro')
    database['healthcheck']['test']=['CMD-SHELL','pg_isready -U obbian_admin -d obbian']
    services['migrate']['environment']['DATABASE_URL']=url('MIGRATION')
    grants=copy.deepcopy(services['migrate']);grants['entrypoint']=['/usr/local/bin/provision-runtime']
    grants['depends_on']={'migrate':{'condition':'service_completed_successfully'}}
    grants['environment'].update({key+'_DATABASE_USER':'obbian_'+key.lower() for key in ['API','ALLOCATION','PIPELINE','AI']})
    services['grants']=grants
    seed=services['seed'];seed['depends_on']={'grants':{'condition':'service_completed_successfully'}}
    seed['environment']={'PGPASSWORD':credentials['ADMIN_PASSWORD']}
    seed['volumes']=[str(ROOT/'db/seed.sql')+':/seed.sql:ro']
    seed['entrypoint']=['psql','-h','database','-U','obbian_admin','-d','obbian','-v','ON_ERROR_STOP=1','-f','/seed.sql']
    for name in ['api','allocation','pipeline','ai']:
        env=services[name]['environment'];env['DATABASE_URL']=url(name.upper())
        for key in list(env):
            if key in credentials:env[key]=credentials[key]
            elif key.endswith('_DEMO_TOKEN') or key=='WS_DEMO_TOKEN':env.pop(key)
            elif isinstance(env[key],str) and env[key].startswith('${'):env[key]=''
        if name in ['api','ai']:env['AUTH_MODE']='strict';env['AUTH_SIGNING_SECRET']=credentials['AUTH_SIGNING_SECRET']
    services['api']['environment'].update(PAYMENT_GATEWAY='sandbox',CORS_ORIGINS='https://'+hostname,
        SERVICE_PRICES_JSON=json.dumps({slug:{'amountMinor':price,'currency':'INR'} for slug,price in [('electrician',250000),('plumber',200000),('cleaner',100000),('ride',15000)]}))
    services['ai']['environment'].update(AI_PROVIDER_MODE='offline',AI_SERVICE_TOKEN=credentials['AI_SERVICE_TOKEN'],
        INTERNAL_SERVICE_TOKEN=credentials['INTERNAL_SERVICE_TOKEN'])
    services['web']['environment']={'AUTH_MODE':'strict','AI_PROVIDER_MODE':'offline','AUTH_SIGNING_SECRET':credentials['AUTH_SIGNING_SECRET'],
        'AI_SERVICE_TOKEN':credentials['AI_SERVICE_TOKEN'],'AI_SERVICE_URL':'http://ai:8000','BOOKING_API_URL':'http://api:3001',
        'INTERNAL_SERVICE_TOKEN':credentials['INTERNAL_SERVICE_TOKEN'],'PUBLIC_ORIGIN':'https://'+hostname}
    services['redpanda']['volumes']=['broker-data:/var/lib/redpanda/data']
    config['volumes']['broker-data']={}
    services['caddy']={'image':'caddy:2-alpine','restart':'unless-stopped','ports':['80:80','443:443'],
        'environment':{'PUBLIC_HOSTNAME':hostname},'volumes':[str(ROOT/'infra/oracle/Caddyfile')+':/etc/caddy/Caddyfile:ro','caddy-data:/data','caddy-config:/config'],
        'depends_on':{'web':{'condition':'service_healthy'}},'logging':{'driver':'json-file','options':{'max-size':'10m','max-file':'3'}}}
    config['volumes'].update({'caddy-data':{},'caddy-config':{}})
    services['demo-professional']={'build':str(ROOT/'services/ai'),'restart':'unless-stopped',
        'command':['python','/demo-professional.py'],'volumes':[str(ROOT/'infra/oracle/demo-professional.py')+':/demo-professional.py:ro'],
        'environment':{'INTERNAL_SERVICE_TOKEN':credentials['INTERNAL_SERVICE_TOKEN']},'depends_on':{'api':{'condition':'service_healthy'}}}
    if prebuilt_prefix:
        aliases={'grants':'migrate','seed':'database','demo-professional':'ai'}
        for name,service in services.items():
            if 'build' in service:
                service.pop('build')
                service['image']=prebuilt_prefix+'-'+aliases.get(name,name)+':latest'
                service['pull_policy']='never'
    if micro:
        # A1 is preferred. E2 Micro supports only a low-traffic assessment demo.
        services['database']['command']=['postgres','-c','shared_buffers=32MB','-c','max_connections=60','-c','work_mem=2MB']
        services['redis']['command']=[value.replace('256mb','128mb') for value in services['redis']['command']]
        services['redpanda']['command']=[value.replace('--memory=768M','--memory=384M') for value in services['redpanda']['command']]
        services['api']['environment']['DB_POOL_SIZE']=5
        services['pipeline']['environment']['CONSUMER_CONCURRENCY']=2
        for name in ['api','web','pipeline']:
            services[name]['environment']['NODE_OPTIONS']='--max-old-space-size=192'
        for service in services.values():
            if 'healthcheck' in service:
                service['healthcheck'].update(interval='15s',timeout='10s',retries=30)
    path=directory/'compose.yaml';path.write_text(yaml.safe_dump(config,sort_keys=False));path.chmod(0o600)
    encode=lambda value:base64.urlsafe_b64encode(json.dumps(value,separators=(',',':')).encode()).decode().rstrip('=')
    body=encode({'alg':'HS256','typ':'JWT'})+'.'+encode({'sub':'22222222-2222-4222-8222-222222222222',
        'tenantId':'11111111-1111-4111-8111-111111111111','aud':'obbian','exp':int(time.time())+86400})
    signature=base64.urlsafe_b64encode(hmac.new(credentials['AUTH_SIGNING_SECRET'].encode(),body.encode(),hashlib.sha256).digest()).decode().rstrip('=')
    token=directory/'customer-access-token.txt';token.write_text(body+'.'+signature+'\n');token.chmod(0o600)
    print('Private configuration ready in .deploy/; customer token expires in 24 hours. No secret values printed.')

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--hostname',required=True)
    parser.add_argument('--prebuilt-prefix',help='Use already loaded PREFIX-SERVICE:latest images instead of building on the VM')
    parser.add_argument('--micro',action='store_true',help='Reduce memory and concurrency for an Always Free E2 Micro demo')
    args=parser.parse_args()
    prepare(args.hostname,args.prebuilt_prefix,args.micro)
