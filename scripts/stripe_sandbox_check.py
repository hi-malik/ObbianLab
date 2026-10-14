#!/usr/bin/env python3
"""Optional real Stripe TEST-mode integration. Requires API configured for stripe_test.
Never sends raw card data or live keys. Creates one Stripe test payment and refunds it.
"""
import json
import os
import time
import urllib.error
import urllib.request
from datetime import UTC, datetime, timedelta
from uuid import uuid4

API = os.environ.get('API_URL', 'http://localhost:3001')
TENANT = os.environ.get('TENANT_ID', '11111111-1111-4111-8111-111111111111')
CUSTOMER = os.environ.get('CUSTOMER_ID', '22222222-2222-4222-8222-222222222222')
PROFESSIONAL = os.environ.get('PROFESSIONAL_USER_ID', '33333333-3333-4333-8333-333333333333')
FINANCE = os.environ.get('FINANCE_ID', '66666666-6666-4666-8666-666666666666')
CATEGORY = os.environ.get('CATEGORY_ID', '55555555-5555-4555-8555-555555555551')

def call(method, path, actor=CUSTOMER, body=None, key=None):
    headers = {'content-type':'application/json','x-tenant-id':TENANT,'x-actor-id':actor}
    if key: headers['idempotency-key'] = key
    if os.environ.get('INTERNAL_SERVICE_TOKEN'): headers['authorization'] = 'Bearer '+os.environ['INTERNAL_SERVICE_TOKEN']
    req = urllib.request.Request(API+path,method=method,headers=headers,data=json.dumps(body).encode() if body is not None else None)
    with urllib.request.urlopen(req,timeout=30) as response: return json.loads(response.read() or b'null')

def main():
    call('POST','/professionals/me/presence',PROFESSIONAL,{'latitude':28.6139,'longitude':77.209,'status':'available'})
    booked = call('POST','/bookings',body={'categoryId':CATEGORY,'latitude':28.6139,'longitude':77.209,
        'address':'Stripe sandbox integration','scheduledFor':(datetime.now(UTC)+timedelta(days=30+uuid4().int%200)).isoformat(),
        'durationMinutes':60},key=str(uuid4()))
    deadline = time.monotonic()+15
    while time.monotonic()<deadline:
        offers = call('GET','/professionals/me/offers',PROFESSIONAL)
        offer = next((o for o in offers if o['bookingId']==booked['id']),None)
        if offer: break
        time.sleep(.2)
    assert offer, 'allocation offer not received'
    call('POST',f"/offers/{offer['id']}/accept",PROFESSIONAL,{})
    key = str(uuid4())
    quote = call('GET',f"/payments/quote/{booked['id']}")
    amount = quote['amountMinor'] or int(os.environ.get('STRIPE_TEST_AMOUNT_MINOR','1000'))
    currency = quote['currency'] or os.environ.get('STRIPE_TEST_CURRENCY','USD')
    payment_body = {'bookingId':booked['id'],'amountMinor':amount,'currency':currency}
    payment = call('POST','/payments',body=payment_body,key=key)
    assert payment['gatewayPaymentId'].startswith('pi_'), 'API must be configured PAYMENT_GATEWAY=stripe_test'
    assert call('POST','/payments',body=payment_body,key=key) == payment
    confirmation = call('POST',f"/payments/{payment['id']}/sandbox-confirm",body={})
    assert confirmation['gatewayStatus']=='succeeded', confirmation
    report = call('POST',f"/payments/{payment['id']}/reconcile",FINANCE,{})
    assert report['matches'] and report['localStatus']=='captured', report
    transfer = None
    if os.environ.get('RUN_STRIPE_CONNECT_TRANSFER') == '1':
        settlement_key = str(uuid4())
        settlement_body = {'professionalId':os.environ.get('PROFESSIONAL_ID','44444444-4444-4444-8444-444444444444'),
            'currency':currency,'periodStart':(datetime.now(UTC)-timedelta(days=1)).isoformat(),
            'periodEnd':(datetime.now(UTC)+timedelta(seconds=1)).isoformat()}
        transfer = call('POST','/settlements',FINANCE,settlement_body,settlement_key)
        assert transfer['status']=='paid' and transfer['gatewayPayoutId'].startswith('tr_'),transfer
        assert call('POST','/settlements',FINANCE,settlement_body,settlement_key)==transfer
    refund_key = str(uuid4())
    refund = call('POST',f"/payments/{payment['id']}/refunds",FINANCE,{'amountMinor':amount},refund_key)
    assert call('POST',f"/payments/{payment['id']}/refunds",FINANCE,{'amountMinor':amount},refund_key)==refund
    deadline = time.monotonic()+30
    while time.monotonic()<deadline:
        report = call('POST',f"/payments/{payment['id']}/reconcile",FINANCE,{})
        if report['localStatus']=='refunded': break
        time.sleep(1)
    assert report['matches'] and report['localStatus']=='refunded', report
    call('POST',f"/bookings/{booked['id']}/start",PROFESSIONAL,{})
    call('POST',f"/bookings/{booked['id']}/complete",PROFESSIONAL,{})
    print(json.dumps({'status':'passed','gateway':'stripe_test','paymentId':payment['id'],
        'gatewayPaymentId':payment['gatewayPaymentId'],'refundId':refund['refundId'],'reconciliation':report,'connectTransfer':transfer},indent=2))

if __name__=='__main__': main()
