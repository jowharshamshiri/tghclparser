export interface TerraformStateOutput {
    value: any;
    type: string;
    sensitive?: boolean;
}

export interface TerraformState {
    version: number;
    terraform_version: string;
    serial: number;
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
    schema_version: number;
    attributes: Record<string, any>;
    sensitive_attributes: string[];
    dependencies?: string[];
}