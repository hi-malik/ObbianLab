#!/usr/bin/env python3
"""Run psql with the database password only in its environment, never argv."""
import os
import sys
from urllib.parse import parse_qsl, unquote, urlsplit

try:
    environment = dict(os.environ)
    url = urlsplit(environment.pop('DATABASE_URL'))
    if url.scheme not in ('postgres','postgresql') or not url.hostname or not url.username:
        raise ValueError('invalid database URL')
    environment.update(PGHOST=url.hostname, PGPORT=str(url.port or 5432),
                       PGUSER=unquote(url.username), PGPASSWORD=unquote(url.password or ''),
                       PGDATABASE=unquote(url.path.lstrip('/')))
    options = {'sslmode':'PGSSLMODE','sslrootcert':'PGSSLROOTCERT','sslcert':'PGSSLCERT',
               'sslkey':'PGSSLKEY','connect_timeout':'PGCONNECT_TIMEOUT','application_name':'PGAPPNAME',
               'target_session_attrs':'PGTARGETSESSIONATTRS','options':'PGOPTIONS'}
    for key,value in parse_qsl(url.query):
        if key not in options:
            raise ValueError('unsupported database URL parameter')
        environment[options[key]] = value
    os.execvpe('psql',['psql',*sys.argv[1:]],environment)
except (KeyError,ValueError):
    print('A valid DATABASE_URL with supported libpq options is required; secret values were not logged.',file=sys.stderr)
    sys.exit(1)
