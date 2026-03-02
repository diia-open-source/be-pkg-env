export enum Env {
    Local = 'local',
    Test = 'test',
    Dev = 'dev',
    Sandbox = 'sandbox',
    Stage = 'stage',
    Prod = 'prod',
}

export interface GetSecretOps {
    accessor?: string
    nullable?: boolean
}

export type GetTransitKeyResult = {
    keys: Record<number, string>
    name: string
    type: string
}

export type GetTransitKeyReadResult = Record<string, unknown> & {
    data: GetTransitKeyResult
}

export interface GetTransitKeyOps {
    keyVersion?: string
}

export interface ProcessedTransitKey {
    fullKeyName: string
    key: string
}
