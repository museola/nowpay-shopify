-- Keep the existing nowpayments_payments table from the earlier setup.
CREATE TABLE IF NOT EXISTS nowpayments_invoices (
  shopify_order_id TEXT PRIMARY KEY,
  merchant_order_id TEXT NOT NULL,
  order_name TEXT NOT NULL,
  recipient_email TEXT NOT NULL,
  price_amount NUMERIC NOT NULL CHECK (price_amount > 0),
  price_currency TEXT NOT NULL,
  pay_currency TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('creating', 'created', 'review')),
  invoice_id TEXT UNIQUE,
  invoice_url TEXT,
  payment_id TEXT UNIQUE,
  email_payload JSONB,
  first_email_attempt TIMESTAMPTZ,
  email_accepted_at TIMESTAMPTZ,
  resend_email_id TEXT,
  review_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
