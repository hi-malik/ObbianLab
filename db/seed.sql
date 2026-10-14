BEGIN;

INSERT INTO tenants (id, name) VALUES
  ('11111111-1111-4111-8111-111111111111', 'Obbian Demo')
ON CONFLICT DO NOTHING;

INSERT INTO app_users (id, tenant_id, external_subject, display_name, roles) VALUES
  ('22222222-2222-4222-8222-222222222222', '11111111-1111-4111-8111-111111111111', 'demo-customer', 'Demo Customer', ARRAY['customer']),
  ('33333333-3333-4333-8333-333333333333', '11111111-1111-4111-8111-111111111111', 'demo-electrician', 'Asha Electricals', ARRAY['professional']),
  ('66666666-6666-4666-8666-666666666666', '11111111-1111-4111-8111-111111111111', 'demo-finance', 'Demo Finance', ARRAY['finance']),
  ('77777777-7777-4777-8777-777777777777', '11111111-1111-4111-8111-111111111111', 'demo-knowledge-admin', 'Demo Knowledge Admin', ARRAY['knowledge_admin'])
ON CONFLICT DO NOTHING;

INSERT INTO service_categories (id, tenant_id, slug, name) VALUES
  ('55555555-5555-4555-8555-555555555551', '11111111-1111-4111-8111-111111111111', 'electrician', 'Electrician'),
  ('55555555-5555-4555-8555-555555555552', '11111111-1111-4111-8111-111111111111', 'plumber', 'Plumber'),
  ('55555555-5555-4555-8555-555555555553', '11111111-1111-4111-8111-111111111111', 'cleaner', 'Cleaner'),
  ('55555555-5555-4555-8555-555555555554', '11111111-1111-4111-8111-111111111111', 'ride', 'Auto ride')
ON CONFLICT DO NOTHING;

INSERT INTO professionals
  (id, tenant_id, user_id, status, location, location_recorded_at, service_radius_m, rating)
VALUES
  ('44444444-4444-4444-8444-444444444444', '11111111-1111-4111-8111-111111111111',
   '33333333-3333-4333-8333-333333333333', 'available',
   ST_SetSRID(ST_MakePoint(77.2092, 28.6141), 4326)::geography, now(), 15000, 4.85)
ON CONFLICT (id) DO UPDATE SET status = 'available', location_recorded_at = now();

INSERT INTO professional_services (professional_id, category_id)
VALUES ('44444444-4444-4444-8444-444444444444', '55555555-5555-4555-8555-555555555551')
ON CONFLICT DO NOTHING;

COMMIT;
