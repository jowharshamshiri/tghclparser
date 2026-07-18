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
            console.error('Error getting AWS credentials:', err);
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
                return makeStringValue(response.Account || '');
            } catch (err) {
                console.error('Error getting AWS Account ID:', err);
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
                return makeStringValue(response.AccountAliases?.[0] || '');
            } catch (err) {
                console.error('Error getting AWS Account Alias:', err);
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
                return makeStringValue(response.Arn || '');
            } catch (err) {
                console.error('Error getting AWS Caller Identity ARN:', err);
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
                return makeStringValue(response.UserId || '');
            } catch (err) {
                console.error('Error getting AWS Caller Identity User ID:', err);
                throw new Error(`Failed to get AWS Caller Identity User ID: ${err}`);
            }
        }
    }
};