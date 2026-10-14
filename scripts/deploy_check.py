#!/usr/bin/env python3
"""Offline deployment security/render/rollback checks; never contacts AWS/Kubernetes."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import yaml

spec = importlib.util.spec_from_file_location('deploy', Path(__file__).with_name('deploy.py'))
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)

class DeploymentChecks(unittest.TestCase):
    def arguments(self, images='unused'):
        return SimpleNamespace(images={name:'registry/'+name+'@sha256:'+'a'*64 for name in (*deploy.SERVICES,'migrations')},
            release='a'*40,region='ap-south-1',hostname='assessment.example.com',
            certificate_arn='arn:aws:acm:ap-south-1:123456789012:certificate/test',vpc_cidr='10.42.0.0/16')

    def test_release_config_and_database_trust(self):
        docs,policies,ingress,migration,grants,topics = deploy.render(self.arguments())
        configmaps = {doc['metadata']['name']:doc for doc in docs if doc['kind']=='ConfigMap'}
        self.assertEqual(len(configmaps),2)
        self.assertTrue(all(doc['immutable'] for doc in configmaps.values()))
        for deployment in (doc for doc in docs if doc['kind']=='Deployment'):
            container = deployment['spec']['template']['spec']['containers'][0]
            for source in container.get('envFrom',[]):
                if 'configMapRef' in source: self.assertIn(source['configMapRef']['name'],configmaps)
                if 'secretRef' in source: self.assertIn('-'+'a'*12+'-',source['secretRef']['name'])
            if deployment['metadata']['name']!='web':
                self.assertTrue(any(mount['mountPath']=='/etc/obbian-certs' and mount['readOnly'] for mount in container['volumeMounts']))
        self.assertEqual(grants['spec']['template']['spec']['containers'][0]['command'],['/usr/local/bin/provision-runtime'])
        self.assertEqual(topics['spec']['template']['spec']['serviceAccountName'],'pipeline')
        self.assertNotIn('readinessProbe',topics['spec']['template']['spec']['containers'][0])
        self.assertTrue(any(source['secretRef']['name'].startswith('migration-secrets-') for source in migration['spec']['template']['spec']['containers'][0]['envFrom']))

    def test_database_options_cannot_override_identity_or_tls(self):
        value = deploy.secure_database_url('postgres://api_user:dummy@rds.example.com/obbian?sslmode=disable&sslrootcert=/untrusted')
        self.assertIn('sslmode=verify-full',value)
        self.assertNotIn('/untrusted',value)
        for options in ['user=admin','ssl=false','sslkey=/private-key','sslmode=require&sslmode=disable']:
            with self.assertRaises(ValueError): deploy.secure_database_url('postgres://api_user:dummy@rds.example.com/obbian?'+options)

    def test_public_readiness_retries_but_requires_exact_strict_response(self):
        response = io.BytesIO(b'{"demo":false,"authenticated":false}')
        with patch.object(deploy.urllib.request,'urlopen',side_effect=[OSError('ALB warming'),response]) as request, \
             patch.object(deploy.time,'sleep'), patch.object(deploy.time,'monotonic',return_value=0):
            deploy.wait_for_public_release('assessment.example.com',600)
            self.assertEqual(request.call_count,2)
        with patch.object(deploy.urllib.request,'urlopen',return_value=io.BytesIO(b'{}')):
            with self.assertRaises(ValueError): deploy.wait_for_public_release('assessment.example.com',1)
        with patch.object(deploy.urllib.request,'urlopen',side_effect=OSError('unavailable')), \
             patch.object(deploy.time,'monotonic',side_effect=[0,2]):
            with self.assertRaisesRegex(RuntimeError,'timed out'):
                deploy.wait_for_public_release('assessment.example.com',1)

    def test_failed_rollout_restores_previous_full_workload(self):
        args = self.arguments()
        secrets = {key:'test-value-'+'x'*40 for keys in deploy.SECRET_KEYS.values() for key in keys}
        for service in ('API','ALLOCATION','PIPELINE','AI','MIGRATION'):
            secrets[service+'_DATABASE_URL']=f'postgres://{service.lower()}_user:'+('x'*40)+'@database.example/obbian'
        secrets.update(STRIPE_SECRET_KEY='sk_test_'+'x'*40,STRIPE_WEBHOOK_SECRET='whsec_'+'x'*40,REDIS_URL='rediss://cache.example:6379/0',SERVICE_PRICES_JSON=json.dumps({'electrician':{'amountMinor':1000,'currency':'USD'}}))
        applied=[]
        failed=False
        previous={name:{'apiVersion':'apps/v1','kind':'Deployment','metadata':{'name':name,'namespace':'obbian','resourceVersion':'123'},
            'spec':{'replicas':7,'template':{'spec':{'containers':[{'name':name,'image':'previous@sha256:'+'b'*64,
            'envFrom':[{'secretRef':{'name':name+'-secrets-previous'}}],'resources':{'requests':{'cpu':'123m'}}}]}}}} for name in deploy.SERVICES}
        def fake_run(command,payload=None,check=True):
            nonlocal failed
            if command[0]=='aws': return subprocess.CompletedProcess(command,0,stdout=json.dumps(secrets))
            if 'get' in command and 'deployment' in command:
                return subprocess.CompletedProcess(command,0,stdout=json.dumps(previous[command[command.index('deployment')+1]]))
            if command[:3]==['kubectl','apply','-f']:
                applied.extend(yaml.safe_load_all(payload))
            if 'rollout' in command and check and not failed:
                failed=True
                raise RuntimeError('simulated rollout failure')
            return subprocess.CompletedProcess(command,0,stdout='')
        with tempfile.TemporaryDirectory() as directory:
            images=Path(directory)/'images.json';images.write_text(json.dumps(args.images))
            argv=['deploy.py','--images',str(images),'--release',args.release,'--region',args.region,'--hostname',args.hostname,
                  '--certificate-arn',args.certificate_arn,'--secret-id','test-secret']
            with patch.object(sys,'argv',argv),patch.object(deploy,'run',side_effect=fake_run):
                with self.assertRaisesRegex(RuntimeError,'simulated rollout failure'):
                    deploy.main()
        restored=[doc for doc in applied if doc.get('kind')=='Deployment' and doc['spec'].get('replicas')==7]
        self.assertEqual(len(restored),5)
        self.assertEqual(restored[0]['spec']['template']['spec']['containers'][0]['resources']['requests']['cpu'],'123m')
        self.assertTrue(all(doc['spec']['template']['spec']['containers'][0]['envFrom'][0]['secretRef']['name'].endswith('-previous') for doc in restored))
        self.assertTrue(all(doc.get('immutable') for doc in applied if doc.get('kind')=='Secret'))

if __name__=='__main__': unittest.main()
