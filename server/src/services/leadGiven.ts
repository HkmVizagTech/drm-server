// What a lead has given, as one figure - for "only ring people who have given
// at least ₹500" on Leads, calling lists and the runs started from them.
//
// The HIGHEST of the three things DRM knows, not their sum:
//   - donations on their donor record (the sites, receipts),
//   - the lifetime total the office's own sheet came with
//     (external_total_donated - "in temple accounts"),
//   - money given after a call that is not on a donor record yet.
// They overlap - the office's total usually already includes the website
// donations - so adding them would count the same money twice.

export const GIVEN = (l: string) => `GREATEST(
  COALESCE(${l}.external_total_donated, 0),
  COALESCE(${l}.converted_amount, 0),
  COALESCE((SELECT SUM(gd.amount) FROM donations gd
             WHERE ${l}.person_id IS NOT NULL AND gd.person_id = ${l}.person_id), 0))`;
