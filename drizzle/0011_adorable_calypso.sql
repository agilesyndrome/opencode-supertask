ALTER TABLE `task_runs` ADD `cost_usd` real;--> statement-breakpoint
ALTER TABLE `task_runs` ADD `input_tokens` integer;--> statement-breakpoint
ALTER TABLE `task_runs` ADD `output_tokens` integer;--> statement-breakpoint
ALTER TABLE `task_runs` ADD `reasoning_tokens` integer;--> statement-breakpoint
ALTER TABLE `task_runs` ADD `cache_read_tokens` integer;