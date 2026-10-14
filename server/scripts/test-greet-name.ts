// The name a QR or link message greets a donor by. No database needed.
import assert from 'node:assert/strict';
import { greetName } from '../src/utils/greetName';

const cases: Array<[string | null, string]> = [
  ['D chaitanya', 'Chaitanya'],
  ['D. Chaitanya', 'Chaitanya'],
  ['K. Ravi Kumar', 'Ravi Kumar'],
  ['D.V. Rao', 'Rao'],
  ['DV Rao', 'Rao'],
  ['K S R Murthy', 'Murthy'],
  ['Chaitanya D', 'Chaitanya'],
  ['SITA DEVI', 'Sita Devi'],
  ['Sita Devi', 'Sita Devi'],
  ['ramesh', 'Ramesh'],
  ['Om Prakash', 'Om Prakash'],
  ['Mr. D Chaitanya', 'Chaitanya'],
  ['Smt. Lakshmi', 'Lakshmi'],
  ['McDonald', 'McDonald'],
  ['D', ''],
  ['D K', ''],
  ['ravi@okicici', ''],
  ['Donor 9876543210', ''],
  ['', ''],
  [null, ''],
];
let bad = 0;
for (const [input, want] of cases) {
  const got = greetName(input);
  if (got !== want) { bad++; console.log(`FAIL ${JSON.stringify(input)} -> ${JSON.stringify(got)} (want ${JSON.stringify(want)})`); }
}
assert.equal(bad, 0);
console.log(`greet name: ${cases.length} cases ok`);
