UPDATE "sms_receiver_bindings"
SET "code_received_at" = "created_at"
WHERE "code_received_at" IS NULL
  AND "created_at" < '2026-08-05T03:07:55.082Z'::timestamptz;
