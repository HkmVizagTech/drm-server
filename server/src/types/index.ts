export type PersonRole = 'donor' | 'volunteer' | 'folk' | 'congregation';

export type DonationType = 'one-time' | 'recurring' | 'in-kind' | 'event-sponsorship';
export type DonationPurpose = 'annadan' | 'temple_maintenance' | 'festival' | 'general';
export type PaymentMode = 'upi' | 'card' | 'netbanking' | 'cash' | 'bank_transfer';
export type DonationSource = 'website' | 'annadan_subdomain' | 'counter';

export type SevaType = 'abhishekam' | 'archana' | string;

export type BookingStatus = 'confirmed' | 'cancelled';

export type TriggerType =
  | 'birthday'
  | 'anniversary'
  | 'receipt_ready'
  | 'seva_confirmed'
  | 'subscription_payment_failed'
  | 'prasadam_shipped'
  | 'prasadam_delivered';
export type TriggerStatus = 'pending' | 'sent' | 'failed';

export type UserRole = 'admin' | 'accountant' | 'volunteer_coordinator';

export type SubscriptionFrequency = 'monthly' | 'quarterly' | 'yearly';
export type SubscriptionStatus = 'active' | 'paused' | 'cancelled';
export type PrasadamStatus = 'pending' | 'packed' | 'shipped' | 'delivered' | 'returned';

export interface Person {
  id: string;
  name: string;
  phone: string;
  email?: string;
  address?: string;
  pan?: string;
  roles: PersonRole[];
  date_of_birth?: string;
  anniversary_date?: string;
  prasadam_address?: string;
  created_at: string;
  updated_at: string;
}

export interface Donation {
  id: string;
  person_id: string;
  amount: number;
  type: DonationType;
  purpose: DonationPurpose;
  payment_mode: PaymentMode;
  source: DonationSource;
  receipt_generated: boolean;
  receipt_number?: string;
  receipt_url?: string;
  receipt_issued_at?: string;
  subscription_id?: string;
  external_ref?: string;
  created_at: string;
}

export interface SevaSlot {
  id: string;
  seva_type: string;
  event_id?: string;
  slot_datetime: string;
  slots_booked: number;
  max_slots: number;
  status: BookingStatus;
}

export interface Event {
  id: string;
  name: string;
  date_start: string;
  date_end: string;
  description?: string;
}

export interface Trigger {
  id: string;
  person_id: string;
  trigger_type: TriggerType;
  payload: Record<string, unknown>;
  status: TriggerStatus;
  created_at: string;
}

export interface User {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  created_at: string;
}

export interface AuthPayload {
  userId: string;
  role: UserRole;
}

export interface Subscription {
  id: string;
  person_id: string;
  amount: number;
  frequency: SubscriptionFrequency;
  purpose: DonationPurpose;
  status: SubscriptionStatus;
  gateway_subscription_id?: string;
  start_date: string;
  next_charge_date?: string;
  external_ref?: string;
  created_at: string;
  updated_at: string;
}

export interface PrasadamDelivery {
  id: string;
  person_id: string;
  donation_id?: string;
  address: string;
  status: PrasadamStatus;
  courier_name?: string;
  tracking_number?: string;
  dispatched_at?: string;
  delivered_at?: string;
  notes?: string;
  external_ref?: string;
  created_at: string;
}

export interface PersonNote {
  id: string;
  person_id: string;
  author_user_id?: string;
  note: string;
  created_at: string;
}
