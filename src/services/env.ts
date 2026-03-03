import fs from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'

import get from 'lodash.get'

import { DurationMs, Logger, OnDestroy } from '@diia-inhouse/types'

import { Env, GetSecretOps, GetTransitKeyOps, GetTransitKeyReadResult, ProcessedTransitKey } from '../interfaces'
import { vaultRequestsTotalMetric } from '../metrics'
import { VaultClient } from './vaultClient'

export class EnvService implements OnDestroy {
    private readonly kubernetesPath = 'kubernetes'

    private readonly isVaultEnabled = EnvService.getVar('VAULT_ENABLED', 'boolean', false)

    private readonly renewalLeaseLifetime = EnvService.getVar('VAULT_RENEWAL_LEASE_LIFETIME', 'number', 0.6)

    private readonly renewalMaxDelay = EnvService.getVar('VAULT_RENEWAL_MAX_DELAY', 'number', DurationMs.Minute)

    private readonly rawSecrets = new Map<string, Record<string, string>>()

    private vault: VaultClient | null = null

    constructor(private logger: Logger) {
        if (!this.isVaultEnabled) {
            return
        }

        this.vault = new VaultClient(EnvService.getVar('VAULT_ADDR'))
    }

    static getVar(name: string, type: 'boolean', defaultValue?: boolean | null): boolean
    static getVar(name: string, type: 'number', defaultValue?: number | null): number
    static getVar(name: string, type?: 'string', defaultValue?: string | null): string
    static getVar<T extends unknown[]>(name: string, type: 'object', defaultValue?: T | null): T
    static getVar<T extends Record<string, unknown>>(name: string, type: 'object', defaultValue?: T | null): T
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    static getVar(name: string, type: 'string' | 'boolean' | 'number' | 'object' = 'string', defaultValue?: unknown): any {
        const value = process.env[name]

        if (!value) {
            if (defaultValue || defaultValue !== undefined) {
                return defaultValue
            }

            throw new Error(`Env variable ${name} is not defined`)
        }

        if (type === 'string') {
            return value
        }

        try {
            const parsedValue = JSON.parse(value)

            if (typeof parsedValue !== type) {
                throw new TypeError(`Unexpected typeof ${name} variable; Current typeof ${typeof parsedValue}`)
            }

            return parsedValue
        } catch (err) {
            throw new Error(`Error while parsing ${name} variable. Current value: ${value}; ${err}`)
        }
    }

    async init(): Promise<void> {
        if (!this.vault) {
            return
        }

        try {
            const tokenPath = EnvService.getVar('KUBERNETES_TOKEN_PATH', 'string', '/var/run/secrets/kubernetes.io/serviceaccount/token')
            // eslint-disable-next-line security/detect-non-literal-fs-filename
            const k8sToken = await fs.readFile(tokenPath, 'utf8') // nosemgrep: eslint.detect-non-literal-fs-filename
            const loginResult = await this.vault.kubernetesLogin({
                jwt: k8sToken,
                kubernetesPath: this.kubernetesPath,
                role: EnvService.getVar('VAULT_ROLE'),
            })
            const {
                auth: { client_token: token, lease_duration: leaseDuration, accessor, service_account_name },
            } = loginResult

            this.logger = this.logger.child({ vaultServiceAccountName: service_account_name })
            this.logger.info('Vault token accessor', { accessor })

            this.vault.token = token
            this.scheduleTokenRenewal(leaseDuration)
        } catch (err) {
            this.logger.error('Failed to init vault', { err })

            throw err
        }
    }

    async onDestroy(): Promise<void> {
        await this.revokeToken()
    }

    async getSecret(envName: string, ops: GetSecretOps = {}): Promise<string> {
        const { accessor = `data.${envName}`, nullable } = ops
        const envValue = EnvService.getVar(envName, 'string', nullable ? null : undefined)
        if (!this.vault) {
            return envValue
        }

        const cachedRawSecret = this.rawSecrets.get(envValue)
        if (cachedRawSecret) {
            return get(cachedRawSecret, accessor)
        }

        try {
            const result = await this.vault.read(envValue)
            const { data, lease_id: leaseId, lease_duration: leaseDuration } = result
            if (leaseId) {
                this.scheduleLeaseRenewal(leaseId, leaseDuration)
            }

            this.rawSecrets.set(envValue, data)
            vaultRequestsTotalMetric.increment({ status: 'success', method: 'get_secret' })

            return get(data, accessor)
        } catch (err) {
            vaultRequestsTotalMetric.increment({ status: 'failure', method: 'get_secret' })
            this.logger.error('Failed to get vault secret', { err, envName, envValue })

            throw err
        }
    }

    async getTransitKey(keyId: string, ops: GetTransitKeyOps = {}): Promise<ProcessedTransitKey> {
        const { keyVersion } = ops
        if (!this.vault) {
            throw new Error('Vault is not initialized. Failed to get transit key')
        }

        try {
            const vaultPath = keyVersion ? `${keyId}/${keyVersion}` : keyId

            const { data }: GetTransitKeyReadResult = await this.vault.read(vaultPath)

            const keyVersions = Object.keys(data.keys)
            const highestKeyVersion = keyVersions.sort((a, b) => Number(b) - Number(a))[0]

            if (!highestKeyVersion) {
                throw new Error(`No key versions found for key ${keyId}`)
            }

            const key = data.keys[Number(highestKeyVersion)]
            const fullKeyName = `${keyId}/${highestKeyVersion}`

            return { fullKeyName, key }
        } catch (err) {
            this.logger.error('Failed to get transit key', { err, path: keyId })
            throw err
        }
    }

    isLocal(): boolean {
        return this.getEnv() === Env.Local
    }

    isTest(): boolean {
        return this.getEnv() === Env.Test
    }

    isSandbox(): boolean {
        return this.getEnv() === Env.Sandbox
    }

    isStage(): boolean {
        return this.getEnv() === Env.Stage
    }

    isDev(): boolean {
        return this.getEnv() === Env.Dev
    }

    isProd(): boolean {
        return this.getEnv() === Env.Prod
    }

    getEnv(): Env {
        return process.env.NODE_ENV as Env
    }

    private async renewToken(retryDelay = DurationMs.Second): Promise<void> {
        if (!this.vault) {
            return
        }

        this.logger.info('Start vault token renewing')
        try {
            const {
                auth: { lease_duration: leaseDuration },
            } = await this.vault.tokenRenewSelf()

            this.scheduleTokenRenewal(leaseDuration)
            vaultRequestsTotalMetric.increment({ status: 'success', method: 'renew_token' })
        } catch (err) {
            if (err instanceof Error && err.message.includes('permission denied')) {
                this.logger.error('Vault token is revoked. Exiting', { err })
                process.emit('SIGINT')

                return
            }

            vaultRequestsTotalMetric.increment({ status: 'failure', method: 'renew_token' })

            if (retryDelay > this.renewalMaxDelay) {
                retryDelay = this.renewalMaxDelay
            }

            this.logger.error(`Failed to renew vault token. Retrying in ${retryDelay}ms`, { err })
            await delay(retryDelay, null, { ref: false })
            await this.renewToken(retryDelay * 2)
        }
    }

    private async renewLease(leaseId: string, retryDelay = DurationMs.Second): Promise<void> {
        if (!this.vault) {
            return
        }

        this.logger.info('Start vault lease renewing', { leaseId })
        try {
            const { lease_duration: leaseDuration } = await this.vault.write('sys/leases/renew', { lease_id: leaseId })

            this.scheduleLeaseRenewal(leaseId, leaseDuration)
            vaultRequestsTotalMetric.increment({ status: 'success', method: 'renew_lease' })
        } catch (err) {
            if (err instanceof Error && err.message.includes('lease not found')) {
                this.logger.error('Vault lease is revoked. Exiting', { err, leaseId })
                process.emit('SIGINT')

                return
            }

            vaultRequestsTotalMetric.increment({ status: 'failure', method: 'renew_lease' })

            this.logger.error(`Failed to renew vault lease. Retrying in ${retryDelay}ms`, { err, leaseId })
            if (retryDelay > this.renewalMaxDelay) {
                retryDelay = this.renewalMaxDelay
            }

            await delay(retryDelay, null, { ref: false })
            await this.renewLease(leaseId, retryDelay * 2)
        }
    }

    private scheduleTokenRenewal(leaseDuration: number): void {
        setTimeout(async () => await this.renewToken(), this.getRenewalDelay(leaseDuration)).unref()
    }

    private scheduleLeaseRenewal(leaseId: string, leaseDuration: number): void {
        setTimeout(async () => await this.renewLease(leaseId), this.getRenewalDelay(leaseDuration)).unref()
    }

    private getRenewalDelay(leaseDurationS: number): number {
        return leaseDurationS * DurationMs.Second * this.renewalLeaseLifetime
    }

    private async revokeToken(): Promise<void> {
        if (!this.vault) {
            return
        }

        await this.vault.tokenRevokeSelf()
    }
}
