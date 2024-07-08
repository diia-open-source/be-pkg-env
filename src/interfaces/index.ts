export enum Env {
    Local = 'local',
    Test = 'test',
    Stage = 'stage',
    Dev = 'dev',
    Prod = 'prod',
}

export interface GetSecretOps {
    accessor?: string
    nullable?: boolean
}
