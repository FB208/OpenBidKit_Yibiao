ALTER TABLE stats_agent_runtime ADD COLUMN model_run_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE stats_agent_runtime ADD COLUMN model_retry_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE stats_agent_runtime ADD COLUMN model_retried_run_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE stats_agent_runtime ADD COLUMN model_retry_success_count INTEGER NOT NULL DEFAULT 0;
