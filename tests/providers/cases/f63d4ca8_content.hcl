include "root" {
  path = find_in_parent_folders()
}

dependency "global" {
  config_path = "../../global"
}

dependency "kube_planning_step" {
  config_path = "../kube_planning"
}

inputs = {
  global_state             = dependency.global.outputs.global_state
  kube_inventory_file_path = dependency.kube_planning_step.outputs.kube_inventory_file_path
}

