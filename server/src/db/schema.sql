-- People
CREATE TABLE IF NOT EXISTS people (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  phone VARCHAR(20) UNIQUE NOT NULL,
  email VARCHAR(255),
  address TEXT,
  pan VARCHAR(10),
  roles TEXT[] NOT NULL DEFAULT '{}',
  date_of_birth DATE,
  anniversary_date DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_people_phone ON people(phone);
CREATE INDEX IF NOT EXISTS idx_people_roles ON people USING GIN(roles);

-- Donations
CREATE TABLE IF NOT EXISTS donations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id UUID NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  amount NUMERIC(12, 2) NOT NULL,
  type VARCHAR(20) NOT NULL DEFAULT 'one-time',
  purpose VARCHAR(30) NOT NULL DEFAULT 'general',
  payment_mode VARCHAR(20) NOT NULL,
  source VARCHAR(30) NOT NULL DEFAULT 'website',
  receipt_generated BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_donations_person ON donations(person_id);
CREATE INDEX IF NOT EXISTS idx_donations_created ON donations(created_at);
CREATE INDEX IF NOT EXISTS idx_donations_purpose ON donations(purpose);

-- Events
CREATE TABLE IF NOT EXISTS events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  date_start TIMESTAMPTZ NOT NULL,
  date_end TIMESTAMPTZ NOT NULL,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seva/Prasad Bookings
CREATE TABLE IF NOT EXISTS seva_bookings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id UUID NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  seva_type VARCHAR(100) NOT NULL,
  event_id UUID REFERENCES events(id) ON DELETE SET NULL,
  slot_datetime TIMESTAMPTZ NOT NULL,
  slots_booked INT NOT NULL DEFAULT 1,
  max_slots INT NOT NULL DEFAULT 50,
  status VARCHAR(15) NOT NULL DEFAULT 'confirmed',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_seva_person ON seva_bookings(person_id);
CREATE INDEX IF NOT EXISTS idx_seva_slot ON seva_bookings(slot_datetime);
CREATE INDEX IF NOT EXISTS idx_seva_event ON seva_bookings(event_id);

-- Triggers/Outbox (feeds wapi.harekrishnavizag.org)
CREATE TABLE IF NOT EXISTS triggers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id UUID NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  trigger_type VARCHAR(30) NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}',
  status VARCHAR(10) NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_triggers_status ON triggers(status);
CREATE INDEX IF NOT EXISTS idx_triggers_type ON triggers(trigger_type);

-- Users (admin/auth)
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role VARCHAR(30) NOT NULL DEFAULT 'admin',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seva Types (define available sevas)
CREATE TABLE IF NOT EXISTS seva_types (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(100) UNIQUE NOT NULL,
  description TEXT,
  default_max_slots INT NOT NULL DEFAULT 50,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- Donor Relationship Manager extensions (subscriptions, receipts,
-- prasadam delivery tracking, staff notes)
-- ============================================================

-- Subscriptions (recurring donations / "monthly sankalpa")
CREATE TABLE IF NOT EXISTS subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id UUID NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  amount NUMERIC(12, 2) NOT NULL,
  frequency VARCHAR(20) NOT NULL DEFAULT 'monthly',
  purpose VARCHAR(30) NOT NULL DEFAULT 'general',
  status VARCHAR(15) NOT NULL DEFAULT 'active',
  gateway_subscription_id VARCHAR(100),
  start_date DATE NOT NULL DEFAULT CURRENT_DATE,
  next_charge_date DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_person ON subscriptions(person_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_status ON subscriptions(status);
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS external_ref VARCHAR(64) UNIQUE;

-- Link a donation back to the subscription cycle that produced it
ALTER TABLE donations ADD COLUMN IF NOT EXISTS subscription_id UUID REFERENCES subscriptions(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_donations_subscription ON donations(subscription_id);

-- Real receipt data per donation (was just a boolean before)
ALTER TABLE donations ADD COLUMN IF NOT EXISTS receipt_number VARCHAR(50);
ALTER TABLE donations ADD COLUMN IF NOT EXISTS receipt_url TEXT;
ALTER TABLE donations ADD COLUMN IF NOT EXISTS receipt_issued_at TIMESTAMPTZ;

-- External reference for rows synced in from hkmsite2.0 (the donor portal's
-- Mongo _id for a donation, or its Razorpay subscriptionId) - NULL for
-- donations/subscriptions/deliveries created natively in DRM. Lets a sync
-- re-run safely with an upsert instead of creating duplicates each time.
ALTER TABLE donations ADD COLUMN IF NOT EXISTS external_ref VARCHAR(64) UNIQUE;

-- Saved prasadam delivery address on a person's profile (mirrors the donor portal)
ALTER TABLE people ADD COLUMN IF NOT EXISTS prasadam_address TEXT;

-- Prasadam deliveries
CREATE TABLE IF NOT EXISTS prasadam_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id UUID NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  donation_id UUID REFERENCES donations(id) ON DELETE SET NULL,
  address TEXT NOT NULL,
  status VARCHAR(15) NOT NULL DEFAULT 'pending',
  courier_name VARCHAR(100),
  tracking_number VARCHAR(100),
  dispatched_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_prasadam_person ON prasadam_deliveries(person_id);
CREATE INDEX IF NOT EXISTS idx_prasadam_status ON prasadam_deliveries(status);
ALTER TABLE prasadam_deliveries ADD COLUMN IF NOT EXISTS external_ref VARCHAR(64) UNIQUE;

-- Staff notes on a person - lightweight CRM log, NOT a full audit trail
CREATE TABLE IF NOT EXISTS person_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id UUID NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  author_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  note TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_person_notes_person ON person_notes(person_id);

-- ---------------------------------------------------------------------------
-- Multi-site attribution
--
-- Donations reach DRM from more than one place: the main site
-- (harekrishnavizag.org), the separate annadan site
-- (annadan.harekrishnavizag.org), and manual entry here. Within a site, a donation
-- also comes from a specific page or campaign - /donate, /janmashtami,
-- /govardhan and so on - which the source sites already record. Keeping these
-- as three separate columns means totals can be split by site, by page, or by
-- campaign without parsing a blob.
ALTER TABLE donations ADD COLUMN IF NOT EXISTS source_site  VARCHAR(20) NOT NULL DEFAULT 'drm';
ALTER TABLE donations ADD COLUMN IF NOT EXISTS source_page  VARCHAR(120);
ALTER TABLE donations ADD COLUMN IF NOT EXISTS campaign     VARCHAR(120);
ALTER TABLE donations ADD COLUMN IF NOT EXISTS utm_source   VARCHAR(80);
ALTER TABLE donations ADD COLUMN IF NOT EXISTS utm_medium   VARCHAR(80);
ALTER TABLE donations ADD COLUMN IF NOT EXISTS utm_campaign VARCHAR(120);
ALTER TABLE donations ADD COLUMN IF NOT EXISTS payment_ref  VARCHAR(80);

CREATE INDEX IF NOT EXISTS idx_donations_source_site ON donations(source_site);
CREATE INDEX IF NOT EXISTS idx_donations_source_page ON donations(source_page);
CREATE INDEX IF NOT EXISTS idx_donations_campaign    ON donations(campaign);

-- Which site a person's donor record originated from, so staff can tell an
-- annadan-only donor from a main-site donor at a glance.
ALTER TABLE people ADD COLUMN IF NOT EXISTS source_sites TEXT[] NOT NULL DEFAULT '{}';

-- Subscriptions and prasadam carry the site too - annadan runs its own
-- recurring donations and its own prasadam dispatch, separate from the main site's.
ALTER TABLE subscriptions        ADD COLUMN IF NOT EXISTS source_site VARCHAR(20) NOT NULL DEFAULT 'drm';
ALTER TABLE prasadam_deliveries  ADD COLUMN IF NOT EXISTS source_site VARCHAR(20) NOT NULL DEFAULT 'drm';

-- ---------------------------------------------------------------------------
-- Prasadam fulfilment: who marked it, and when it was marked here.
--
-- delivered_at is the courier's delivery date (it can come from an uploaded
-- file and be backdated). marked_at is when a person in DRM recorded it, and
-- marked_by is who. Kept apart on purpose: when a donor says "I never got it",
-- the useful question is who recorded the delivery and from what, not the date
-- the courier claimed.
ALTER TABLE prasadam_deliveries ADD COLUMN IF NOT EXISTS marked_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE prasadam_deliveries ADD COLUMN IF NOT EXISTS marked_at TIMESTAMPTZ;
-- How the status was last set: 'manual' (one row in the UI), 'bulk' (several
-- selected at once) or 'import' (an uploaded courier file).
ALTER TABLE prasadam_deliveries ADD COLUMN IF NOT EXISTS marked_via VARCHAR(10);

-- The fulfilment queue is almost always filtered by status and read
-- newest-first, and the import matches on the donor's phone.
CREATE INDEX IF NOT EXISTS idx_prasadam_status_created ON prasadam_deliveries(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_prasadam_donation ON prasadam_deliveries(donation_id);

-- ---------------------------------------------------------------------------
-- Offline donations recorded through DRM.
--
-- DRM does NOT mint receipt numbers. Both donation sites already have a
-- complete offline path that calls DCC, generates the 80G receipt and sends it
-- on WhatsApp (hkmsite2.0-server's "manual entry / raise receipt", annadan's
-- "offline donation"). DRM posts the entry to whichever site the admin picks
-- and stores what comes back, so there is still exactly ONE receipt series per
-- site and DCC sees every donation.
--
-- Which is why the only new column here is who typed it in. Everything else
-- already exists: source='offline', payment_mode=cash/cheque/upi/bank,
-- payment_ref=the UTR or reference number, receipt_number and external_ref as
-- returned by the issuing site.
ALTER TABLE donations ADD COLUMN IF NOT EXISTS entered_by UUID REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_donations_entered_by ON donations(entered_by) WHERE entered_by IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Prasadam: has the source site caught up?
--
-- Staff work the dispatch list in DRM, but both donation sites keep their own
-- prasadam screens. When someone marks a box delivered here, DRM pushes that
-- to the site it came from - best-effort, after the local write, so a site
-- being down can never undo work a human just did.
--
-- These three columns are what "best-effort" is allowed to mean. Without them
-- a failed push is invisible, and the two systems drift apart with nobody able
-- to see that they have.
--
--   synced       the site stored it
--   unsupported  the site answered honestly that it cannot hold this state -
--                annadan has no "cancelled", for instance. Not a failure, and
--                retrying only produces the same refusal.
--   failed       unreachable or refused. The Prasadam screen offers a re-sync.
ALTER TABLE prasadam_deliveries ADD COLUMN IF NOT EXISTS site_sync_status VARCHAR(12);
ALTER TABLE prasadam_deliveries ADD COLUMN IF NOT EXISTS site_sync_error TEXT;
ALTER TABLE prasadam_deliveries ADD COLUMN IF NOT EXISTS site_synced_at TIMESTAMPTZ;

-- The re-sync sweep looks for exactly this: marked here, belongs to a site, not
-- yet confirmed there.
CREATE INDEX IF NOT EXISTS idx_prasadam_sync_pending
  ON prasadam_deliveries(marked_at DESC)
  WHERE marked_at IS NOT NULL
    AND external_ref IS NOT NULL
    AND (site_sync_status IS NULL OR site_sync_status = 'failed');


-- ===========================================================================
-- CALLING (TeleCRM)
--
-- The temple calls donors: lapsed givers, last year's festival donors, people
-- who started a donation and never finished, and cold lists from events. This
-- is where that work is tracked.
--
-- ONE DESIGN DECISION SHAPES EVERYTHING HERE: calls are placed from the
-- callers' own phones, and DRM is told what happened afterwards. So duration,
-- connected-or-not and recordings are what a human reports, not what a
-- telephony system measured. Every such column below is therefore nullable and
-- carries a `source` of 'manual'. If a cloud provider (Exotel, MyOperator,
-- Knowlarity, Twilio) is ever added, it fills the same columns with measured
-- values and sets its own name as the source - no migration, and no report
-- needs rewriting. What DOES change is how much the numbers can be trusted,
-- which is why the source travels with every row rather than being assumed.
-- ===========================================================================

-- --------------------------------------------------------------------- leads
--
-- A lead is someone to call. It is NOT a second copy of a donor: when the
-- person is already in DRM, person_id points at them and the donation history
-- stays where it is. A cold lead from a CSV has no person row until they give.
--
-- phone is UNIQUE, and that is the whole duplicate story. One number is one
-- person to the temple, so importing a list that already contains a donor
-- updates that lead instead of forking them into two records that two callers
-- then ring on the same afternoon.
CREATE TABLE IF NOT EXISTS leads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Identity. phone is the last 10 digits, the same rule the donor sync uses,
  -- so a lead and a donor with the same number always meet.
  phone VARCHAR(10) UNIQUE NOT NULL,
  name VARCHAR(255),
  alt_phone VARCHAR(15),
  email VARCHAR(255),
  city VARCHAR(120),

  -- Set when this lead is a person DRM already knows. Null for cold leads.
  person_id UUID REFERENCES people(id) ON DELETE SET NULL,

  -- Where they came from: donor (pulled from DRM's own people), csv (uploaded
  -- list), website (started a donation and didn't finish), walk_in, referral,
  -- event, manual (typed in by a caller).
  source VARCHAR(20) NOT NULL DEFAULT 'manual',
  -- The specific thing: the uploaded file's name, the page they abandoned, who
  -- referred them. Free text because the useful detail differs per source.
  source_detail VARCHAR(255),
  source_site VARCHAR(20),

  -- Where this lead has got to. Configurable labels live in crm_statuses; the
  -- value here is the slug from that table.
  status VARCHAR(30) NOT NULL DEFAULT 'new',

  assigned_to UUID REFERENCES users(id) ON DELETE SET NULL,
  assigned_at TIMESTAMPTZ,

  tags TEXT[] NOT NULL DEFAULT '{}',
  -- The latest note, denormalised so the list can show it without a join. The
  -- full history is in lead_activities and this is never the only copy.
  remarks TEXT,

  -- WHAT IS DUE, AND WHEN. Deliberately a single column on the lead rather than
  -- a follow-ups table: with two places recording what is due, they disagree,
  -- and then nobody trusts the "overdue" count. Each time it is set, an
  -- activity row records who set it and why, so the history is not lost.
  next_follow_up_at TIMESTAMPTZ,
  follow_up_note TEXT,

  last_contacted_at TIMESTAMPTZ,
  last_outcome VARCHAR(30),
  call_attempts INT NOT NULL DEFAULT 0,

  -- What this lead is worth if it lands - the caller's estimate, used for the
  -- pipeline figure. Never a promise, and never counted as income.
  expected_amount NUMERIC(12,2),

  -- Conversion. Recorded against the actual donation so the reported figure is
  -- money that genuinely arrived, not a caller ticking a box.
  converted_donation_id UUID REFERENCES donations(id) ON DELETE SET NULL,
  converted_amount NUMERIC(12,2),
  converted_at TIMESTAMPTZ,

  -- Survives every status change, on purpose. Someone who asked not to be
  -- called must stay uncalled even if a later import reopens their lead.
  do_not_call BOOLEAN NOT NULL DEFAULT FALSE,
  -- Set when a number is unusable (disconnected, wrong person, not 10 digits).
  -- Kept rather than deleted so the same bad number isn't re-imported monthly.
  invalid_reason VARCHAR(120),

  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The calling queue: "my leads, still open, due first". This is the index that
-- makes the caller's screen instant, and it is the query they run all day.
CREATE INDEX IF NOT EXISTS idx_leads_queue
  ON leads(assigned_to, status, next_follow_up_at NULLS LAST)
  WHERE do_not_call = FALSE;
CREATE INDEX IF NOT EXISTS idx_leads_due ON leads(next_follow_up_at) WHERE next_follow_up_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);
CREATE INDEX IF NOT EXISTS idx_leads_person ON leads(person_id) WHERE person_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_leads_source ON leads(source, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_leads_tags ON leads USING GIN(tags);
-- Search by name in the leads list.
CREATE INDEX IF NOT EXISTS idx_leads_name ON leads(lower(name));

-- ---------------------------------------------------------- lead_activities
--
-- Everything that has ever happened to a lead, in one stream: calls, notes,
-- status changes, follow-ups being set, reassignment, WhatsApp sent.
--
-- One table rather than four because the thing a caller actually wants is the
-- lead's story in order, and stitching that together from four tables at read
-- time is how it ends up displayed out of order.
CREATE TABLE IF NOT EXISTS lead_activities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,

  -- call | note | status_change | follow_up | assignment | whatsapp | import
  kind VARCHAR(20) NOT NULL,
  note TEXT,

  -- ------------------------------------------------- call columns (kind='call')
  -- outbound | inbound | missed. A missed call is one the temple did not
  -- answer, logged so it can be returned rather than lost.
  direction VARCHAR(10),
  -- What came of it. Slug from crm_dispositions.
  disposition VARCHAR(30),
  -- Stored rather than derived from the disposition: a caller can mark a call
  -- connected that ended in a disposition the temple later reclassifies, and
  -- the connected/unanswered split should not shift under old reports.
  connected BOOLEAN,
  duration_seconds INT,

  -- Where these numbers came from. 'manual' means a human typed or estimated
  -- them; a provider name means they were measured. Reports say which, because
  -- a manually-entered average call time is not the same kind of fact as a
  -- measured one and should never be presented as though it were.
  source VARCHAR(20) NOT NULL DEFAULT 'manual',
  provider_call_id VARCHAR(120),
  recording_url TEXT,

  -- Status transitions, for the audit trail.
  from_value VARCHAR(60),
  to_value VARCHAR(60),

  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_lead_activities_lead ON lead_activities(lead_id, occurred_at DESC);
-- Caller-wise reports: one person's calls over a date range.
CREATE INDEX IF NOT EXISTS idx_lead_activities_user_time
  ON lead_activities(user_id, occurred_at DESC) WHERE kind = 'call';
CREATE INDEX IF NOT EXISTS idx_lead_activities_calls
  ON lead_activities(occurred_at DESC) WHERE kind = 'call';
-- A provider webhook arriving twice must not log the call twice.
CREATE UNIQUE INDEX IF NOT EXISTS idx_lead_activities_provider_call
  ON lead_activities(provider_call_id) WHERE provider_call_id IS NOT NULL;

-- ------------------------------------------------------------- crm_statuses
--
-- The stages a lead moves through, editable in Settings rather than compiled
-- in - every temple's calling process is slightly different, and a hard-coded
-- list means a code change to add "will give after Kartik".
--
-- is_won / is_lost are what the reports key off. A stage the temple invents
-- later is counted correctly the moment it is created, without touching any
-- reporting SQL.
CREATE TABLE IF NOT EXISTS crm_statuses (
  slug VARCHAR(30) PRIMARY KEY,
  label VARCHAR(60) NOT NULL,
  -- Tailwind-ish token the UI maps to a colour; kept as a name, not a hex, so
  -- dark mode stays the UI's business.
  tone VARCHAR(20) NOT NULL DEFAULT 'slate',
  sort_order INT NOT NULL DEFAULT 0,
  is_won BOOLEAN NOT NULL DEFAULT FALSE,
  is_lost BOOLEAN NOT NULL DEFAULT FALSE,
  -- Closed stages drop out of the calling queue without being deleted.
  is_open BOOLEAN NOT NULL DEFAULT TRUE,
  active BOOLEAN NOT NULL DEFAULT TRUE
);

INSERT INTO crm_statuses (slug, label, tone, sort_order, is_won, is_lost, is_open) VALUES
  ('new',            'New',              'slate',  10, FALSE, FALSE, TRUE),
  ('attempting',     'Attempting',       'amber',  20, FALSE, FALSE, TRUE),
  ('contacted',      'Contacted',        'blue',   30, FALSE, FALSE, TRUE),
  ('interested',     'Interested',       'violet', 40, FALSE, FALSE, TRUE),
  ('callback',       'Callback booked',  'cyan',   50, FALSE, FALSE, TRUE),
  ('converted',      'Donated',          'emerald',60, TRUE,  FALSE, FALSE),
  ('not_interested', 'Not interested',   'rose',   70, FALSE, TRUE,  FALSE),
  ('invalid',        'Wrong / invalid',  'zinc',   80, FALSE, TRUE,  FALSE),
  ('dnc',            'Do not call',      'zinc',   90, FALSE, TRUE,  FALSE)
ON CONFLICT (slug) DO NOTHING;

-- --------------------------------------------------------- crm_dispositions
--
-- How a single call ended. Separate from lead status because they answer
-- different questions: the disposition is about the call ("no answer"), the
-- status is about the relationship ("still interested"). Collapsing them is
-- what makes a CRM unable to tell you how many calls went unanswered.
--
-- counts_connected drives the connected-vs-unanswered split, and
-- suggests_status is what the calling screen pre-selects so a caller picking
-- "not interested" doesn't have to also remember to move the lead.
CREATE TABLE IF NOT EXISTS crm_dispositions (
  slug VARCHAR(30) PRIMARY KEY,
  label VARCHAR(60) NOT NULL,
  counts_connected BOOLEAN NOT NULL DEFAULT FALSE,
  suggests_status VARCHAR(30) REFERENCES crm_statuses(slug) ON DELETE SET NULL,
  -- Whether picking this should ask for a callback date.
  wants_follow_up BOOLEAN NOT NULL DEFAULT FALSE,
  sort_order INT NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT TRUE
);

INSERT INTO crm_dispositions (slug, label, counts_connected, suggests_status, wants_follow_up, sort_order) VALUES
  ('interested',     'Interested',            TRUE,  'interested',     TRUE,  10),
  ('will_donate',    'Will donate',           TRUE,  'callback',       TRUE,  20),
  ('donated',        'Donated now',           TRUE,  'converted',      FALSE, 30),
  ('call_back',      'Call back later',       TRUE,  'callback',       TRUE,  40),
  ('not_interested', 'Not interested',        TRUE,  'not_interested', FALSE, 50),
  ('no_answer',      'No answer',             FALSE, 'attempting',     TRUE,  60),
  ('busy',           'Busy',                  FALSE, 'attempting',     TRUE,  70),
  ('switched_off',   'Switched off',          FALSE, 'attempting',     TRUE,  80),
  ('wrong_number',   'Wrong number',          TRUE,  'invalid',        FALSE, 90),
  ('invalid_number', 'Number does not exist', FALSE, 'invalid',        FALSE, 100),
  ('do_not_call',    'Asked not to be called',TRUE,  'dnc',            FALSE, 110)
ON CONFLICT (slug) DO NOTHING;

-- ------------------------------------------------------------- crm_settings
-- Small key/value store for the Settings screen. JSONB so a setting can grow
-- from a flag into an object without a migration.
CREATE TABLE IF NOT EXISTS crm_settings (
  key VARCHAR(60) PRIMARY KEY,
  value JSONB NOT NULL,
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO crm_settings (key, value) VALUES
  -- How many leads the "give me work" button hands a caller at once.
  ('queue_batch_size',      '25'::jsonb),
  -- A lead nobody has touched for this many days comes back to the top.
  ('stale_lead_days',       '30'::jsonb),
  -- How many unanswered attempts before the lead is parked rather than
  -- dialled forever.
  ('max_attempts',          '6'::jsonb),
  -- Days before an unanswered lead comes back round. Without this a "no
  -- answer" would leave the lead with no date at all and it would quietly
  -- drop out of everyone's day.
  ('retry_after_days',      '2'::jsonb),
  -- Calling hours, so the screen can warn before someone rings at 6am.
  ('calling_hours',         '{"from":"09:00","to":"20:00"}'::jsonb),
  -- Whether a caller may see leads assigned to someone else.
  ('callers_see_all_leads', 'false'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- REMINDERS
--
-- A reminder is NOT a follow-up, and keeping them apart is the whole point.
--
--   follow-up   "ring this lead back around the 20th" - a working date the
--               caller picks so the queue hands the lead back at a sensible
--               time. Lives on leads.next_follow_up_at. Fuzzy by design.
--
--   reminder    "he said he will donate on Govardhan Puja evening, after the
--               arati" - a commitment the DONOR made, at a moment THEY named.
--               Being an hour late to this is the difference between catching
--               someone in the mood they promised in and catching them at
--               dinner. It needs alerting, not a list to scroll.
--
-- Mixing them is what makes a CRM's reminder feature useless: the genuine
-- commitments drown in a list of routine callbacks, so people stop looking, so
-- the commitments get missed anyway.
--
-- HOW THE ALERTING WORKS
-- lead_times holds minutes before due_at at which this should surface: the
-- default {1440, 60, 15} is a day before, an hour before, and a quarter of an
-- hour before. fired_offsets records which of those have already been shown, so
-- an alert is raised exactly once per offset no matter how many times the
-- screen polls or how many tabs are open. That state has to be in the database
-- rather than the browser, because the caller who gets alerted may not be the
-- one whose tab is open, and a refresh must not replay yesterday's alerts.
CREATE TABLE IF NOT EXISTS lead_reminders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,

  -- What the donor actually said, in their words where possible. This is read
  -- out loud on the call, so it is the most important column here.
  title VARCHAR(200) NOT NULL,
  note TEXT,

  -- The occasion they named: Govardhan Puja, Ekadashi, "after salary day",
  -- "when my son returns". Free text because a temple's calendar is not a
  -- fixed list, and forcing one would just get "Other" every time.
  occasion VARCHAR(120),

  -- When it comes due, to the minute. Not a date: "Govardhan Puja evening" and
  -- "Govardhan Puja morning" are different calls.
  due_at TIMESTAMPTZ NOT NULL,

  -- What they said they would give. Lets the caller open with the right ask
  -- instead of starting the negotiation again.
  expected_amount NUMERIC(12,2),

  -- Minutes before due_at to raise an alert, largest first by convention.
  lead_times INT[] NOT NULL DEFAULT '{1440,60,15}',
  fired_offsets INT[] NOT NULL DEFAULT '{}',

  -- Who should be alerted. Falls back to the lead's assignee when null, so a
  -- reminder never ends up belonging to nobody.
  assigned_to UUID REFERENCES users(id) ON DELETE SET NULL,

  -- open | done | dismissed | missed
  --
  -- "missed" is computed, never stored by a user: it is what an open reminder
  -- becomes once its time has passed. Recording it as a status would mean a
  -- background job to flip rows, and a job that stops leaves the board lying.
  status VARCHAR(12) NOT NULL DEFAULT 'open',
  completed_at TIMESTAMPTZ,
  -- Set when the reminder was pushed back, so a reminder snoozed four times is
  -- visibly a reminder nobody wants to act on.
  snooze_count INT NOT NULL DEFAULT 0,

  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The alert poll runs every minute per signed-in caller, so it needs to be
-- close to free: open reminders only, ordered by when they come due.
CREATE INDEX IF NOT EXISTS idx_reminders_due ON lead_reminders(due_at) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_reminders_assignee ON lead_reminders(assigned_to, due_at) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_reminders_lead ON lead_reminders(lead_id, due_at DESC);

-- How far ahead the reminders board looks, and whether the browser is allowed
-- to raise a desktop notification.
INSERT INTO crm_settings (key, value) VALUES
  ('reminder_lead_times',   '[1440,60,15]'::jsonb),
  ('reminder_desktop_alerts', 'true'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- Undo for a logged call.
--
-- The outcome buttons on the calling screen sit close together and are hit at
-- speed, so a misclick happens several times a shift. Deleting the activity row
-- alone would NOT undo the call: logging one also bumps call_attempts, moves
-- the lead's stage, rewrites last_contacted_at and last_outcome, may set or
-- clear the follow-up date, and may create a reminder. Reversing all of that by
-- re-deriving it afterwards is guesswork.
--
-- So the lead's state from immediately BEFORE the call is written here at the
-- moment it is logged, and undo restores it verbatim. Small, written once,
-- never read unless somebody presses U.
ALTER TABLE lead_activities ADD COLUMN IF NOT EXISTS undo_payload JSONB;

-- ---------------------------------------------------------------------------
-- SAVED LINKS
--
-- The thing a caller says twenty times a day: "shall I send you the link?"
-- Until now the answer meant hanging up, opening the site, finding the right
-- seva page, copying the URL and pasting it into WhatsApp by hand - so mostly
-- it was "search for our website on Google", and the donation never happened.
--
-- These are the links the temple actually sends, saved once. A caller picks
-- one, and DRM opens WhatsApp already in that donor's chat with the message
-- written. No template approval, no per-message cost, because this is
-- click-to-chat from the caller's own WhatsApp rather than the Business API.
--
-- TWO KINDS OF PLACEHOLDER, and they do different jobs:
--
--   in `url`      {phone} {lead} {caller}
--                 Substituted before the link is sent, so a UTM can carry who
--                 was called and who called them. That is what makes a
--                 donation traceable back to the call that caused it -
--                 donations already store utm_source/medium/campaign, so a
--                 link tagged utm_source=call arrives already attributed.
--
--   in `message`  {name} {link} {seva} {amount} {caller}
--                 The WhatsApp text itself. The caller can edit it before
--                 sending; this is the starting point, not a fixed script.
--
-- owner_user_id NULL means the link is shared with everyone. Set, it belongs
-- to one caller - which is the "custom link I saved myself" case, and keeps
-- one person's experiment out of everybody else's dropdown.
CREATE TABLE IF NOT EXISTS crm_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  label VARCHAR(80) NOT NULL,
  url TEXT NOT NULL,
  -- Which site it points at, so DRM can tell which WhatsApp number the donor
  -- already knows and attribute the donation to the right place.
  site VARCHAR(20),
  -- The seva as a donor would say it, used in the message.
  seva_name VARCHAR(120),
  message TEXT,
  owner_user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  sort_order INT NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  -- What actually gets used. The picker puts the busy links first, so the
  -- three links a caller sends all day stop being three scrolls away.
  use_count INT NOT NULL DEFAULT 0,
  last_used_at TIMESTAMPTZ,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_crm_links_pick
  ON crm_links(sort_order, use_count DESC) WHERE active;
CREATE INDEX IF NOT EXISTS idx_crm_links_owner ON crm_links(owner_user_id) WHERE owner_user_id IS NOT NULL;

-- Seeded with the temple's real pages. Editable in Calling settings, because
-- the campaign pages change every festival and a code change to add one would
-- mean nobody ever adds one.
--
-- utm_source=call is on every seed deliberately: without it a donation that a
-- phone call produced looks identical to one that arrived on its own, and the
-- conversion report can only guess.
-- Seeded ONCE, and only into an empty table.
--
-- NOT "ON CONFLICT DO NOTHING": that needs a unique constraint to conflict
-- against, and there is none here, so it silently does nothing and every
-- re-run of this file would append another nine rows. This file is applied on
-- every deploy, so within a month the caller's dropdown would hold sixty
-- copies of Gau Seva.
--
-- Guarding on the table being empty also means a link the temple deletes on
-- purpose stays deleted rather than reappearing at the next deploy.
-- The message literals are E'' strings: in a plain SQL literal a backslash and
-- an n are two characters, so the donor would receive "...calling\n\nHare
-- Krishna Movement" with the escape printed instead of a line break.
INSERT INTO crm_links (label, url, site, seva_name, message, sort_order)
SELECT * FROM (VALUES
('Annadana Seva (annadan site)',
   'https://annadan.harekrishnavizag.org/?utm_source=call&utm_medium=whatsapp&utm_campaign=calling',
   'annadan', 'Annadana Seva',
   E'Hare Krishna {name}, thank you for speaking with me. Here is the link for your {seva}: {link}\n\nHare Krishna Movement, Visakhapatnam', 10),

  ('Gau Seva',
   'https://harekrishnavizag.org/gau-seva?utm_source=call&utm_medium=whatsapp&utm_campaign=calling',
   'hkmv', 'Gau Seva',
   E'Hare Krishna {name}, thank you for speaking with me. Here is the link for your {seva}: {link}\n\nHare Krishna Movement, Visakhapatnam', 20),

  ('Anna Daan Seva',
   'https://harekrishnavizag.org/anna-daan-seva?utm_source=call&utm_medium=whatsapp&utm_campaign=calling',
   'hkmv', 'Anna Daan Seva',
   E'Hare Krishna {name}, thank you for speaking with me. Here is the link for your {seva}: {link}\n\nHare Krishna Movement, Visakhapatnam', 30),

  ('Gita Daan Seva',
   'https://harekrishnavizag.org/gita-daan-seva?utm_source=call&utm_medium=whatsapp&utm_campaign=calling',
   'hkmv', 'Gita Daan Seva',
   E'Hare Krishna {name}, thank you for speaking with me. Here is the link for your {seva}: {link}\n\nHare Krishna Movement, Visakhapatnam', 40),

  ('Pitru Paksha',
   'https://harekrishnavizag.org/pitru-paksha?utm_source=call&utm_medium=whatsapp&utm_campaign=calling',
   'hkmv', 'Pitru Paksha Seva',
   E'Hare Krishna {name}, thank you for speaking with me. Here is the link for the {seva}: {link}\n\nHare Krishna Movement, Visakhapatnam', 50),

  ('Brick Seva',
   'https://harekrishnavizag.org/brick-seva-campaign?utm_source=call&utm_medium=whatsapp&utm_campaign=calling',
   'hkmv', 'Brick Seva',
   E'Hare Krishna {name}, thank you for speaking with me. Here is the link for your {seva} towards the Vaikuntham temple: {link}\n\nHare Krishna Movement, Visakhapatnam', 60),

  ('Square Foot Seva',
   'https://harekrishnavizag.org/sqft-seva-campaign?utm_source=call&utm_medium=whatsapp&utm_campaign=calling',
   'hkmv', 'Square Foot Seva',
   E'Hare Krishna {name}, thank you for speaking with me. Here is the link for your {seva} towards the Vaikuntham temple: {link}\n\nHare Krishna Movement, Visakhapatnam', 70),

  ('Alankara Vastra Seva',
   'https://harekrishnavizag.org/alankara-vastra-seva?utm_source=call&utm_medium=whatsapp&utm_campaign=calling',
   'hkmv', 'Alankara Vastra Seva',
   E'Hare Krishna {name}, thank you for speaking with me. Here is the link for your {seva}: {link}\n\nHare Krishna Movement, Visakhapatnam', 80),

  ('General donation (main site)',
   'https://harekrishnavizag.org/donations?utm_source=call&utm_medium=whatsapp&utm_campaign=calling',
   'hkmv', 'donation',
   E'Hare Krishna {name}, thank you for speaking with me. Here is the donation link: {link}\n\nHare Krishna Movement, Visakhapatnam', 90)
) AS seed(label, url, site, seva_name, message, sort_order)
WHERE NOT EXISTS (SELECT 1 FROM crm_links);

-- How the WhatsApp button opens.
--
--   'wa'       https://wa.me/... - works everywhere: the desktop app if it is
--              installed, WhatsApp Web otherwise. One extra click on Windows.
--   'desktop'  whatsapp://send?... - opens the installed desktop app straight
--              away, and does nothing at all on a machine without it.
--
-- Default is the one that always works; a temple whose callers all have the
-- desktop app can switch it and save a click twenty times a day.
INSERT INTO crm_settings (key, value) VALUES
  ('whatsapp_open_mode', '"wa"'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- ===========================================================================
-- PREACHERS
--
-- Every donor sheet the temple keeps has an "Enrolled By" column - JTMD, VKTD,
-- YDRD and so on - and it is the single most important thing on the row that
-- DRM had nowhere to put. It is the preacher who brought that donor in, and it
-- changes how a call goes: mentioning the preacher a donor already knows turns
-- a cold call into a warm one.
--
-- Codes, not names, because that is what the sheets carry and what the office
-- says out loud. A full name can be filled in here later and every screen picks
-- it up; until then the code is shown, which is still better than nothing.
--
-- NOT a `users` row. A preacher is someone the DONOR knows; a user is someone
-- who signs in to DRM. Sometimes the same person, usually not, and conflating
-- them would mean creating a login for every preacher just to record a name.
CREATE TABLE IF NOT EXISTS preachers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The code exactly as the sheets write it, upper-cased. This is what an
  -- import matches on, so it is the real key.
  code VARCHAR(20) UNIQUE NOT NULL,
  name VARCHAR(160),
  phone VARCHAR(15),
  notes TEXT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_preachers_active ON preachers(active, code);

-- A donor's preacher, and a lead's. Both nullable, and deliberately separate
-- columns rather than one on people alone: a lead from an uploaded sheet may
-- have a preacher long before it is ever linked to a person in DRM.
ALTER TABLE people ADD COLUMN IF NOT EXISTS preacher_id UUID REFERENCES preachers(id) ON DELETE SET NULL;
ALTER TABLE leads  ADD COLUMN IF NOT EXISTS preacher_id UUID REFERENCES preachers(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_people_preacher ON people(preacher_id) WHERE preacher_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_leads_preacher  ON leads(preacher_id)  WHERE preacher_id IS NOT NULL;


-- ===========================================================================
-- UPLOADED SHEETS
--
-- The office works from spreadsheets: last four years' general donation data,
-- a festival list, a stall register. A sheet gets uploaded, the team calls
-- through it, and some weeks later a fresher export of the same data arrives.
--
-- WHAT MUST SURVIVE A RE-UPLOAD: every call, note, reminder and outcome
-- recorded against those people. That is the entire value of the CRM, and it
-- is exactly what would be lost if a new sheet replaced the old rows.
--
-- So an upload never replaces anything. It adds people who are new and fills
-- gaps on people already here, and it is recorded as a BATCH: which file, who
-- uploaded it, when, and what it did. Every lead remembers the batch it first
-- arrived in, so "where did this person come from" always has an answer, and a
-- batch that turns out to be wrong can be traced rather than guessed at.
CREATE TABLE IF NOT EXISTS lead_import_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  filename VARCHAR(255) NOT NULL,
  -- Which tab of the workbook. The temple's sheets carry several (HKMI, TSC),
  -- and they mean different things, so they import as separate batches.
  sheet_name VARCHAR(120),
  label VARCHAR(160),
  uploaded_by UUID REFERENCES users(id) ON DELETE SET NULL,

  rows_total INT NOT NULL DEFAULT 0,
  leads_added INT NOT NULL DEFAULT 0,
  leads_updated INT NOT NULL DEFAULT 0,
  rows_skipped INT NOT NULL DEFAULT 0,
  -- People in the sheet who were already donors in DRM. Worth recording: it is
  -- the number that tells the office whether a list is fresh or a re-export.
  matched_existing_donors INT NOT NULL DEFAULT 0,

  -- The column mapping that was used, and the counts per bucket. Kept so a
  -- puzzling import can be explained months later without the original file.
  detail JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_import_batches_time ON lead_import_batches(created_at DESC);

ALTER TABLE leads ADD COLUMN IF NOT EXISTS import_batch_id UUID REFERENCES lead_import_batches(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_leads_batch ON leads(import_batch_id) WHERE import_batch_id IS NOT NULL;

-- The donor code the office's own sheets use (D2, D18, ...). A far better key
-- than a phone number for matching a re-upload: people change numbers, and two
-- family members share one, but the donor code stays put.
ALTER TABLE leads  ADD COLUMN IF NOT EXISTS donor_code VARCHAR(40);
ALTER TABLE people ADD COLUMN IF NOT EXISTS donor_code VARCHAR(40);
CREATE INDEX IF NOT EXISTS idx_leads_donor_code  ON leads(donor_code)  WHERE donor_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_people_donor_code ON people(donor_code) WHERE donor_code IS NOT NULL;


-- ---------------------------------------------------------------------------
-- GIVING RECORDED ELSEWHERE
--
-- The sheets carry lifetime totals - one of them adds up to over sixteen crore
-- - from the accounting system, not from DRM. A caller badly needs to see it:
-- ringing someone who has given three lakhs over the years is a different
-- conversation from ringing a stranger.
--
-- It is kept in its own columns, NEVER written into the donations table, and
-- that separation is the whole point. DRM's totals and its conversion reports
-- exist to answer "what did the calling achieve"; folding in money that arrived
-- years before anyone picked up the phone would make every one of those figures
-- flattering and useless. Shown to the caller, excluded from the arithmetic.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS external_total_donated NUMERIC(14,2);
ALTER TABLE leads ADD COLUMN IF NOT EXISTS external_recent_donated NUMERIC(14,2);
ALTER TABLE leads ADD COLUMN IF NOT EXISTS external_last_donation_at TIMESTAMPTZ;
-- Which system said so, and what it called the account (the sheets say "TSC").
ALTER TABLE leads ADD COLUMN IF NOT EXISTS external_source VARCHAR(60);
ALTER TABLE leads ADD COLUMN IF NOT EXISTS external_account_type VARCHAR(40);

-- Calling lists are very often built from this: "everyone who has given over a
-- lakh but nothing since 2023".
CREATE INDEX IF NOT EXISTS idx_leads_external_total
  ON leads(external_total_donated DESC NULLS LAST)
  WHERE external_total_donated IS NOT NULL;

-- Every row of every sheet ever uploaded, exactly as it arrived.
--
-- Asked for directly: "if they upload a new one we should store the old sheet
-- data". It earns its space three times over:
--
--   - a batch can be previewed, checked and only then applied, because the rows
--     are already parked here rather than being held in a browser tab
--   - months later "what did the March sheet actually say about this donor"
--     has an answer, without hunting for the file on someone's laptop
--   - a fresh export can be compared against the last one, so "this donor's
--     total went up by 50,000 since the last sheet" is a question DRM can
--     answer rather than a spreadsheet exercise
--
-- raw holds the whole original row keyed by its real column headings, so a
-- column nobody thought to map is still there when it turns out to matter.
CREATE TABLE IF NOT EXISTS lead_import_rows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id UUID NOT NULL REFERENCES lead_import_batches(id) ON DELETE CASCADE,
  row_number INT NOT NULL,

  -- The mapped fields, as understood at import time.
  donor_code VARCHAR(40),
  phone VARCHAR(10),
  name VARCHAR(255),
  preacher_code VARCHAR(20),
  amount_total NUMERIC(14,2),
  amount_recent NUMERIC(14,2),
  last_donation_at TIMESTAMPTZ,
  account_type VARCHAR(40),
  remarks TEXT,

  -- new | updated | duplicate_in_file | invalid_phone | no_phone
  outcome VARCHAR(24),
  lead_id UUID REFERENCES leads(id) ON DELETE SET NULL,

  raw JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_import_rows_batch ON lead_import_rows(batch_id, row_number);
CREATE INDEX IF NOT EXISTS idx_import_rows_phone ON lead_import_rows(phone) WHERE phone IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_import_rows_code  ON lead_import_rows(donor_code) WHERE donor_code IS NOT NULL;

-- draft (parsed, nothing applied) | applied | discarded
ALTER TABLE lead_import_batches ADD COLUMN IF NOT EXISTS status VARCHAR(12) NOT NULL DEFAULT 'draft';
ALTER TABLE lead_import_batches ADD COLUMN IF NOT EXISTS applied_at TIMESTAMPTZ;
ALTER TABLE lead_import_batches ADD COLUMN IF NOT EXISTS applied_by UUID REFERENCES users(id) ON DELETE SET NULL;

-- How many donor accounts sit behind one phone number.
--
-- The real sheet has 6,348 donor codes across 5,452 numbers: families and
-- businesses sharing a line, each code with its own lifetime total. A lead is
-- one phone (one call), so those totals are ADDED onto that lead - otherwise a
-- caller ringing a number behind two accounts worth 50 lakh between them sees
-- only whichever row happened to be imported last. On the real workbook that is
-- 2.12 crore of giving that would have been invisible on the calling screen.
--
-- The count is kept so the screen can say "across 2 accounts" rather than
-- presenting a summed figure as though it were one donor's.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS external_account_count INT;

-- ---------------------------------------------------------------------------
-- WHEN A LEAD DONATES
--
-- Three ways DRM finds out, and it needs all three:
--
--   automatic  the donor gives on one of the sites, the sync brings it in, and
--              reconcileConversions() links it to the lead. No one does
--              anything. This is the common case and it already worked.
--
--   alerted    the caller who rang them is TOLD. Without this the automatic
--              link is silent: the lead quietly moves to Donated and the person
--              who earned it never knows, so they keep the lead on their list
--              and ring a donor who has already given - the single most
--              embarrassing thing a fundraising team can do.
--
--   manual     money that arrived by a route DRM cannot see: cash at the
--              counter, a transfer to the temple account, a cheque handed to a
--              preacher. The caller marks it and says how.
--
-- converted_via records WHICH of the three it was, because a conversion the
-- system observed and one a caller asserted are not equally strong evidence,
-- and a report that mixes them without saying so is overstating its case.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS converted_via VARCHAR(12);
ALTER TABLE leads ADD COLUMN IF NOT EXISTS converted_note TEXT;
-- Cleared when the caller has seen it. Drives the "one of your leads donated"
-- alert, and only for the person whose lead it was.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS conversion_seen_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_leads_conversion_unseen
  ON leads(assigned_to, converted_at DESC)
  WHERE converted_donation_id IS NOT NULL AND conversion_seen_at IS NULL;


-- ===========================================================================
-- ACCOUNTS
--
-- users existed from the first day of DRM with three columns and no way to
-- manage them: every account was made by hand against the database, and
-- /api/auth/register was open to the internet and handed out 'admin'. These
-- columns are what an account screen needs to be honest about who is who.
-- ===========================================================================

-- Switched off rather than deleted. A caller who leaves still wrote every call
-- in the log, and deleting the row would either orphan that history or cascade
-- it away - both worse than a row marked inactive that can no longer sign in.
ALTER TABLE users ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id) ON DELETE SET NULL;

-- Emails are compared lower-cased when signing in, so they must be unique
-- lower-cased too - otherwise Ravi@ and ravi@ are two accounts that both think
-- they are the same person.
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_lower ON users(lower(email));


-- ===========================================================================
-- CALLING LISTS AND SESSIONS
--
-- THE PROBLEM THIS SOLVES
-- "Start calling" used to open one global queue: everything assigned to you or
-- unassigned, ordered by what was most overdue. That is the right ORDER, but it
-- is the wrong unit of work. A temple does not call "the queue", it calls the
-- Janmashtami sheet on Tuesday and the lapsed monthly donors on Wednesday - and
-- when the caller stops at forty, somebody has to be able to pick it up on
-- Thursday at forty-one.
--
-- A LIST IS A SAVED FILTER, NOT A COPY OF THE LEADS
-- The obvious design is a table of list members. It is also the wrong one: a
-- lead that converts, goes do-not-call, or gets assigned to somebody else has
-- to leave the list, and a copied membership table goes stale the moment any of
-- that happens. So a list stores the QUESTION - this uploaded sheet, this tag,
-- this preacher's donors - and the queue answers it fresh on every load.
-- Progress is then counted, never tracked: "how many of this list still need a
-- call" is a COUNT, and it is right by construction.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS calling_lists (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(160) NOT NULL,
  description TEXT,

  -- What the list selects. Every field is optional and they AND together, so a
  -- list can be "the March sheet" or "the March sheet, Visakhapatnam, JTMD's
  -- donors" without needing a different kind of list for each combination.
  import_batch_id UUID REFERENCES lead_import_batches(id) ON DELETE CASCADE,
  tag VARCHAR(40),
  preacher_id UUID REFERENCES preachers(id) ON DELETE SET NULL,
  status_slug VARCHAR(40),
  source VARCHAR(40),
  city VARCHAR(80),
  -- Lifetime giving from the office's sheets, for "everyone who has given over
  -- a lakh". NULL means no bound.
  min_external_total NUMERIC(14,2),

  -- A list built from a sheet upload is created by the importer and named after
  -- the sheet; one built on the lists screen is 'manual'. Kept apart so a
  -- re-upload can refresh its own list without touching anything a human made.
  origin VARCHAR(12) NOT NULL DEFAULT 'manual',

  -- Retired rather than deleted, for the same reason as preachers: sessions
  -- point at it and "which list was I on in March" has to stay answerable.
  active BOOLEAN NOT NULL DEFAULT TRUE,

  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_calling_lists_active ON calling_lists(active, name);
CREATE INDEX IF NOT EXISTS idx_calling_lists_batch  ON calling_lists(import_batch_id) WHERE import_batch_id IS NOT NULL;

-- One list handed to one caller. The assignment is what makes a list the
-- caller's default when they sit down; they can still choose another, which is
-- deliberate - a caller who finishes early should not be stuck.
CREATE TABLE IF NOT EXISTS calling_list_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  list_id UUID NOT NULL REFERENCES calling_lists(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  assigned_by UUID REFERENCES users(id) ON DELETE SET NULL,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (list_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_list_assignments_user ON calling_list_assignments(user_id);

-- A caller's run at a list. One row per caller per list, reused every day.
--
-- WHY THIS IS NOT A ROW PER DAY
-- The question a caller asks when they sit down is "where was I", not "what did
-- I do on Tuesday". Tuesday is already in lead_activities, in full, with who
-- and when - so a row per shift would be a second, worse copy of it. This holds
-- only what cannot be recomputed: that this caller has this list open, and when
-- they last touched it.
CREATE TABLE IF NOT EXISTS calling_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  list_id UUID REFERENCES calling_lists(id) ON DELETE CASCADE,

  started_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_active_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Set when the caller presses Finish. An unfinished session is what "resume"
  -- offers them tomorrow morning.
  ended_at TIMESTAMPTZ,

  -- Counted here as well as being derivable from the activity log, because this
  -- is the number shown on the screen after every call and re-aggregating the
  -- log for it on each one would be silly. The log stays the source of truth
  -- for reports; this is a tally for the caller.
  calls_logged INT NOT NULL DEFAULT 0,
  connected    INT NOT NULL DEFAULT 0,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One open session per caller per list. The WHERE makes it a partial index, so
-- finished sessions pile up as history without colliding.
CREATE UNIQUE INDEX IF NOT EXISTS idx_calling_sessions_open
  ON calling_sessions(user_id, COALESCE(list_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE ended_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_calling_sessions_user ON calling_sessions(user_id, last_active_at DESC);

-- Which session a call belonged to, so "you did 47 on the Janmashtami list
-- yesterday" comes out of the log rather than being taken on trust.
ALTER TABLE lead_activities ADD COLUMN IF NOT EXISTS session_id UUID REFERENCES calling_sessions(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_activities_session ON lead_activities(session_id) WHERE session_id IS NOT NULL;


-- ===========================================================================
-- PREACHER ID NUMBER
--
-- The temple already issues these on paper. DRM stores what it is told and
-- never invents one: a generated number would look identical to a real one on
-- screen and there would be no way to tell, afterwards, which preachers had
-- been given a number by the office and which by a database default.
--
-- Unique, but only where present, so the great majority of preachers who have
-- no number are not all colliding on NULL.
-- ===========================================================================
ALTER TABLE preachers ADD COLUMN IF NOT EXISTS id_number VARCHAR(30);
CREATE UNIQUE INDEX IF NOT EXISTS idx_preachers_id_number
  ON preachers(id_number) WHERE id_number IS NOT NULL;


-- ===========================================================================
-- ADDRESSES, PROPERLY
--
-- people.address was one free-text line, which is why a DRM receipt printed a
-- single smear where the sites print a laid-out address. Both sites already
-- hold structure and DRM was throwing it away on the way in:
--
--   HKMV donor.savedAddress      street, city, state, pincode, country
--   HKMV donation.prasadamAddress doorNo, house, street, area,
--                                 city, state, pincode, country
--   annadan donation             address, city, state, pincode (flat)
--
-- These columns are the superset - the eight-field prasadam shape, which the
-- other two fit inside. Nothing is invented: there is no landmark or line2
-- here because neither site has one, and a field DRM alone knows about could
-- never survive a round trip.
--
-- address stays, as written text, and is NOT dropped. It holds what arrived
-- before the split and whatever annadan sends as one blob, so no address is
-- ever lost to a migration. Display prefers the parts and falls back to it.
-- ===========================================================================

ALTER TABLE people ADD COLUMN IF NOT EXISTS address_door    VARCHAR(60);
ALTER TABLE people ADD COLUMN IF NOT EXISTS address_house   VARCHAR(120);
ALTER TABLE people ADD COLUMN IF NOT EXISTS address_street  VARCHAR(200);
ALTER TABLE people ADD COLUMN IF NOT EXISTS address_area    VARCHAR(120);
ALTER TABLE people ADD COLUMN IF NOT EXISTS address_city    VARCHAR(80);
ALTER TABLE people ADD COLUMN IF NOT EXISTS address_state   VARCHAR(80);
ALTER TABLE people ADD COLUMN IF NOT EXISTS address_pincode VARCHAR(10);
ALTER TABLE people ADD COLUMN IF NOT EXISTS address_country VARCHAR(60) DEFAULT 'India';

-- Where prasadam goes, when it is not where they live. Same eight fields,
-- because a courier needs a door number quite as much as an accountant does.
ALTER TABLE people ADD COLUMN IF NOT EXISTS prasadam_door    VARCHAR(60);
ALTER TABLE people ADD COLUMN IF NOT EXISTS prasadam_house   VARCHAR(120);
ALTER TABLE people ADD COLUMN IF NOT EXISTS prasadam_street  VARCHAR(200);
ALTER TABLE people ADD COLUMN IF NOT EXISTS prasadam_area    VARCHAR(120);
ALTER TABLE people ADD COLUMN IF NOT EXISTS prasadam_city    VARCHAR(80);
ALTER TABLE people ADD COLUMN IF NOT EXISTS prasadam_state   VARCHAR(80);
ALTER TABLE people ADD COLUMN IF NOT EXISTS prasadam_pincode VARCHAR(10);
ALTER TABLE people ADD COLUMN IF NOT EXISTS prasadam_country VARCHAR(60) DEFAULT 'India';

CREATE INDEX IF NOT EXISTS idx_people_pincode ON people(address_pincode) WHERE address_pincode IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_people_city    ON people(lower(address_city)) WHERE address_city IS NOT NULL;


-- ===========================================================================
-- NAMES THE SITES DISAGREE ABOUT
--
-- The people upsert never touched `name` on conflict, so whichever site synced
-- a donor FIRST named them forever. That is how DRM ended up calling somebody
-- "Myakal Srikanth" while annadan had "Myakala Srikanth" all along - not a
-- truncation or an encoding fault, simply a first write that nothing could
-- ever correct.
--
-- Newest now wins. But a name silently changing under an admin who fixed it
-- yesterday is its own bug, so the one that lost is kept, with where it came
-- from, and the screen says so. A disagreement is information, not noise.
-- ===========================================================================

ALTER TABLE people ADD COLUMN IF NOT EXISTS name_alt        VARCHAR(255);
ALTER TABLE people ADD COLUMN IF NOT EXISTS name_alt_source VARCHAR(20);
ALTER TABLE people ADD COLUMN IF NOT EXISTS name_conflict_at TIMESTAMPTZ;
-- Set when a human types the name in DRM. A sync may still overwrite it - the
-- rule chosen is newest-wins - but the screen can then say the name was edited
-- here and later changed by a site, which is the case worth seeing.
ALTER TABLE people ADD COLUMN IF NOT EXISTS name_edited_at  TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_people_name_conflict
  ON people(name_conflict_at DESC) WHERE name_alt IS NOT NULL;

-- When each site last told us anything about this donor, so "newest wins" has
-- something to compare. Without it, newest means "whichever sync ran last",
-- which is a property of the cron schedule rather than of the data.
ALTER TABLE people ADD COLUMN IF NOT EXISTS profile_synced_at TIMESTAMPTZ;
-- Which way the last profile change travelled, for the audit trail on screen.
ALTER TABLE people ADD COLUMN IF NOT EXISTS profile_source VARCHAR(20);

-- Pushing a DRM edit back out to the sites. Same shape as the prasadam
-- write-back: what was attempted, whether it landed, and why not.
ALTER TABLE people ADD COLUMN IF NOT EXISTS push_status VARCHAR(20);
ALTER TABLE people ADD COLUMN IF NOT EXISTS push_error  TEXT;
ALTER TABLE people ADD COLUMN IF NOT EXISTS pushed_at   TIMESTAMPTZ;


-- ===========================================================================
-- PAUSING A CALLING RUN
--
-- A run could only be finished, which conflates two different things a caller
-- does: stepping away for an hour, and stopping for the day. Both used to mean
-- "end it", and ending it is what makes tomorrow's screen offer a fresh start
-- instead of the list they were halfway through.
--
-- paused_at is set when they step away and cleared when they come back;
-- ended_at still means done. A paused run is still the open one, so "where you
-- left off" finds it.
-- ===========================================================================

ALTER TABLE calling_sessions ADD COLUMN IF NOT EXISTS paused_at TIMESTAMPTZ;
-- Their own words for why, shown back to them on return: "lunch", "back after
-- the arati". Optional, and never required to pause.
ALTER TABLE calling_sessions ADD COLUMN IF NOT EXISTS pause_note VARCHAR(200);


-- ===========================================================================
-- RAZORPAY QR CODES A CALLER CAN SHARE
--
-- HOW THE TEMPLE WORKS
-- Each caller is given QR codes in the Razorpay dashboard. Mid-call a donor
-- says "send me the QR", and today that happens on the caller's own phone,
-- outside DRM, so the donation lands in Razorpay with nothing tying it to the
-- call that produced it. The caller is not credited, the lead is not converted,
-- and somebody reconciles it by hand a week later.
--
-- WHY THE QR IDs ARE STORED AND THE QR IMAGES ARE NOT
-- A Razorpay QR has a stable id (qr_xxx) and a hosted image URL. DRM keeps the
-- id, the URL and the label; it does not mint QRs and it does not need API keys
-- to hand one to a donor. The only thing it needs Razorpay for is reading
-- payments back, which is a webhook plus a read-only reconcile.
--
-- WHY THIS IS NOT JUST ANOTHER SAVED LINK
-- crm_links are URLs a caller sends. A QR is money: it has an owner, it has to
-- be matched to a lead, and the match has to survive the donor paying two days
-- later from a different number. So a share is recorded as its own row with
-- the lead on it, and payments are matched against those rows.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS razorpay_qrs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Razorpay's own id, exactly as the dashboard shows it. The key everything
  -- matches on, so it is unique and never generated here.
  qr_id VARCHAR(60) UNIQUE NOT NULL,
  -- The hosted image Razorpay serves. Stored rather than fetched so sharing
  -- works even when Razorpay is slow or DRM has no API credentials at all.
  image_url TEXT,
  label VARCHAR(120) NOT NULL,
  -- What the money is for, when the QR is tied to one purpose.
  purpose VARCHAR(80),
  -- A fixed-amount QR, when the temple made one. NULL means the donor types
  -- the amount.
  fixed_amount NUMERIC(12,2),

  -- Whose QR it is. NULL means the temple's own, offered to everybody - the
  -- general one a caller reaches for when no personal QR fits.
  owner_id UUID REFERENCES users(id) ON DELETE SET NULL,

  active BOOLEAN NOT NULL DEFAULT TRUE,
  notes TEXT,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_qrs_owner ON razorpay_qrs(owner_id, active) WHERE active;

-- One sharing of one QR with one lead, by one caller, at one moment.
--
-- This row is the whole point of the feature: it is what a later payment is
-- matched against. Without it a QR payment is an anonymous credit in Razorpay,
-- which is exactly the situation today.
CREATE TABLE IF NOT EXISTS qr_shares (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  qr_id UUID NOT NULL REFERENCES razorpay_qrs(id) ON DELETE CASCADE,
  lead_id UUID REFERENCES leads(id) ON DELETE SET NULL,
  person_id UUID REFERENCES people(id) ON DELETE SET NULL,
  shared_by UUID REFERENCES users(id) ON DELETE SET NULL,
  session_id UUID REFERENCES calling_sessions(id) ON DELETE SET NULL,

  -- The number it went to, last ten digits - the same identity rule as
  -- everywhere else, and what a payment is matched on.
  phone VARCHAR(10) NOT NULL,
  -- What the donor said they would give, if they said. Used to rank candidate
  -- payments, never to demand an exact match: people round, and people change
  -- their minds between the call and the payment.
  expected_amount NUMERIC(12,2),
  channel VARCHAR(20) NOT NULL DEFAULT 'whatsapp',
  note TEXT,

  -- Filled in when a payment is matched to this share.
  matched_payment_id VARCHAR(60),
  matched_amount NUMERIC(12,2),
  matched_at TIMESTAMPTZ,
  -- auto (webhook matched it on the spot) | reconciled (the sweep found it) |
  -- manual (somebody linked it by hand). The same honesty rule the conversion
  -- reports follow: a match the system observed and one a person asserted are
  -- not equal evidence.
  matched_via VARCHAR(12),
  matched_by UUID REFERENCES users(id) ON DELETE SET NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_qr_shares_phone   ON qr_shares(phone, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_qr_shares_lead    ON qr_shares(lead_id, created_at DESC) WHERE lead_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_qr_shares_open    ON qr_shares(created_at DESC) WHERE matched_at IS NULL;

-- Every QR payment Razorpay tells us about, matched or not.
--
-- Stored even when nothing matches, and that is deliberate: an unmatched
-- payment is money the temple has received, and a table that only kept the
-- tidy ones would hide it. The unmatched list is a screen somebody works
-- through, not rows quietly dropped.
CREATE TABLE IF NOT EXISTS qr_payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Razorpay's payment id. Unique, so a webhook delivered three times (which
  -- Razorpay does) creates one row, not three donations.
  payment_id VARCHAR(60) UNIQUE NOT NULL,
  qr_id VARCHAR(60),
  amount NUMERIC(12,2) NOT NULL,
  -- What Razorpay says about who paid. Often a VPA and nothing else.
  payer_phone VARCHAR(10),
  payer_vpa VARCHAR(120),
  payer_name VARCHAR(160),
  status VARCHAR(20),
  raw JSONB,

  share_id UUID REFERENCES qr_shares(id) ON DELETE SET NULL,
  person_id UUID REFERENCES people(id) ON DELETE SET NULL,
  donation_id UUID REFERENCES donations(id) ON DELETE SET NULL,

  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_qr_payments_unmatched
  ON qr_payments(received_at DESC) WHERE share_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_qr_payments_qr ON qr_payments(qr_id, received_at DESC);


-- ===========================================================================
-- STORED FILES
--
-- All of this is optional. DRM ran without object storage and still does: an
-- unset bucket means these columns stay NULL and every screen falls back to
-- what it did before. Nothing here is on the path of anything that already
-- works.
-- ===========================================================================

-- The office's original workbook, kept beside the rows parsed out of it.
--
-- lead_import_rows already holds every row of every sheet, which answers "what
-- did the March sheet say about this donor". What it cannot answer is "send me
-- the file" - and an accountant asking that wants the file, with its formatting
-- and its other tabs, not a reconstruction.
ALTER TABLE lead_import_batches ADD COLUMN IF NOT EXISTS file_key  TEXT;
ALTER TABLE lead_import_batches ADD COLUMN IF NOT EXISTS file_size INT;
ALTER TABLE lead_import_batches ADD COLUMN IF NOT EXISTS file_type VARCHAR(120);

-- Which site raises the 80G receipt when a QR payment comes in.
--
-- Set when the QR is registered rather than chosen mid-call: a caller already
-- has a conversation to run, and a receipt issued from the wrong series is not
-- something they would notice.
ALTER TABLE razorpay_qrs ADD COLUMN IF NOT EXISTS receipt_site VARCHAR(20);
-- A branded image an admin uploaded, in place of Razorpay's plain square.
-- image_url stays as the fallback, so a QR with no upload still works.
ALTER TABLE razorpay_qrs ADD COLUMN IF NOT EXISTS image_key TEXT;

-- What became of a matched payment once DRM tried to turn it into a receipt.
--
-- Kept per payment rather than inferred, because "the donor paid but the site
-- refused the entry" is a real state somebody has to see and act on - not a
-- failure to retry forever, and certainly not a silent one.
ALTER TABLE qr_payments ADD COLUMN IF NOT EXISTS receipt_status VARCHAR(20);
ALTER TABLE qr_payments ADD COLUMN IF NOT EXISTS receipt_error  TEXT;
ALTER TABLE qr_payments ADD COLUMN IF NOT EXISTS receipt_number VARCHAR(80);
ALTER TABLE qr_payments ADD COLUMN IF NOT EXISTS external_donation_id VARCHAR(80);
ALTER TABLE qr_payments ADD COLUMN IF NOT EXISTS receipt_site   VARCHAR(20);

-- The donor said, on the call, that they would pay by the QR just sent.
--
-- WHY THIS IS WORTH A COLUMN
-- Without it, the screen where somebody attributes an unmatched payment has to
-- offer every QR ever shared. Most of those people never said they would pay;
-- a handful did, and one of them is almost certainly who this payment is from.
-- Recorded at the moment they say it, on the call, because that is the only
-- moment anybody knows.
--
-- Cleared when they pay, so the list is always "still waiting", never a
-- history of everyone who ever promised.
ALTER TABLE leads      ADD COLUMN IF NOT EXISTS awaiting_qr_at TIMESTAMPTZ;
ALTER TABLE qr_shares  ADD COLUMN IF NOT EXISTS awaiting_payment_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_leads_awaiting_qr
  ON leads(awaiting_qr_at DESC) WHERE awaiting_qr_at IS NOT NULL;

-- The outcome a caller picks when the donor says they will pay by QR.
--
-- suggests_status 'callback' rather than a stage of its own: they have not
-- given yet, and a stage that reads like they have is how a pipeline starts
-- lying. wants_follow_up TRUE, because somebody who says "I'll pay tonight"
-- and does not is exactly who needs ringing back.
INSERT INTO crm_dispositions (slug, label, counts_connected, suggests_status, wants_follow_up, sort_order) VALUES
  ('will_pay_qr', 'Will pay by QR', TRUE, 'callback', TRUE, 25)
ON CONFLICT (slug) DO NOTHING;

-- Why a payment is, or is not, attached to a share.
--
-- An unmatched payment on a screen with no explanation is a question nobody
-- can answer without reading the code, and the answers call for very different
-- work: a QR that DRM never shared is an office habit to correct, a missing QR
-- id is a webhook subscription to add in Razorpay, and a near-miss score is one
-- click of human judgement. The matcher writes down which.
ALTER TABLE qr_payments ADD COLUMN IF NOT EXISTS match_basis VARCHAR(10);
ALTER TABLE qr_payments ADD COLUMN IF NOT EXISTS match_score INT;
ALTER TABLE qr_payments ADD COLUMN IF NOT EXISTS match_note  TEXT;
-- The last Razorpay event that touched this row. Diagnostic: if every row says
-- payment.captured and none says qr_code.credited, the subscription that
-- carries the QR id is missing, which is the one setting that stops all of
-- this working.
ALTER TABLE qr_payments ADD COLUMN IF NOT EXISTS last_event VARCHAR(40);

CREATE INDEX IF NOT EXISTS idx_qr_payments_receipt_pending
  ON qr_payments(received_at DESC)
  WHERE share_id IS NOT NULL AND receipt_status IN ('pending', 'failed');

-- A cached copy of a receipt PDF.
--
-- WHY THIS CANNOT GO STALE
-- The key is content-addressed: it carries a fingerprint of the fields the
-- receipt actually renders - its number, the amount, the donor's name and
-- address, the date. Correct any of those and the fingerprint changes, so the
-- next request looks for a DIFFERENT object, misses, and fetches fresh. The
-- old object is never read again rather than being invalidated, which removes
-- the step everybody forgets.
--
-- An issued 80G receipt is in any case meant to be immutable - it has a number
-- and it has been sent - which is why the sites deliberately do not rewrite
-- past donations when a donor edits their profile. This table caches something
-- that should not change, and notices if it does anyway.
CREATE TABLE IF NOT EXISTS receipt_cache (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site VARCHAR(20) NOT NULL,
  external_donation_id VARCHAR(80) NOT NULL,
  -- sha256 of the receipt-bearing fields, as DRM knew them at fetch time.
  fingerprint VARCHAR(64) NOT NULL,
  storage_key TEXT NOT NULL,
  receipt_number VARCHAR(80),
  bytes INT,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_served_at TIMESTAMPTZ,
  serve_count INT NOT NULL DEFAULT 0,
  UNIQUE (site, external_donation_id, fingerprint)
);

CREATE INDEX IF NOT EXISTS idx_receipt_cache_lookup
  ON receipt_cache(site, external_donation_id, fingerprint);


-- ===========================================================================
-- UNFINISHED DONATIONS, KEPT
--
-- Somebody filled in the form on one of the sites, reached the payment screen
-- and never came back. Both sites can list those on demand, and the first
-- version of this feature asked them on every page load: twenty HTTP round
-- trips to two Mongo sites before a caller saw a single row, every time they
-- opened the screen.
--
-- So they are kept here instead. The page reads Postgres and is instant; a
-- refresh runs in the background when the copy is stale, and by hand whenever
-- somebody presses the button.
--
-- WHAT THIS TABLE IS NOT
-- It is not a second donations table. Nothing in here is money that arrived -
-- every row is an attempt that failed or was abandoned, and the moment the
-- person actually gives, the row stops being a call to make. That is computed
-- at read time against DRM's own donations rather than stored, because the
-- donation can arrive on either site, by cash, or through a QR, and a stored
-- flag would be wrong until the next refresh.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS abandoned_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Which site, and that site's own id for the attempt. Together unique, so a
  -- refresh updates rather than duplicates - the same attempt is returned by
  -- the site on every sync until it ages out of their window.
  source_site VARCHAR(20) NOT NULL,
  external_id VARCHAR(80) NOT NULL,

  phone VARCHAR(10) NOT NULL,
  name VARCHAR(255),
  email VARCHAR(255),
  amount NUMERIC(12,2),
  purpose VARCHAR(255),
  source_page VARCHAR(255),

  -- The site's own word for it: pending or failed on the main site, created on
  -- annadan (which has no failure handler at all, so everything abandoned sits
  -- as created there). Stored as given rather than normalised, because the two
  -- vocabularies genuinely mean different things.
  status VARCHAR(20),

  attempted_at TIMESTAMPTZ NOT NULL,
  -- How many times this person tried. Counted per phone at read time, but kept
  -- here too so a row can say "third attempt" without a second query.
  attempts INT NOT NULL DEFAULT 1,

  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Set when somebody decides this one is not worth a call. Survives refreshes,
  -- which is the whole reason it is a column and not a filter.
  dismissed_at TIMESTAMPTZ,
  dismissed_by UUID REFERENCES users(id) ON DELETE SET NULL,

  UNIQUE (source_site, external_id)
);

CREATE INDEX IF NOT EXISTS idx_abandoned_phone ON abandoned_attempts(phone);
CREATE INDEX IF NOT EXISTS idx_abandoned_when ON abandoned_attempts(attempted_at DESC);
CREATE INDEX IF NOT EXISTS idx_abandoned_live
  ON abandoned_attempts(attempted_at DESC) WHERE dismissed_at IS NULL;

-- When each site was last asked, and how it went. One row per site.
CREATE TABLE IF NOT EXISTS abandoned_sync_state (
  source_site VARCHAR(20) PRIMARY KEY,
  last_synced_at TIMESTAMPTZ,
  last_error TEXT,
  rows_seen INT NOT NULL DEFAULT 0,
  -- Set while a sync is running, so two page loads cannot start two of them.
  running_since TIMESTAMPTZ
);

-- How far back the last SUCCESSFUL sync reached.
--
-- Without this, "when did we last check" was the only thing recorded, and a
-- screen asking for a year could be answered out of ninety days of stored rows
-- while reporting itself as up to date three minutes ago. A view that reaches
-- further back than this is stale however recently the sync ran.
ALTER TABLE abandoned_sync_state ADD COLUMN IF NOT EXISTS synced_days INT;
-- Rows the site returned that DRM could not use: no id, no number, nothing to
-- ring. Counted rather than silently dropped, so "the site has 2,000 and DRM
-- shows 1,870" is explainable instead of unnerving.
ALTER TABLE abandoned_sync_state ADD COLUMN IF NOT EXISTS rows_skipped INT NOT NULL DEFAULT 0;
-- True when the crawl hit its page ceiling with the site still offering more.
-- The figure is then a floor, not a total, and the screen has to say so.
ALTER TABLE abandoned_sync_state ADD COLUMN IF NOT EXISTS truncated BOOLEAN NOT NULL DEFAULT FALSE;

-- An attempt with no id from the site cannot be stored: the unique key is
-- (site, external id), so every id-less row from a site would collide into one
-- row and that site's whole list would collapse to a single person.
ALTER TABLE abandoned_attempts DROP CONSTRAINT IF EXISTS abandoned_external_id_present;
ALTER TABLE abandoned_attempts ADD CONSTRAINT abandoned_external_id_present
  CHECK (external_id <> '');

-- Dismissal is per person, not per attempt: setting aside one of somebody's
-- four attempts used to promote the next one into the list the moment the
-- page reloaded, taking the value at stake UP.
CREATE INDEX IF NOT EXISTS idx_abandoned_dismissed ON abandoned_attempts(phone) WHERE dismissed_at IS NOT NULL;

-- The gave-anyway check runs this expression per person on every read; without
-- the index it is a sequential scan of people on each one.
CREATE INDEX IF NOT EXISTS idx_people_phone10
  ON people ((right(regexp_replace(phone, '\D', '', 'g'), 10)));
