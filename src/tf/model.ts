import type { CtyNumber } from '../cty-number';

/**
 * A Terraform state file as it is read: each number in it a {@link CtyNumber}, read from its text as go-cty reads a
 * JSON number.
 */

export interface TerraformStateOutput {
    value: any;
    type: string | [string, unknown];
    sensitive?: boolean;
}

export interface TerraformState {
    version: CtyNumber;
    terraform_version: string;
    serial: CtyNumber;
    lineage: string;
    outputs: Record<string, TerraformStateOutput>;
    resources: TerraformStateResource[];
}

export interface TerraformStateResource {
    module?: string;
    mode: string;
    type: string;
    name: string;
    provider: string;
    instances: TerraformStateInstance[];
}

export interface TerraformStateInstance {
    schema_version: CtyNumber;
    attributes: Record<string, any>;
    sensitive_attributes: string[];
    dependencies?: string[];
}
