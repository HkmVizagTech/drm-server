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
