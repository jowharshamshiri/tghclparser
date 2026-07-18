import { IAMClient, ListAccountAliasesCommand } from "@aws-sdk/client-iam";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { fromNodeProviderChain } from "@aws-sdk/credential-providers";
import type { AwsCredentialIdentity } from "@aws-sdk/types";

import type { FunctionContext, RuntimeValue, ValueType } from '../model';
import { makeStringValue } from "./utils";

export interface AWSHelperOptions {
    profile?: string;
    roleArn?: string;
    region?: string;
    assumeRoleDuration?: number;
    sessionName?: string;
}

export class AWSHelper {
    private static instance: AWSHelper;
    private credentials: AwsCredentialIdentity | null = null;

    private constructor() {}

    static getInstance(): AWSHelper {
        if (!AWSHelper.instance) {
            AWSHelper.instance = new AWSHelper();
        }
        return AWSHelper.instance;
    }

    async getCredentials(options: AWSHelperOptions = {}): Promise<AwsCredentialIdentity> {
        if (this.credentials) {
            return this.credentials;
        }

        try {
            // Use the default credential provider chain
            const credentialProvider = fromNodeProviderChain({
                profile: options.profile,
                roleArn: options.roleArn,
                durationSeconds: options.assumeRoleDuration,
                roleSessionName: options.sessionName
            });

            this.credentials = await credentialProvider();
            return this.credentials;
        } catch (err) {
            throw new Error(`Failed to get AWS credentials: ${err}`);
        }
    }

    clearCredentials(): void {
        this.credentials = null;
    }
}

// Helper function to get credentials with options
export async function getAWSCredentials(options: AWSHelperOptions = {}): Promise<AwsCredentialIdentity> {
    const helper = AWSHelper.getInstance();
    return helper.getCredentials(options);
}

// Singleton clients for AWS services
let iamClient: IAMClient | null = null;
let stsClient: STSClient | null = null;

const getIAMClient = (region?: string) => {
    if (!iamClient) {
        iamClient = new IAMClient({ region: region || 'us-east-1' });
    }
    return iamClient;
};

const getSTSClient = (region?: string) => {
    if (!stsClient) {
        stsClient = new STSClient({ region: region || 'us-east-1' });
    }
    return stsClient;
};

export const awsFunctionGroup = {
    namespace: 'aws',
    functions: {
        get_aws_account_id: async (
            _args: RuntimeValue<ValueType>[],
            _context: FunctionContext
        ): Promise<RuntimeValue<ValueType>> => {
            try {
                const client = getSTSClient();
                const command = new GetCallerIdentityCommand({});
                const response = await client.send(command);
                if (!response.Account) throw new Error('AWS STS response omitted Account');
                return makeStringValue(response.Account);
            } catch (err) {
                throw new Error(`Failed to get AWS Account ID: ${err}`);
            }
        },

        get_aws_account_alias: async (
            _args: RuntimeValue<ValueType>[],
            _context: FunctionContext
        ): Promise<RuntimeValue<ValueType>> => {
            try {
                const client = getIAMClient();
                const command = new ListAccountAliasesCommand({});
                const response = await client.send(command);
                const alias = response.AccountAliases?.[0];
                if (!alias) throw new Error('AWS account has no alias');
                return makeStringValue(alias);
            } catch (err) {
                throw new Error(`Failed to get AWS Account Alias: ${err}`);
            }
        },

        get_aws_caller_identity_arn: async (
            _args: RuntimeValue<ValueType>[],
            _context: FunctionContext
        ): Promise<RuntimeValue<ValueType>> => {
            try {
                const client = getSTSClient();
                const command = new GetCallerIdentityCommand({});
                const response = await client.send(command);
                if (!response.Arn) throw new Error('AWS STS response omitted Arn');
                return makeStringValue(response.Arn);
            } catch (err) {
                throw new Error(`Failed to get AWS Caller Identity ARN: ${err}`);
            }
        },

        get_aws_caller_identity_user_id: async (
            _args: RuntimeValue<ValueType>[],
            _context: FunctionContext
        ): Promise<RuntimeValue<ValueType>> => {
            try {
                const client = getSTSClient();
                const command = new GetCallerIdentityCommand({});
                const response = await client.send(command);
                if (!response.UserId) throw new Error('AWS STS response omitted UserId');
                return makeStringValue(response.UserId);
            } catch (err) {
                throw new Error(`Failed to get AWS Caller Identity User ID: ${err}`);
            }
        }
    }
};
