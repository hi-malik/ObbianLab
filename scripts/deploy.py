#!/usr/bin/env python3
"""Render and deploy an immutable release. Never prints secret values.
Requires AWS CLI, kubectl, PyYAML and an existing bootstrapped AWS platform.
"""
import argparse
import copy
import base64
import json
import os
import re
from pathlib import Path
import subprocess
import sys
import time
import urllib.request
from urllib.parse import urlsplit, unquote, parse_qsl, urlencode, urlunsplit
import yaml

ROOT = Path(__file__).resolve().parents[1]
SERVICES = ('api', 'web', 'allocation', 'pipeline', 'ai')
DATABASE_CA_PATH = '/etc/obbian-certs/global-bundle.pem'
# Independent migration login must own the schema; runtime login has DML only.
SECRET_KEYS = {
    'api': ['API_DATABASE_URL', 'INTERNAL_SERVICE_TOKEN', 'AUTH_SIGNING_SECRET', 'SANDBOX_WEBHOOK_SECRET', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'SERVICE_PRICES_JSON'],
    'web': ['AI_SERVICE_TOKEN', 'AUTH_SIGNING_SECRET', 'INTERNAL_SERVICE_TOKEN'],
    'allocation': ['ALLOCATION_DATABASE_URL'],
    'pipeline': ['PIPELINE_DATABASE_URL', 'KAFKA_BROKERS'],
    'ai': ['AI_DATABASE_URL', 'REDIS_URL', 'INTERNAL_SERVICE_TOKEN', 'AI_SERVICE_TOKEN', 'AUTH_SIGNING_SECRET',
           'LLM_BASE_URL', 'LLM_API_KEY', 'LLM_MODEL', 'EMBEDDING_BASE_URL', 'EMBEDDING_API_KEY', 'EMBEDDING_MODEL',
           'ASR_BASE_URL', 'ASR_API_KEY', 'ASR_MODEL'],
    'migration': ['MIGRATION_DATABASE_URL'],
}

def run(args, payload=None, check=True):
    result = subprocess.run(args, input=payload, text=True, capture_output=True)
    if check and result.returncode:
        # Commands here may include stdin secrets; keep exception generic.
        raise RuntimeError(f'{args[0]} {args[1]} failed (exit {result.returncode}); inspect AWS/Kubernetes diagnostics without dumping secrets')
    return result

def apply(items):
    if items:
        run(['kubectl', 'apply', '-f', '-'], yaml.safe_dump_all(items))

def secure_database_url(value):
    url = urlsplit(value)
    parameters = parse_qsl(url.query, keep_blank_values=True)
    allowed = {'sslmode','sslrootcert','connect_timeout','application_name'}
    if any(key not in allowed for key,_ in parameters) or len({key for key,_ in parameters}) != len(parameters):
        raise ValueError('Unsupported or duplicate database URL options; identity and TLS cannot be overridden')
    settings = dict(parameters)
    settings.update(sslmode='verify-full', sslrootcert=DATABASE_CA_PATH)
    return urlunsplit((url.scheme,url.netloc,url.path,urlencode(settings),''))


def mount_database_ca(template, configmap_name):
    spec = template['spec']
    spec.setdefault('volumes', []).append({'name':'database-ca','configMap':{'name':configmap_name}})
    for container in spec['containers']:
        container.setdefault('volumeMounts', []).append({'name':'database-ca','mountPath':'/etc/obbian-certs','readOnly':True})


def render(args):
    resource_suffix = args.release[:12]+'-'+str(int(time.time()))
    docs = list(yaml.safe_load_all((ROOT/'infra/k8s/platform.yaml').read_text()))
    for doc in docs:
        if doc['kind'] == 'Deployment':
            name = doc['metadata']['name']
            # Images have passed CI and are referenced by content digest.
            container = doc['spec']['template']['spec']['containers'][0]
            container['image'] = args.images[name]
            if name != 'web':
                mount_database_ca(doc['spec']['template'], 'database-ca-'+resource_suffix)
            for source in container.get('envFrom', []):
                for reference in ('configMapRef','secretRef'):
                    if reference in source:
                        source[reference]['name'] += '-'+resource_suffix
        if doc['kind'] == 'ConfigMap':
            doc['metadata']['name'] += '-'+resource_suffix
            doc['immutable'] = True
            doc['data'].update(AWS_REGION=args.region, PUBLIC_ORIGIN=f'https://{args.hostname}',
                               CORS_ORIGINS=f'https://{args.hostname}', AUTH_MODE='strict', PAYMENT_GATEWAY='stripe_test')
    docs.append({'apiVersion':'v1','kind':'ConfigMap','metadata':{'name':'database-ca-'+resource_suffix,'namespace':'obbian'},
                 'immutable':True,'data':{'global-bundle.pem':(ROOT/'infra/certs/global-bundle.pem').read_text()}})
    policies = list(yaml.safe_load_all((ROOT/'infra/k8s/network-policy.yaml').read_text().replace('10.42.0.0/16', args.vpc_cidr)))
    ingress = {
        'apiVersion': 'networking.k8s.io/v1', 'kind': 'Ingress',
        'metadata': {'name': 'web', 'namespace': 'obbian', 'annotations': {
            'alb.ingress.kubernetes.io/scheme': 'internet-facing', 'alb.ingress.kubernetes.io/target-type': 'ip',
            'alb.ingress.kubernetes.io/listen-ports': '[{"HTTP":80},{"HTTPS":443}]',
            'alb.ingress.kubernetes.io/ssl-redirect': '443', 'alb.ingress.kubernetes.io/certificate-arn': args.certificate_arn,
            'alb.ingress.kubernetes.io/healthcheck-path': '/api/session',
        }},
        'spec': {'ingressClassName': 'alb', 'rules': [{'host': args.hostname, 'http': {'paths': [{
            'path': '/', 'pathType': 'Prefix', 'backend': {'service': {'name': 'web', 'port': {'number': 80}}}
        }]}}]},
    }
    migration = yaml.safe_load((ROOT/'infra/k8s/migration.yaml').read_text())
    migration['metadata']['name'] = 'database-migration-'+resource_suffix
    mount_database_ca(migration['spec']['template'], 'database-ca-'+resource_suffix)
    migration['spec']['template']['spec']['containers'][0]['image'] = args.images['migrations']
    migration['spec']['template']['spec']['containers'][0]['envFrom'][0]['secretRef']['name'] += '-'+resource_suffix
    grants = copy.deepcopy(migration)
    grants['metadata']['name'] = 'runtime-grants-'+resource_suffix
    grants['spec']['template']['spec']['containers'][0]['command'] = ['/usr/local/bin/provision-runtime']
    pipeline = next(doc for doc in docs if doc['kind'] == 'Deployment' and doc['metadata']['name'] == 'pipeline')
    topics_template = copy.deepcopy(pipeline['spec']['template'])
    topics_template['spec']['restartPolicy'] = 'Never'
    container = topics_template['spec']['containers'][0]
    container['command'] = ['node','services/pipeline/dist/init-topics.js']
    for key in ('readinessProbe','livenessProbe','startupProbe'): container.pop(key,None)
    topics = {'apiVersion':'batch/v1','kind':'Job',
              'metadata':{'name':'kafka-topics-'+resource_suffix, 'namespace':'obbian'},
              'spec':{'backoffLimit':2,'ttlSecondsAfterFinished':86400,'template':topics_template}}
    return docs, policies, ingress, migration, grants, topics

def wait_for_public_release(hostname, timeout_seconds):
    deadline = time.monotonic()+timeout_seconds
    while True:
        try:
            with urllib.request.urlopen(f'https://{hostname}/api/session', timeout=min(15,timeout_seconds)) as response:
                session = json.load(response)
                if not isinstance(session,dict) or session.get('demo') is not False or session.get('authenticated') is not False:
                    raise ValueError('Public service must report strict unauthenticated mode')
                return
        except json.JSONDecodeError:
            pass
        except ValueError:
            raise
        except OSError:
            pass
        if time.monotonic() >= deadline:
            raise RuntimeError('Public HTTPS verification timed out; check ALB targets, certificate and DNS') from None
        time.sleep(min(5,max(0,deadline-time.monotonic())))


def main():
    parser = argparse.ArgumentParser()
    for key in ('images', 'release', 'region', 'hostname', 'certificate-arn'):
        parser.add_argument(f'--{key}', required=True)
    parser.add_argument('--vpc-cidr', default='10.42.0.0/16')
    parser.add_argument('--secret-id')
    parser.add_argument('--render-only', action='store_true')
    parser.add_argument('--public-check-timeout', type=int, default=600)
    args = parser.parse_args()
    if not 1 <= args.public_check_timeout <= 1800:
        parser.error('--public-check-timeout must be between 1 and 1800 seconds')
    args.images = json.loads(Path(args.images).read_text())
    for name in (*SERVICES, 'migrations'):
        if '@sha256:' not in args.images.get(name, ''):
            raise ValueError(f'{name} must be an immutable image digest')
    docs, policies, ingress, migration, grants, topics = render(args)
    if args.render_only:
        print(yaml.safe_dump_all(docs+policies+[ingress,migration,grants,topics]))
        return
    if not args.secret_id: parser.error('--secret-id is required for deployment')
    secret = json.loads(run(['aws', 'secretsmanager', 'get-secret-value', '--region', args.region,
                            '--secret-id', args.secret_id, '--query', 'SecretString', '--output', 'text']).stdout)
    required = set(key for keys in SECRET_KEYS.values() for key in keys)
    missing = required - {key for key, value in secret.items() if isinstance(value, str) and value}
    if missing: raise ValueError('Missing secret fields: '+', '.join(sorted(missing)))
    for key in ('AUTH_SIGNING_SECRET', 'AI_SERVICE_TOKEN', 'INTERNAL_SERVICE_TOKEN', 'SANDBOX_WEBHOOK_SECRET'):
        if len(secret[key]) < 32: raise ValueError(f'{key} must contain at least 32 characters')
    if not secret['STRIPE_SECRET_KEY'].startswith('sk_test_') or not secret['STRIPE_WEBHOOK_SECRET'].startswith('whsec_'):
        raise ValueError('Deployment requires Stripe test-mode API and webhook credentials')
    database_keys = ['API_DATABASE_URL','ALLOCATION_DATABASE_URL','PIPELINE_DATABASE_URL','AI_DATABASE_URL','MIGRATION_DATABASE_URL']
    database_urls = [urlsplit(secret[key]) for key in database_keys]
    if any(url.scheme not in ('postgres','postgresql') or not url.username or not url.password for url in database_urls):
        raise ValueError('Database URLs must contain valid PostgreSQL identities')
    if len({unquote(url.username) for url in database_urls}) != len(database_keys):
        raise ValueError('Each runtime service and migration must have a distinct database user')
    if len({(url.hostname,url.port or 5432,url.path) for url in database_urls}) != 1:
        raise ValueError('All database identities must reference the same database endpoint')
    role_names = {key.replace('_URL','_USER'): unquote(url.username) for key,url in zip(database_keys,database_urls)}
    if any(not re.fullmatch(r'[a-z][a-z0-9_]{2,62}', name) or name.startswith('pg_') for name in role_names.values()):
        raise ValueError('Database identities must use dedicated lowercase role names')
    for key in database_keys:
        secret[key] = secure_database_url(secret[key])
    if not secret['REDIS_URL'].startswith('rediss://'):
        raise ValueError('AWS deployment requires a TLS rediss:// cache URL')
    prices = json.loads(secret['SERVICE_PRICES_JSON'])
    if not isinstance(prices,dict) or not prices:
        raise ValueError('SERVICE_PRICES_JSON must be a nonempty server pricing policy')
    for category,price in prices.items():
        if (not re.fullmatch(r'[a-z][a-z0-9_-]{0,63}',category) or not isinstance(price,dict)
            or type(price.get('amountMinor')) is not int or not 0 < price['amountMinor'] <= 9007199254740991
            or not isinstance(price.get('currency'),str) or not re.fullmatch(r'[A-Za-z]{3}',price['currency'])):
            raise ValueError('Server service prices must contain positive exact minor units and three-letter currencies')
    destinations = secret.get('STRIPE_CONNECT_DESTINATIONS', '{}')
    parsed_destinations = json.loads(destinations)
    if not isinstance(parsed_destinations,dict) or any(not re.fullmatch(r'[0-9a-fA-F-]{36}', key) or not isinstance(value,str) or not re.fullmatch(r'acct_[a-zA-Z0-9]+',value) for key,value in parsed_destinations.items()):
        raise ValueError('Invalid trusted Stripe Connect destination mapping')
    apply([d for d in docs if d['kind'] in ('Namespace','ServiceAccount','ConfigMap')])
    resource_suffix = migration['metadata']['name'].removeprefix('database-migration-')
    for name, keys in SECRET_KEYS.items():
        values = {('DATABASE_URL' if key.endswith('_DATABASE_URL') else key): secret[key] for key in keys}
        if name == 'api':
            values['STRIPE_CONNECT_DESTINATIONS'] = destinations
        if name == 'migration':
            values.update({key:value for key,value in role_names.items() if key != 'MIGRATION_DATABASE_USER'})
        apply([{'apiVersion':'v1','kind':'Secret','metadata':{'name':name+'-secrets-'+resource_suffix,'namespace':'obbian'},
                'type':'Opaque','immutable':True,'data':{k:base64.b64encode(v.encode()).decode() for k,v in values.items()}}])
    del secret
    # Bootstrap policies before migration, including the migration label's DB/DNS access.
    apply(policies)
    apply([migration])
    run(['kubectl','-n','obbian','wait','--for=condition=complete','job/'+migration['metadata']['name'],'--timeout=5m'])
    for bootstrap_job in (grants,topics):
        apply([bootstrap_job])
        run(['kubectl','-n','obbian','wait','--for=condition=complete','job/'+bootstrap_job['metadata']['name'],'--timeout=5m'])
    previous = {}
    for name in SERVICES:
        current = run(['kubectl','-n','obbian','get','deployment',name,'-o','json'], check=False)
        if current.returncode == 0:
            snapshot = json.loads(current.stdout)
            snapshot.pop('status', None)
            for field in ('uid','resourceVersion','generation','creationTimestamp','managedFields'):
                snapshot['metadata'].pop(field, None)
            snapshot['metadata'].get('annotations', {}).pop('kubectl.kubernetes.io/last-applied-configuration', None)
            previous[name] = snapshot
    try:
        apply(docs+[ingress])
        for name in SERVICES:
            run(['kubectl','-n','obbian','rollout','status','deployment/'+name,'--timeout=8m'])
        address = run(['kubectl','-n','obbian','get','ingress','web','-o',
                       'jsonpath={.status.loadBalancer.ingress[0].hostname}'], check=False).stdout.strip()
        print(f'Waiting for HTTPS at {args.hostname}; ALB hostname: {address or "provisioning (inspect ingress/web)"}', flush=True)
        wait_for_public_release(args.hostname,args.public_check_timeout)
        print(f'Verified release {args.release} at https://{args.hostname}')
    except Exception:
        # Restore complete workload specs, including previous immutable config and
        # secret references. Schema changes require backward-compatible migrations.
        for name, snapshot in previous.items():
            run(['kubectl','apply','-f','-'], yaml.safe_dump(snapshot), check=False)
        # A failed first release must not leave partial workloads publicly served.
        for name in set(SERVICES)-set(previous):
            run(['kubectl','-n','obbian','delete','deployment',name,'--ignore-not-found'], check=False)
        if not previous:
            run(['kubectl','-n','obbian','delete','ingress','web','--ignore-not-found'], check=False)
        for name in previous:
            run(['kubectl','-n','obbian','rollout','status','deployment/'+name,'--timeout=5m'], check=False)
        raise

if __name__ == '__main__':
    try: main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
