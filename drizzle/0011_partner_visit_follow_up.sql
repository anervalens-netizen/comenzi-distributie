ALTER TABLE `partner_visits` ADD `next_step` text NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE `partner_visits` ADD `follow_up_date` text;
--> statement-breakpoint
CREATE INDEX `idx_partner_visits_follow_up` ON `partner_visits` (`follow_up_date`,`agent_id`,`customer_id`);
