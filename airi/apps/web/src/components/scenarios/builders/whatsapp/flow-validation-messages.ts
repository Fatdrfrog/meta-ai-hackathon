import type {
  FlowValidationIssue,
  FlowValidationIssueCode,
} from "./flow-validation";

type Translate = (key: string) => string;

const MESSAGE_KEY_BY_CODE: Record<FlowValidationIssueCode, string> = {
  flow_layout_content_invalid: "flowValidationLayoutContentInvalid",
  flow_text_invalid: "flowValidationTextInvalid",
  flow_text_max_length: "flowValidationTextMaxLength",
  flow_screen_success_invalid: "flowValidationScreenSuccessInvalid",
  flow_navigation_composition_invalid:
    "flowValidationNavigationCompositionInvalid",
  flow_graph_bounds_exceeded: "flowValidationGraphBoundsExceeded",
  flow_version_required: "flowValidationVersionRequired",
  screens_required: "flowValidationScreensRequired",
  screens_max_exceeded: "flowValidationScreensMaxExceeded",
  screen_id_required: "flowValidationScreenIdRequired",
  screen_id_max_length: "flowValidationScreenIdMaxLength",
  screen_id_reserved: "flowValidationScreenIdReserved",
  screen_title_max_length: "flowValidationScreenTitleMaxLength",
  screen_layout_type_invalid: "flowValidationLayoutTypeInvalid",
  screen_layout_children_required: "flowValidationLayoutChildrenRequired",
  screen_max_components_exceeded: "flowValidationScreenMaxComponents",
  form_name_required: "flowValidationFormNameRequired",
  form_children_required: "flowValidationFormChildrenRequired",
  component_type_required: "flowValidationTypeRequired",
  component_label_required: "flowValidationLabelRequired",
  component_label_max_length: "flowValidationLabelMaxLength",
  component_name_required: "flowValidationNameRequired",
  component_data_source_required: "flowValidationDataSourceRequired",
  data_source_option_id_required: "flowValidationOptionIdRequired",
  data_source_option_title_required: "flowValidationOptionTitleRequired",
  data_source_option_title_max_length: "flowValidationOptionTitleMaxLength",
  data_source_max_options_exceeded: "flowValidationMaxOptionsExceeded",
  footer_label_max_length: "flowValidationFooterLabelMaxLength",
  footer_action_required: "flowValidationFooterActionRequired",
  footer_action_name_invalid: "flowValidationFooterActionNameInvalid",
  meta_flow_id_required: "flowValidationMetaFlowIdRequired",
  flow_field_id_duplicate_across_screens:
    "flowValidationFlowFieldIdDuplicateAcrossScreens",
  flow_endpoint_screens_required: "flowValidationEndpointScreensRequired",
  flow_endpoint_invalid: "flowValidationEndpointInvalid",
  flow_routing_edges_exceeded: "flowValidationRoutingEdgesExceeded",
  flow_graph_screen_duplicate: "flowValidationGraphScreenDuplicate",
  flow_field_id_duplicate_within_screen:
    "flowValidationFieldDuplicateWithinScreen",
  flow_graph_action_invalid: "flowValidationGraphActionInvalid",
  flow_graph_target_invalid: "flowValidationGraphTargetInvalid",
  flow_graph_screen_unreachable: "flowValidationGraphScreenUnreachable",
  flow_graph_cycle: "flowValidationGraphCycle",
  flow_graph_terminal_required: "flowValidationGraphTerminalRequired",
  flow_graph_payload_invalid: "flowValidationGraphPayloadInvalid",
  flow_graph_data_invalid: "flowValidationGraphDataInvalid",
  flow_navigation_items_invalid: "flowValidationNavigationItemsInvalid",
  flow_navigation_item_text_invalid: "flowValidationNavigationItemTextInvalid",
  flow_option_description_max_length:
    "flowValidationOptionDescriptionMaxLength",
};

export function formatFlowValidationIssue(
  issue: FlowValidationIssue,
  t: Translate
): string {
  return `${issue.path}: ${t(MESSAGE_KEY_BY_CODE[issue.code] || "flowValidationUnknown")}`;
}
