#!/usr/bin/env python3
"""Measure local sandbox payment HTTP writes and concurrent duplicate consistency.
Creates a dedicated retained fixture tenant; never calls a real payment gateway.
"""
from __future__ import annotations
import hashlib
import hmac
import json
import os
from pathlib import Path
import statistics
import subprocess
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime
from uuid import uuid4

BASE = os.getenv('API_URL','http://localhost:3001')
COUNT = int(os.getenv('PAYMENTS_BENCHMARK_COUNT','100'))
CONCURRENCY = int(os.getenv('PAYMENTS_BENCHMARK_CONCURRENCY','10'))
AMOUNT = 10000
TENANT,CUSTOMER,USER,PROFESSIONAL,CATEGORY = [str(uuid4()) for _ in range(5)]

def sql(statement):
    return subprocess.run(['docker','compose','exec','-T','database','psql','-U','obbian','-d','obbian','-v','ON_ERROR_STOP=1','-At'],
        input=statement,text=True,capture_output=True,check=True).stdout.strip()

def call(path,body,extra=None):
    headers={'content-type':'application/json','x-tenant-id':TENANT,'x-actor-id':CUSTOMER}
    if os.getenv('INTERNAL_SERVICE_TOKEN'): headers['authorization']='Bearer '+os.environ['INTERNAL_SERVICE_TOKEN']
    headers.update(extra or {})
    raw=json.dumps(body,separators=(',',':')).encode()
    start=time.perf_counter()
    with urllib.request.urlopen(urllib.request.Request(BASE+path,data=raw,headers=headers,method='POST'),timeout=30) as response:
        value=json.load(response)
    return value,(time.perf_counter()-start)*1000

def percentiles(samples):
    ordered=sorted(samples)
    return {'count':len(ordered),'p50Ms':round(statistics.median(ordered),2),'p95Ms':round(ordered[max(0,int(len(ordered)*.95)-1)],2),
            'maxMs':round(max(ordered),2)}

def main():
    assert COUNT>0 and 1<=CONCURRENCY<=100
    # Fail closed if accidentally pointed at a configured real gateway deployment.
    mode=subprocess.run(['docker','compose','exec','-T','api','node','-e','process.stdout.write(process.env.PAYMENT_GATEWAY || "sandbox")'],
        text=True,capture_output=True,check=True).stdout.strip()
    if mode!='sandbox': raise RuntimeError('This benchmark only supports the local simulated sandbox gateway')
    bookings=[str(uuid4()) for _ in range(COUNT)]
    values=','.join(f"('{booking}','{TENANT}','{CUSTOMER}','{CATEGORY}','confirmed','{PROFESSIONAL}',ST_SetSRID(ST_MakePoint(77,28),4326)::geography,'Payment load fixture',now(),interval '1 hour')" for booking in bookings)
    sql(f"""BEGIN;
      INSERT INTO tenants(id,name) VALUES('{TENANT}','Payment throughput benchmark');
      INSERT INTO app_users(id,tenant_id,external_subject,display_name,roles) VALUES
        ('{CUSTOMER}','{TENANT}','customer','Load customer',ARRAY['customer']),
        ('{USER}','{TENANT}','professional','Load professional',ARRAY['professional']);
      INSERT INTO service_categories(id,tenant_id,slug,name) VALUES('{CATEGORY}','{TENANT}','electrician','Electrician');
      INSERT INTO professionals(id,tenant_id,user_id,status) VALUES('{PROFESSIONAL}','{TENANT}','{USER}','busy');
      INSERT INTO bookings(id,tenant_id,customer_id,category_id,status,assigned_professional_id,pickup,address,scheduled_for,expected_duration) VALUES {values};
      COMMIT;""")
    if sql("SELECT to_regclass('public.booking_quotes') IS NOT NULL")=='t':
        sql(f"INSERT INTO booking_quotes(booking_id,tenant_id,customer_id,category_slug,amount_minor,currency,policy_hash) SELECT id,tenant_id,customer_id,'electrician',{AMOUNT},'INR','benchmark-fixture' FROM bookings WHERE tenant_id='{TENANT}';")
    def payment(booking):
        intent,intent_ms=call('/payments',{'bookingId':booking,'amountMinor':AMOUNT,'currency':'INR'}, {'idempotency-key':str(uuid4())})
        if not intent['gatewayPaymentId'].startswith('sbx_'): raise RuntimeError('refusing non-sandbox payment')
        body={'eventId':'load_'+str(uuid4()),'type':'payment.captured','gatewayPaymentId':intent['gatewayPaymentId'],'amountMinor':AMOUNT}
        raw=json.dumps(body,separators=(',',':')).encode()
        signature=hmac.new(os.getenv('SANDBOX_WEBHOOK_SECRET','local-webhook-secret').encode(),raw,hashlib.sha256).hexdigest()
        _,capture_ms=call('/webhooks/sandbox',body,{'x-sandbox-signature':signature})
        _,duplicate_ms=call('/webhooks/sandbox',body,{'x-sandbox-signature':signature})
        return intent_ms,capture_ms,duplicate_ms
    started=time.perf_counter()
    with ThreadPoolExecutor(max_workers=CONCURRENCY) as executor: results=list(executor.map(payment,bookings))
    request_seconds=time.perf_counter()-started
    deadline=time.monotonic()+20
    while time.monotonic()<deadline:
        captured=int(sql(f"SELECT count(*) FROM payment_intents WHERE tenant_id='{TENANT}' AND status='captured'"))
        if captured==COUNT: break
        time.sleep(.2)
    end_to_end_seconds=time.perf_counter()-started
    assert captured==COUNT,(captured,COUNT)
    ledger_count,unbalanced,total=map(int,sql(f"""SELECT count(*),count(*) FILTER(WHERE balance<>0),sum(debits) FROM (
      SELECT t.id,sum(CASE WHEN e.direction='debit' THEN e.amount_minor ELSE -e.amount_minor END) AS balance,
             sum(CASE WHEN e.direction='debit' THEN e.amount_minor ELSE 0 END) AS debits
      FROM ledger_transactions t JOIN ledger_entries e ON e.transaction_id=t.id
      WHERE t.tenant_id='{TENANT}' AND t.kind='capture' GROUP BY t.id) facts;""").split('|'))
    assert (ledger_count,unbalanced,total)==(COUNT,0,COUNT*AMOUNT),(ledger_count,unbalanced,total)
    inbox_count=int(sql(f"SELECT count(*) FROM payment_webhook_inbox w JOIN payment_intents p ON p.gateway_payment_id=w.payload->>'gatewayPaymentId' WHERE p.tenant_id='{TENANT}' AND w.processed_at IS NOT NULL"))
    assert inbox_count==COUNT
    report={'status':'passed','measuredAt':datetime.now(UTC).isoformat(),'tenantId':TENANT,'gateway':'local simulated sandbox',
        'payments':COUNT,'httpRequests':COUNT*3,'concurrency':CONCURRENCY,'requestElapsedSeconds':round(request_seconds,3),
        'endToEndSeconds':round(end_to_end_seconds,3),'httpRequestsPerSecond':round(COUNT*3/request_seconds,2),
        'completedPaymentsPerSecond':round(COUNT/end_to_end_seconds,2),
        'intent':percentiles([row[0] for row in results]),'capture':percentiles([row[1] for row in results]),
        'duplicateWebhook':percentiles([row[2] for row in results]),
        'ledger':{'captureTransactions':ledger_count,'unbalancedTransactions':unbalanced,'debitedMinor':total,'processedWebhookFacts':inbox_count},
        'limits':'Short local test, preseeded confirmed bookings and quotes, no network payment gateway. Includes concurrent shared-account contention; duplicate webhooks produce no additional ledger effects.'}
    path=Path('benchmarks/results/payments-latest.json');path.parent.mkdir(parents=True,exist_ok=True);path.write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps(report,indent=2))

if __name__=='__main__':main()
