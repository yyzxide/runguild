-- Bind model evidence to the exact transport endpoint and the model identifier
-- returned by the provider. Existing records remain explicitly unknown.
ALTER TABLE llm_calls
  ADD COLUMN IF NOT EXISTS endpoint TEXT,
  ADD COLUMN IF NOT EXISTS returned_model TEXT,
  ADD CONSTRAINT ck_llm_calls_endpoint
    CHECK (endpoint IS NULL OR (endpoint = btrim(endpoint) AND char_length(endpoint) BETWEEN 1 AND 2048)),
  ADD CONSTRAINT ck_llm_calls_returned_model
    CHECK (returned_model IS NULL OR (returned_model = btrim(returned_model) AND char_length(returned_model) BETWEEN 1 AND 256));

ALTER TABLE review_executions
  ADD COLUMN IF NOT EXISTS model_endpoint TEXT,
  ADD COLUMN IF NOT EXISTS returned_model TEXT,
  ADD CONSTRAINT ck_review_executions_model_endpoint
    CHECK (model_endpoint IS NULL OR (model_endpoint = btrim(model_endpoint) AND char_length(model_endpoint) BETWEEN 1 AND 2048)),
  ADD CONSTRAINT ck_review_executions_returned_model
    CHECK (returned_model IS NULL OR (returned_model = btrim(returned_model) AND char_length(returned_model) BETWEEN 1 AND 256));

ALTER TABLE reviewer_model_calls
  ADD COLUMN IF NOT EXISTS endpoint TEXT,
  ADD COLUMN IF NOT EXISTS returned_model TEXT,
  ADD CONSTRAINT ck_reviewer_model_calls_endpoint
    CHECK (endpoint IS NULL OR (endpoint = btrim(endpoint) AND char_length(endpoint) BETWEEN 1 AND 2048)),
  ADD CONSTRAINT ck_reviewer_model_calls_returned_model
    CHECK (returned_model IS NULL OR (returned_model = btrim(returned_model) AND char_length(returned_model) BETWEEN 1 AND 256));

ALTER TABLE conversation_planning_requests
  ADD COLUMN IF NOT EXISTS model_endpoint TEXT,
  ADD COLUMN IF NOT EXISTS returned_model TEXT,
  ADD CONSTRAINT ck_conversation_planning_model_endpoint
    CHECK (model_endpoint IS NULL OR (model_endpoint = btrim(model_endpoint) AND char_length(model_endpoint) BETWEEN 1 AND 2048)),
  ADD CONSTRAINT ck_conversation_planning_returned_model
    CHECK (returned_model IS NULL OR (returned_model = btrim(returned_model) AND char_length(returned_model) BETWEEN 1 AND 256));
