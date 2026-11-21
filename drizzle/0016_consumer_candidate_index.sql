-- Narrows exact reserved fiscal-code checks to candidate records regardless of row ID.
CREATE INDEX IF NOT EXISTS idx_customers_consumer_candidates
  ON customers(CAST(json_extract(data,'$.cui') AS TEXT),id)
  WHERE json_valid(data) AND CAST(json_extract(data,'$.cui') AS TEXT) GLOB '*[gG]*'
    AND CAST(json_extract(data,'$.cui') AS TEXT) NOT GLOB '*[0-9]*';
