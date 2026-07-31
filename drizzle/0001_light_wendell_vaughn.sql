CREATE TABLE `comments` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`parent_id` text,
	`target_type` text NOT NULL,
	`target_id` text,
	`target_label` text NOT NULL,
	`body` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`author_id` text NOT NULL,
	`resolved_by_id` text,
	`resolved_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`parent_id`) REFERENCES `comments`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`author_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`resolved_by_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "comments_target_type_check" CHECK("comments"."target_type" in ('diagram', 'table')),
	CONSTRAINT "comments_target_id_check" CHECK((("comments"."target_type" = 'diagram' and "comments"."target_id" is null) or ("comments"."target_type" = 'table' and "comments"."target_id" is not null))),
	CONSTRAINT "comments_status_check" CHECK("comments"."status" in ('open', 'resolved')),
	CONSTRAINT "comments_body_length_check" CHECK(length(trim("comments"."body")) between 1 and 2000)
);
--> statement-breakpoint
CREATE INDEX `comments_project_created_idx` ON `comments` (`project_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `comments_project_target_created_idx` ON `comments` (`project_id`,`target_type`,`target_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `comments_parent_idx` ON `comments` (`parent_id`);