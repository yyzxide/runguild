-- Preserve the distinction between a priced zero-cost Trial and unavailable
-- model pricing. The old collector collapsed any NULL call price into zero.
UPDATE evaluation_trials AS trial
SET metrics = jsonb_set(trial.metrics, '{estimatedCostUsd}', 'null'::jsonb, false),
    updated_at = NOW()
WHERE trial.metrics IS NOT NULL
  AND trial.mission_id IS NOT NULL
  AND (
    EXISTS (
      SELECT 1
      FROM llm_calls AS call
      WHERE call.mission_id = trial.mission_id
        AND call.estimated_cost_usd IS NULL
    )
    OR EXISTS (
      SELECT 1
      FROM reviewer_model_calls AS call
      WHERE call.mission_id = trial.mission_id
        AND call.estimated_cost_usd IS NULL
    )
  );
