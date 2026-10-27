-- Meta Model API calls (Muse Spark, Muse Image, SAM 3.1 in product video
-- imports) count against a workspace's AI spend like Anthropic, Vertex and
-- ElevenLabs. Only the accepted provider list changes: the constraint, and
-- the same list inside reserve_workspace_ai_spend, whose body is otherwise
-- unchanged from production as of 2026-10-28.

alter table public.workspace_ai_spend_operations
  drop constraint workspace_ai_spend_operations_provider_check,
  add constraint workspace_ai_spend_operations_provider_check
    check (provider = any (array['anthropic'::text, 'vertex'::text, 'elevenlabs'::text, 'meta'::text]));

create or replace function public.reserve_workspace_ai_spend(
  p_workspace_id uuid,
  p_action_id text,
  p_operation_id text,
  p_provider text,
  p_max_cost_micros bigint
)
returns jsonb
language plpgsql
set search_path to ''
as $function$
declare
  v_decision jsonb;
  v_company_id uuid;
  v_usage public.company_ai_usage%rowtype;
  v_action public.workspace_text_ai_actions%rowtype;
  v_policy public.ai_sponsorship_policies%rowtype;
  v_operation public.workspace_ai_spend_operations%rowtype;
begin
  if p_operation_id is null or length(btrim(p_operation_id)) not between 1 and 512
    or p_provider is null or p_provider not in ('anthropic', 'vertex', 'elevenlabs', 'meta')
    or p_max_cost_micros is null or p_max_cost_micros <= 0 then
    raise exception 'Invalid AI spend reservation' using errcode = '22023';
  end if;
  v_decision := public.admit_workspace_text_ai_action(p_workspace_id, p_action_id);
  if v_decision->>'billing_source' <> 'platform' then
    return jsonb_build_object('code', 'own_ai_source_required');
  end if;
  v_company_id := (v_decision->>'company_id')::uuid;
  select * into strict v_usage from public.company_ai_usage where company_id = v_company_id for update;
  select * into strict v_action from public.workspace_text_ai_actions where workspace_id = p_workspace_id and action_id = p_action_id for update;
  select * into strict v_policy from public.ai_sponsorship_policies where plan = v_action.plan;
  select * into v_operation from public.workspace_ai_spend_operations
  where workspace_id = p_workspace_id and action_id = p_action_id and operation_id = p_operation_id;
  if found then
    if v_operation.provider <> p_provider or v_operation.max_cost_micros <> p_max_cost_micros then
      raise exception 'AI operation identity conflict' using errcode = '22023';
    end if;
    return jsonb_build_object('code', 'workspace_ai_operation_replayed');
  end if;
  if v_usage.committed_micros + p_max_cost_micros > coalesce(v_usage.company_spend_limit_micros, v_policy.company_spend_limit_micros)
    or v_action.committed_micros + p_max_cost_micros > coalesce(v_usage.action_spend_limit_micros, v_policy.action_spend_limit_micros) then
    return jsonb_build_object('code', 'workspace_ai_spend_limit');
  end if;
  insert into public.workspace_ai_spend_operations(workspace_id, action_id, operation_id, company_id, provider, max_cost_micros)
  values(p_workspace_id, p_action_id, p_operation_id, v_company_id, p_provider, p_max_cost_micros);
  update public.company_ai_usage set committed_micros = committed_micros + p_max_cost_micros where company_id = v_company_id;
  update public.workspace_text_ai_actions set committed_micros = committed_micros + p_max_cost_micros where workspace_id = p_workspace_id and action_id = p_action_id;
  return jsonb_build_object('code', 'reserved', 'workspace_id', p_workspace_id, 'action_id', p_action_id,
    'operation_id', p_operation_id, 'max_cost_micros', p_max_cost_micros);
end;
$function$;
