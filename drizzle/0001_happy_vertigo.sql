CREATE TABLE `order_payload_archive` (
	`order_id` text NOT NULL,
	`chunk_index` integer NOT NULL,
	`chunk` text NOT NULL,
	PRIMARY KEY(`order_id`, `chunk_index`)
);
--> statement-breakpoint
WITH RECURSIVE parts(order_id, chunk_index, chunk) AS (
  SELECT id, 0, substr(payload, 1, 1000) FROM orders
  UNION ALL
  SELECT parts.order_id, parts.chunk_index + 1,
    substr(orders.payload, (parts.chunk_index + 1) * 1000 + 1, 1000)
  FROM parts JOIN orders ON orders.id = parts.order_id
  WHERE length(orders.payload) > (parts.chunk_index + 1) * 1000
)
INSERT INTO order_payload_archive (order_id, chunk_index, chunk)
SELECT order_id, chunk_index, chunk FROM parts;
--> statement-breakpoint
CREATE TRIGGER order_archive_after_insert AFTER INSERT ON orders BEGIN
  INSERT INTO order_payload_archive (order_id, chunk_index, chunk)
  SELECT NEW.id, i, substr(NEW.payload, i * 1000 + 1, 1000)
  FROM (WITH RECURSIVE indices(i) AS (
    SELECT 0 UNION ALL SELECT i + 1 FROM indices WHERE length(NEW.payload) > (i + 1) * 1000
  ) SELECT i FROM indices);
END;
--> statement-breakpoint
CREATE TRIGGER order_archive_after_update AFTER UPDATE OF payload ON orders BEGIN
  DELETE FROM order_payload_archive WHERE order_id = NEW.id;
  INSERT INTO order_payload_archive (order_id, chunk_index, chunk)
  SELECT NEW.id, i, substr(NEW.payload, i * 1000 + 1, 1000)
  FROM (WITH RECURSIVE indices(i) AS (
    SELECT 0 UNION ALL SELECT i + 1 FROM indices WHERE length(NEW.payload) > (i + 1) * 1000
  ) SELECT i FROM indices);
END;
