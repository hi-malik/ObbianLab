#!/usr/bin/env python3
"""Run opt-in database suites in a new migrated scratch database, then remove it."""
from pathlib import Path
import subprocess
from uuid import uuid4

ROOT=Path(__file__).resolve().parents[1]
NAME='integration_test_'+uuid4().hex[:12]
URL=f'postgres://obbian:obbian@database:5432/{NAME}'

def run(*args):subprocess.run(args,check=True)

def main():
    run('docker','compose','exec','-T','database','createdb','-U','obbian',NAME)
    try:
        run('docker','compose','run','--rm','--no-deps','-e',f'DATABASE_URL={URL}','migrate')
        run('docker','run','--rm','--network','obbian-assessment_default','-v',f'{ROOT}:/workspace','-w','/workspace',
            '-e',f'PIPELINE_TEST_DATABASE_URL={URL}','node:22-bookworm','npm','run','test:integration','-w','@obbian/pipeline')
        run('docker','run','--rm','--network','obbian-assessment_default','-v',f'{ROOT}:/workspace','-w','/workspace',
            '-e',f'TEST_DATABASE_URL={URL}','node:22-bookworm','npm','test','-w','@obbian/api')
        run('docker','run','--rm','--network','obbian-assessment_default','-v',f'{ROOT}/services/ai/tests:/app/tests:ro',
            '-v',f'{ROOT}/services/ai/pytest.ini:/app/pytest.ini:ro','-e',f'TEST_DATABASE_URL={URL}',
            '-e','PYTHONPATH=/app','-e','AUTH_MODE=demo','obbian-assessment-ai','pytest','-q','-p','no:cacheprovider','/app/tests')
    finally:run('docker','compose','exec','-T','database','dropdb','-U','obbian','--force',NAME)
    roles_name = NAME+'_roles'
    run('docker','compose','exec','-T','database','createdb','-U','obbian',roles_name)
    try:
        run('docker','run','--rm','--network','obbian-assessment_default','-v',f'{ROOT}:/workspace','-w','/workspace',
            '-e',f'DATABASE_PERMISSION_TEST_ADMIN_URL=postgres://obbian:obbian@database:5432/{roles_name}',
            'node:22-bookworm','node','scripts/database_permissions_check.mjs')
    finally:run('docker','compose','exec','-T','database','dropdb','-U','obbian','--force',roles_name)

if __name__=='__main__':main()
