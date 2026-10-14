#!/usr/bin/env python3
"""Local Compose database restart drill; requires an already healthy demo stack."""
import json
from pathlib import Path
import subprocess
import time
import urllib.request
from datetime import UTC, datetime

ENDPOINTS=['http://localhost:3001/health/ready','http://localhost:8000/health/ready','http://localhost:8080/health/ready']
def ready():
    try:
        for url in ENDPOINTS:
            with urllib.request.urlopen(url,timeout=2) as response:
                if response.status!=200:return False
        result=subprocess.run(['docker','compose','exec','-T','pipeline','wget','-qO-','http://127.0.0.1:8090/health/ready'],capture_output=True,timeout=5)
        return result.returncode==0
    except (OSError,subprocess.TimeoutExpired):return False

def sql(statement):
    return subprocess.check_output(['docker','compose','exec','-T','database','psql','-U','obbian','-d','obbian','-Atc',statement],text=True).strip()

def main():
    assert ready(),'Start healthy Compose services before the drill'
    started=time.monotonic()
    subprocess.run(['docker','compose','restart','database'],check=True,stdout=subprocess.DEVNULL)
    while time.monotonic()-started<90:
        if ready():break
        time.sleep(.5)
    else:raise AssertionError('Services did not recover after database restart')
    recovery=round(time.monotonic()-started,3)
    # Exercise actual writes after recovery, including payment/RAG and durable AI.
    subprocess.run(['python3','scripts/smoke.py'],check=True,stdout=subprocess.DEVNULL)
    subprocess.run(['python3','scripts/pipeline_replay_check.py'],check=True,stdout=subprocess.DEVNULL)
    unbalanced=int(sql("SELECT count(*) FROM (SELECT transaction_id FROM ledger_entries GROUP BY transaction_id HAVING sum(CASE WHEN direction='debit' THEN amount_minor ELSE -amount_minor END)<>0) x"))
    assert unbalanced==0
    result={'recorded_at':datetime.now(UTC).isoformat(),'status':'passed','failure':'local database container restart',
            'all_service_readiness_seconds':recovery,'post_recovery_smoke':'passed','post_recovery_replay':'passed',
            'unbalanced_ledger_transactions':unbalanced,'limitation':'Single-node Docker recovery, not AWS failover, restore RPO or regional RTO'}
    Path('benchmark-results/recovery-local.json').write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps(result,indent=2))

if __name__=='__main__':main()
