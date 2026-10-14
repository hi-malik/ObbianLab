#!/usr/bin/env python3
"""Crash/parallel migration regression test in a newly created disposable DB."""
import concurrent.futures
from pathlib import Path
import subprocess
import tempfile
from uuid import uuid4

NAME='migration_test_'+uuid4().hex[:12]
ROOT=Path(__file__).resolve().parents[1]

def sql(query, database='obbian'):
    return subprocess.check_output(['docker','compose','exec','-T','database','psql','-U','obbian','-d',database,'-v','ON_ERROR_STOP=1','-Atc',query],text=True).strip()

def run(directory):
    return subprocess.run(['docker','run','--rm','--network','obbian-assessment_default','-v',f'{ROOT}/db/migrate.sh:/usr/local/bin/migrate:ro','-v',f'{directory}:/migrations:ro','-e',f'DATABASE_URL=postgres://obbian:obbian@database:5432/{NAME}','obbian-assessment-migrate'],capture_output=True,text=True)

def main():
    sql(f'CREATE DATABASE {NAME}')
    try:
        with tempfile.TemporaryDirectory() as directory:
            # Container UID must traverse/read the temporary fixture directory.
            path=Path(directory);path.chmod(0o755)
            migration=path/'001_fixture.sql'
            migration.write_text('BEGIN;\nCREATE TABLE migration_probe(id integer);\nSELECT 1/0;\nCOMMIT;\n')
            assert run(directory).returncode!=0
            assert sql("SELECT to_regclass('migration_probe') IS NULL",NAME)=='t'
            assert sql('SELECT count(*) FROM schema_migrations',NAME)=='0'
            migration.write_text('BEGIN;\nCREATE TABLE migration_probe(id integer);\nINSERT INTO migration_probe VALUES(1);\nCOMMIT;\n')
            with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
                results=list(pool.map(lambda _:run(directory),range(2)))
            assert all(result.returncode==0 for result in results),[r.stderr for r in results]
            assert sql('SELECT count(*) FROM migration_probe',NAME)=='1'
            assert sql('SELECT count(*) FROM schema_migrations',NAME)=='1'
            migration.write_text(migration.read_text()+'-- tampered after application\n')
            assert run(directory).returncode!=0
            print('PASS: atomic failure rollback, concurrent migrator lock, replay, and checksum tamper detection')
    finally:
        sql(f'DROP DATABASE {NAME} WITH (FORCE)')

if __name__=='__main__':main()
