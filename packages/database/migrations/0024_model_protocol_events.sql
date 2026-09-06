ALTER TABLE agent_run_events
  DROP CONSTRAINT IF EXISTS agent_run_events_kind_check;

ALTER TABLE agent_run_events
  ADD CONSTRAINT agent_run_events_kind_check CHECK (kind IN (
    'run_started', 'model_requested', 'model_responded',
    'tool_requested', 'tool_completed', 'steering_applied',
    'completion_rejected', 'model_protocol_rejected', 'run_finished'
  ));
