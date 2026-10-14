-- Run as the migration/schema owner after every successful migration.
-- Role names are set_config parameters supplied by provision-runtime.sh.
BEGIN;
DO $$
DECLARE
  api_role text := current_setting('obbian.role.api');
  allocation_role text := current_setting('obbian.role.allocation');
  pipeline_role text := current_setting('obbian.role.pipeline');
  ai_role text := current_setting('obbian.role.ai');
  runtime_role text;
  relation record;
BEGIN
  FOREACH runtime_role IN ARRAY ARRAY[api_role,allocation_role,pipeline_role,ai_role] LOOP
    -- Own application relations only: extension-owned tables remain untouched.
    FOR relation IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind IN ('r','p') AND c.relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user)
    LOOP EXECUTE format('REVOKE ALL ON TABLE public.%I FROM %I',relation.relname,runtime_role); END LOOP;
    FOR relation IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind='S' AND c.relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user)
    LOOP EXECUTE format('REVOKE ALL ON SEQUENCE public.%I FROM %I',relation.relname,runtime_role); END LOOP;
    -- New relations are denied by default until reviewed in this grant list.
    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM %I',runtime_role);
    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I',runtime_role);
  END LOOP;

  EXECUTE format('GRANT SELECT ON tenants,app_users,service_categories,professional_services TO %I',api_role);
  EXECUTE format('GRANT SELECT,UPDATE ON professionals TO %I',api_role);
  EXECUTE format('GRANT SELECT,INSERT,UPDATE ON bookings,booking_offers,professional_assignments,idempotency_keys,payment_intents,payment_webhook_inbox,payment_refunds,ledger_accounts,settlements TO %I',api_role);
  EXECUTE format('GRANT SELECT,INSERT ON booking_quotes TO %I',api_role);
  EXECUTE format('GRANT SELECT,INSERT ON booking_locations,outbox_events,ledger_transactions,ledger_entries TO %I',api_role);
  EXECUTE format('GRANT USAGE ON SEQUENCE booking_locations_id_seq,ledger_entries_id_seq TO %I',api_role);

  EXECUTE format('GRANT SELECT ON professionals,professional_services,professional_assignments TO %I',allocation_role);
  -- SELECT FOR UPDATE requires UPDATE privilege on at least one column.
  EXECUTE format('GRANT UPDATE(id) ON professionals TO %I',allocation_role);
  EXECUTE format('GRANT SELECT,UPDATE ON bookings TO %I',allocation_role);
  EXECUTE format('GRANT SELECT,INSERT,UPDATE ON booking_offers TO %I',allocation_role);
  EXECUTE format('GRANT INSERT ON outbox_events TO %I',allocation_role);

  EXECUTE format('GRANT SELECT ON bookings TO %I',pipeline_role);
  EXECUTE format('GRANT SELECT,UPDATE ON outbox_events TO %I',pipeline_role);
  EXECUTE format('GRANT SELECT,INSERT,UPDATE ON consumer_inbox,dead_letters,daily_booking_metrics TO %I',pipeline_role);
  EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON processing_failures TO %I',pipeline_role);
  EXECUTE format('GRANT USAGE ON SEQUENCE dead_letters_id_seq TO %I',pipeline_role);

  EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON knowledge_documents,knowledge_document_acl,knowledge_chunks TO %I',ai_role);
  EXECUTE format('GRANT SELECT,INSERT,UPDATE ON ai_conversations TO %I',ai_role);
  EXECUTE format('GRANT INSERT ON ai_audit_events TO %I',ai_role);
END $$;
COMMIT;
