#!/usr/bin/env python3
"""Isolated live regressions for booking/payment correctness against Docker Compose.
Creates a unique tenant and retains it as auditable evidence. No existing data is deleted.
"""
from __future__ import annotations
import hashlib
import base64
import hmac
import json
import os
import subprocess
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from uuid import uuid4

BASE = os.environ.get('API_URL', 'http://localhost:3001')
SECRET = os.environ.get('SANDBOX_WEBHOOK_SECRET', 'local-webhook-secret')
TENANT, CUSTOMER, FINANCE, USER1, USER2, PROFESSIONAL1, PROFESSIONAL2, CATEGORY = [str(uuid4()) for _ in range(8)]

def sql(statement):
    result = subprocess.run(['docker', 'compose', 'exec', '-T', 'database', 'psql', '-U', 'obbian', '-d', 'obbian', '-v', 'ON_ERROR_STOP=1', '-tA'], input=statement, text=True, capture_output=True, check=True)
    return result.stdout.strip()

def sql_rejected(statement, expected):
    result = subprocess.run(['docker','compose','exec','-T','database','psql','-U','obbian','-d','obbian','-v','ON_ERROR_STOP=1'],input=statement,text=True,capture_output=True)
    assert result.returncode != 0 and expected in result.stderr, result.stderr

def call(method, path, actor=CUSTOMER, body=None, extra=None):
    headers = {'content-type': 'application/json', 'x-tenant-id': TENANT, 'x-actor-id': actor}
    token = os.environ.get('INTERNAL_SERVICE_TOKEN')
    if token: headers['authorization'] = f'Bearer {token}'
    headers.update(extra or {})
    payload = json.dumps(body, separators=(',', ':')).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=payload, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=20) as response:
            return response.status, json.loads(response.read() or b'null')
    except urllib.error.HTTPError as error:
        return error.code, json.loads(error.read() or b'null')

def ok(method, path, actor=CUSTOMER, body=None, extra=None):
    code, result = call(method, path, actor, body, extra)
    assert code in (200, 201), (path, code, result)
    return result

def webhook(payment, kind, amount, event_id=None, refund_id=None):
    payload = {'eventId': event_id or f'evt_{uuid4()}', 'type': kind, 'gatewayPaymentId': payment['gatewayPaymentId'], 'amountMinor': amount}
    if refund_id: payload['refundId'] = refund_id
    raw = json.dumps(payload, separators=(',', ':')).encode()
    signature = hmac.new(SECRET.encode(), raw, hashlib.sha256).hexdigest()
    return ok('POST', '/webhooks/sandbox', body=payload, extra={'x-sandbox-signature': signature})

def tracking_session():
    secret = os.environ.get('AUTH_SIGNING_SECRET', 'local-development-only-secret-32-characters')
    def encode(value): return base64.urlsafe_b64encode(json.dumps(value,separators=(',',':')).encode()).rstrip(b'=').decode()
    header = encode({'alg':'HS256','typ':'JWT'})
    payload = encode({'sub':CUSTOMER,'tenantId':TENANT,'aud':'obbian','exp':int(time.time())+300})
    signature = base64.urlsafe_b64encode(hmac.new(secret.encode(),f'{header}.{payload}'.encode(),hashlib.sha256).digest()).rstrip(b'=').decode()
    with urllib.request.urlopen(BASE+'/socket.io/?EIO=4&transport=polling',timeout=5) as response:
        sid = json.loads(response.read().decode()[1:])['sid']
    url = BASE+'/socket.io/?EIO=4&transport=polling&sid='+sid
    # Spoofed actorId is ignored: the signed customer's identity chooses the room.
    packet = '40/tracking,'+json.dumps({'token':f'{header}.{payload}.{signature}','actorId':FINANCE})
    req = urllib.request.Request(url,data=packet.encode(),headers={'content-type':'text/plain'},method='POST')
    with urllib.request.urlopen(req,timeout=5) as response: response.read()
    with urllib.request.urlopen(url,timeout=5) as response:
        assert '40/tracking,' in response.read().decode()
    time.sleep(.1)
    return url

def await_offer(booking, user, timeout=25):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        offers = ok('GET', '/professionals/me/offers', user)
        for offer in offers:
            if offer['bookingId'] == booking['id']: return offer
        time.sleep(.15)
    raise AssertionError(f'no offer for {booking} and {user}')

def booking(offset=0):
    body = {'categoryId': CATEGORY, 'latitude': 28.6139, 'longitude': 77.209,
        'address': 'Isolated integrity regression', 'scheduledFor': (datetime.now(UTC) + timedelta(days=14, hours=offset)).isoformat(),
        'durationMinutes': 60}
    key = str(uuid4())
    result = ok('POST', '/bookings', body=body, extra={'idempotency-key': key})
    return {**result, '_request': body, '_key': key}

def main():
    sql(f"""BEGIN;
      INSERT INTO tenants(id,name) VALUES ('{TENANT}','Integrity regression');
      INSERT INTO app_users(id,tenant_id,external_subject,display_name,roles) VALUES
        ('{CUSTOMER}','{TENANT}','customer','Test customer',ARRAY['customer']),
        ('{FINANCE}','{TENANT}','finance','Test finance',ARRAY['finance']),
        ('{USER1}','{TENANT}','pro1','Test pro 1',ARRAY['professional']),
        ('{USER2}','{TENANT}','pro2','Test pro 2',ARRAY['professional']);
      INSERT INTO service_categories(id,tenant_id,slug,name) VALUES ('{CATEGORY}','{TENANT}','electrician','Electrician');
      INSERT INTO professionals(id,tenant_id,user_id,status,location,location_recorded_at,rating) VALUES
        ('{PROFESSIONAL1}','{TENANT}','{USER1}','available',ST_SetSRID(ST_MakePoint(77.209,28.6139),4326)::geography,now(),5),
        ('{PROFESSIONAL2}','{TENANT}','{USER2}','available',ST_SetSRID(ST_MakePoint(77.21,28.615),4326)::geography,now(),4);
      INSERT INTO professional_services(professional_id,category_id) VALUES ('{PROFESSIONAL1}','{CATEGORY}'),('{PROFESSIONAL2}','{CATEGORY}');
      COMMIT;""")
    checks = []
    code, _ = call('GET', '/payments/reconciliation/report', extra={'x-roles': 'finance'})
    assert code in (401, 403), code
    code, _ = call('GET', '/categories/electrician', extra={'x-tenant-id': str(uuid4())})
    assert code == 401, code
    checks.append('forged roles and cross-tenant identity rejected')

    availability = {'categoryId':CATEGORY,'latitude':28.62,'longitude':77.209,
        'scheduledFor':(datetime.now(UTC)+timedelta(days=10)).isoformat(),'durationMinutes':60,'maxEtaSeconds':120}
    assert not ok('POST','/availability/check',body=availability)['available']
    availability['maxEtaSeconds'] = 1800
    assert ok('POST','/availability/check',body=availability)['eligible_count'] == 2
    checks.append('ETA budget filters otherwise eligible professionals')
    first = booking()
    code, _ = call('POST','/bookings',USER1,first['_request'],{'idempotency-key':first['_key']})
    assert code == 409
    checks.append('booking idempotency key cannot disclose another actor booking response')
    offer1 = await_offer(first, USER1)
    ok('POST', f"/offers/{offer1['id']}/reject", USER1, {})
    offer2 = await_offer(first, USER2)
    ok('POST', f"/offers/{offer2['id']}/accept", USER2, {})
    checks.append('rejection automatically reassigned to next eligible professional')
    tracking_url = tracking_session()
    stamp = datetime.now(UTC).isoformat()
    code, _ = call('POST', f"/bookings/{first['id']}/locations", CUSTOMER, {'latitude': 28.614, 'longitude': 77.21, 'recordedAt': stamp})
    assert code == 409
    ok('POST', f"/bookings/{first['id']}/locations", USER2, {'latitude': 28.614, 'longitude': 77.21, 'recordedAt': stamp})
    location = ok('GET', f"/bookings/{first['id']}/locations/latest")
    assert location['latitude'] == 28.614, location
    with urllib.request.urlopen(tracking_url,timeout=5) as response:
        notification = response.read().decode()
    assert 'booking.location' in notification and first['id'] in notification, notification
    checks.append('signed actor tracking, committed cross-process notification, write authorization and reconnect snapshot')

    def pay(key): return ok('POST', '/payments', body={'bookingId': first['id'], 'amountMinor': 101, 'currency': 'INR'}, extra={'idempotency-key': key})
    with ThreadPoolExecutor(max_workers=6) as executor:
        payments = list(executor.map(pay, [str(uuid4()) for _ in range(6)]))
    assert len({p['id'] for p in payments}) == 1, payments
    payment = payments[0]
    checks.append('concurrent new payment keys produce one charge intent per booking')

    refund_id = f'refund_{uuid4()}'
    deferred = webhook(payment, 'payment.refunded', 1, refund_id=refund_id)
    assert deferred.get('deferred'), deferred
    event_id = f'capture_{uuid4()}'
    with ThreadPoolExecutor(max_workers=6) as executor:
        responses = list(executor.map(lambda _: webhook(payment, 'payment.captured', 101, event_id), range(6)))
    assert sum(not r['duplicate'] for r in responses) == 1, responses
    assert webhook(payment, 'payment.captured', 101)['duplicate']
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        stored = ok('GET', f"/payments/{payment['id']}")
        if int(stored['refundedMinor']) == 1: break
        time.sleep(.2)
    assert int(stored['refundedMinor']) == 1, stored
    assert webhook(payment, 'payment.refunded', 1, refund_id=refund_id)['duplicate']
    for amount in (2, 3, 17, 78): webhook(payment, 'payment.refunded', amount)
    assert ok('GET', f"/payments/{payment['id']}")['status'] == 'refunded'
    assert webhook(payment, 'payment.captured', 101)['duplicate']
    balance = sql(f"SELECT COALESCE(sum(CASE WHEN e.direction='credit' THEN e.amount_minor ELSE -e.amount_minor END),0) FROM ledger_entries e JOIN ledger_accounts a ON a.id=e.account_id WHERE a.tenant_id='{TENANT}' AND a.owner_type IN ('platform','professional');")
    assert balance == '0', balance
    checks.append('concurrent duplicate capture, delayed capture, out-of-order refund recovery, refund business-id dedup and exact full reversal')

    ok('POST', f"/bookings/{first['id']}/start", USER2, {})
    ok('POST', f"/bookings/{first['id']}/complete", USER2, {})
    assert sql(f"SELECT active FROM professional_assignments WHERE booking_id='{first['id']}';") == 'f'
    checks.append('booking completion releases assignment')

    second = booking(2)
    offer = await_offer(second, USER1)
    ok('POST', f"/offers/{offer['id']}/accept", USER1, {})
    second_payment = ok('POST', '/payments', body={'bookingId': second['id'], 'amountMinor': 101, 'currency': 'INR'}, extra={'idempotency-key': str(uuid4())})
    webhook(second_payment, 'payment.captured', 101)
    # Capture predates cutoff, payout occurs after cutoff. Historical-cutoff replays
    # must include the payout debit even though it was recorded after periodEnd.
    cutoff = datetime.now(UTC).isoformat()
    settlement_body = {'professionalId': PROFESSIONAL1, 'currency': 'INR', 'periodStart': (datetime.now(UTC)-timedelta(days=1)).isoformat(), 'periodEnd': cutoff}
    key = str(uuid4())
    settlement = ok('POST', '/settlements', FINANCE, settlement_body, {'idempotency-key': key})
    assert int(settlement['amountMinor']) == 86
    replay = ok('POST', '/settlements', FINANCE, settlement_body, {'idempotency-key': key})
    assert replay == settlement
    with ThreadPoolExecutor(max_workers=4) as executor:
        payouts = list(executor.map(lambda _: call('POST', '/settlements', FINANCE, settlement_body, {'idempotency-key': str(uuid4())}), range(4)))
    assert all(code == 409 for code, _ in payouts), payouts
    checks.append('historical settlement cutoff and concurrent new keys cannot pay earnings twice')
    report = ok('GET', '/payments/reconciliation/report', FINANCE)
    assert report['mismatchCount'] == 0 and not report['pendingWebhooks'], report
    checks.append('reconciliation agrees after retries and duplicate business events')
    transaction_id, account_id = str(uuid4()), str(uuid4())
    sql_rejected(f"BEGIN; INSERT INTO ledger_transactions(id,tenant_id,reference_type,reference_id,kind,idempotency_key) VALUES ('{transaction_id}','{TENANT}','test','{transaction_id}','test','empty-{transaction_id}'); COMMIT;", 'unbalanced ledger')
    sql_rejected(f"BEGIN; INSERT INTO ledger_transactions(id,tenant_id,reference_type,reference_id,kind,idempotency_key) VALUES ('{transaction_id}','{TENANT}','test','{transaction_id}','test','currency-{transaction_id}'); INSERT INTO ledger_accounts(id,tenant_id,owner_type,owner_id,code,currency) VALUES ('{account_id}','{TENANT}','platform','{TENANT}','negative-test','INR'); INSERT INTO ledger_entries(transaction_id,account_id,direction,amount_minor,currency) VALUES ('{transaction_id}','{account_id}','debit',1,'USD'); COMMIT;", 'currency mismatch')
    checks.append('database rejects empty ledger transactions and mismatched account currencies')

    timed = booking(4)
    expired_offer = await_offer(timed,USER1)
    replacement = await_offer(timed,USER2,timeout=25)
    assert replacement['id'] != expired_offer['id']
    assert sql(f"SELECT status FROM booking_offers WHERE id='{expired_offer['id']}';") == 'expired'
    ok('POST',f"/bookings/{timed['id']}/cancel",body={})
    code, _ = call('POST',f"/offers/{replacement['id']}/accept",USER2,{})
    assert code == 409
    checks.append('expired offer automatically reassigned; cancellation cannot be revived by late acceptance')
    print(json.dumps({'status': 'passed', 'tenantId': TENANT, 'checks': checks}, indent=2))

if __name__ == '__main__': main()
