// Loaded first by test-phone-app.ts: points recording storage at a stand-in
// S3 server the test runs itself, before storage.ts reads these at import.
process.env.R2_ACCOUNT_ID = 'test';
process.env.R2_ACCESS_KEY_ID = 'test';
process.env.R2_SECRET_ACCESS_KEY = 'test';
process.env.R2_BUCKET = 'drm-test';
process.env.R2_ENDPOINT = `http://127.0.0.1:${process.env.FAKE_S3_PORT ?? '4599'}`;
