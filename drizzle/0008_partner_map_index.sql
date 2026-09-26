-- Additive index for bounded map reads. No data rewrite or new service.
CREATE INDEX IF NOT EXISTS idx_partner_profiles_coordinates
  ON partner_profiles(latitude, longitude, customer_id);
