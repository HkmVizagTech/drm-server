/**
 * What DRM sends to HKMV and annadan when it raises a receipt.
 *
 * No database and no network: buildOfflineBody is a pure function. Run with
 *   npm run test:payloads
 *
 * The first case is the bug this suite exists for. The donations route always
 * passes normalizeAddress(...) output, which is an object of nulls when the
 * form sent no address parts - and that empty object used to win over the
 * typed address, so HKMV and DCC received only "India" on every receipt.
 */
import assert from 'node:assert/strict';
import { buildOfflineBody, partsFromText } from '../src/services/hkmvClient';
import { normalizeAddress } from '../src/utils/address';

let passed = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.error(`  FAIL ${name}`);
    throw e;
  }
}

const base = {
  donorName: 'Test Donor',
  donorMobile: '9000000001',
  donorEmail: null,
  amount: 1001,
  paymentMode: 'cheque',
  referenceNo: 'CHQ1',
  paymentDate: null,
  sevaName: null,
  panNumber: 'ABCDE1234F',
  wantCertificate: true,
  wantPrasadam: false,
  prasadamAddress: '12-3 Beach Road, MVP Colony, Visakhapatnam 530017',
  sevakName: null,
  sevakMobile: null,
  note: null,
  enteredByName: null,
};

console.log('site payloads');

test('empty address parts do not replace the typed address (HKMV)', () => {
  const body = buildOfflineBody('hkmv', {
    ...base,
    prasadamParts: normalizeAddress(undefined),
    billingParts: normalizeAddress(undefined),
  }) as any;
  assert.equal(body.prasadamAddress.street, '12-3 Beach Road, MVP Colony');
  assert.equal(body.prasadamAddress.city, 'Visakhapatnam');
  assert.equal(body.prasadamAddress.pincode, '530017');
  assert.equal(body.manualPaymentMode, 'cheque');
  assert.equal(body.certificate, true);
});

test('empty address parts do not replace the typed address (annadan)', () => {
  const body = buildOfflineBody('annadan', {
    ...base,
    wantPrasadam: true,
    prasadamParts: normalizeAddress(undefined),
    billingParts: normalizeAddress(undefined),
  }) as any;
  assert.equal(body.address, '12-3 Beach Road, MVP Colony');
  assert.equal(body.city, 'Visakhapatnam');
  assert.equal(body.pincode, '530017');
  // Street only, so the site's "address, city - pin" does not print the city twice.
  assert.equal(body.prasadamAddress, '12-3 Beach Road, MVP Colony');
  assert.equal(body.prasadamPincode, '530017');
  assert.equal(body.prasadamName, 'Test Donor');
  assert.equal(body.offlinePaymentMode, 'cheque');
});

test('real address parts still win over the typed line', () => {
  const body = buildOfflineBody('hkmv', {
    ...base,
    prasadamParts: normalizeAddress({ door: '9', street: 'Siripuram', city: 'Visakhapatnam', pincode: '530003' }),
  }) as any;
  assert.equal(body.prasadamAddress.doorNo, '9');
  assert.equal(body.prasadamAddress.pincode, '530003');
});

test('no address is sent when neither 80G nor prasadam is asked for', () => {
  const body = buildOfflineBody('hkmv', { ...base, wantCertificate: false, panNumber: null }) as any;
  assert.equal(body.prasadamAddress, undefined);
});

test('QR payment id travels in its own field', () => {
  const hk = buildOfflineBody('hkmv', { ...base, paymentMode: 'upi', gatewayPaymentId: 'pay_X' }) as any;
  const an = buildOfflineBody('annadan', { ...base, paymentMode: 'upi', gatewayPaymentId: 'pay_X' }) as any;
  assert.equal(hk.razorpayPaymentId, 'pay_X');
  assert.equal(an.razorpayPaymentId, 'pay_X');
  assert.equal(hk.utrNumber, 'CHQ1');
  assert.equal(an.offlineRefNo, 'CHQ1');
});

test('bank transfer maps to each site\'s word', () => {
  assert.equal((buildOfflineBody('hkmv', { ...base, paymentMode: 'bank' }) as any).manualPaymentMode, 'bank');
  assert.equal((buildOfflineBody('annadan', { ...base, paymentMode: 'bank' }) as any).offlinePaymentMode, 'bank_transfer');
});

test('typed address: state and PIN are picked out', () => {
  const a = partsFromText('Flat 4, Sai Residency, Dwaraka Nagar, Visakhapatnam, Andhra Pradesh 530016')!;
  assert.equal(a.street, 'Flat 4, Sai Residency, Dwaraka Nagar');
  assert.equal(a.city, 'Visakhapatnam');
  assert.equal(a.state, 'Andhra Pradesh');
  assert.equal(a.pincode, '530016');
  const b = partsFromText('22 RK Beach Road, Visakhapatnam, AP - 530 002')!;
  assert.equal(b.state, 'Andhra Pradesh');
  assert.equal(b.city, 'Visakhapatnam');
  assert.equal(b.pincode, '530002');
  const c = partsFromText('Near temple')!;
  assert.equal(c.street, 'Near temple');
  assert.equal(c.city, null);
  assert.equal(c.pincode, null);
});

console.log(`\n${passed} passed`);
