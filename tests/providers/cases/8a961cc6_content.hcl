include "root" {
  path = find_in_parent_folders()
}

dependency "global" {
  config_path = "../../global"
}

dependency "provisioning_step" {
  config_path = "../provisioning"
}

dependency "kube_planning_step" {
  config_path = "../kube_planning"
}

inputs = {
  global_state             = dependency.global.outputs.global_state
  inventory_yaml_file_path = dependency.provisioning_step.outputs.inventory_yaml_file_path
  kube_inventory_file_path = dependency.kube_planning_step.outputs.kube_inventory_file_path
  hostnames                = dependency.kube_planning_step.outputs.hostnames
}

