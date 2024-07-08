import fs from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'

import get from 'lodash.get'
import Vault from 'node-vault'

import { DurationMs, Logger, OnBeforeApplicationShutdown, OnDestroy } from '@diia-inhouse/types'

import { Env, GetSecretOps } from '../interfaces'
import { vaultRequestsTotalMetric } from '../metrics'

export class EnvService implements OnDestroy, OnBeforeApplicationShutdown {
    private readonly isVaultEnabled = this.getVar('VAULT_ENABLED', 'boolean', false)

    private readonly renewalLeaseLifetime = this.getVar('VAULT_RENEWAL_LEASE_LIFETIME', 'number', 0.6)

    private readonly renewalMaxDelay = this.getVar('VAULT_RENEWAL_MAX_DELAY', 'number', DurationMs.Minute)

    private readonly rawSecrets = new Map<string, Record<string, string>>()

    private vault: Vault.client | null = null

    constructor(private readonly logger: Logger) {
        if (!this.isVaultEnabled) {
            return
        }

        this.vault = Vault({ apiVersion: 'v1', endpoint: this.getVar('VAULT_ADDR') })
    }

    async init(): Promise<void> {
        if (!this.vault) {
            return
        }

        try {
            const tokenPath = this.getVar('KUBERNETES_TOKEN_PATH', 'string', '/var/run/secrets/kubernetes.io/serviceaccount/token')
            const k8sToken = await fs.readFile(tokenPath, 'utf8')
            const loginResult = await this.vault.kubernetesLogin({ role: this.getVar('VAULT_ROLE'), jwt: k8sToken })
            const {
                auth: { client_token: token, lease_duration: leaseDuration, accessor },
            } = loginResult

            this.logger.info('Vault token accessor', { accessor })

            this.vault.token = token
            this.scheduleTokenRenewal(leaseDuration)
        } catch (err) {
            this.logger.error('Failed to init vault', { err })

            throw err
        }
    }

    async getSecret(envName: string, ops: GetSecretOps = {}): Promise<string> {
        const { accessor = `data.${envName}`, nullable } = ops
        const envValue = this.getVar(envName, 'string', nullable ? null : undefined)
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

    async onDestroy(): Promise<void> {
        await this.revokeToken()
    }

    // backward compatibility for diia-app <=14. dii-app >14 uses ordered OnDestroy hooks so onBeforeApplicationShutdown is not needed
    async onBeforeApplicationShutdown(): Promise<void> {
        await this.revokeToken()
    }

    private async revokeToken(): Promise<void> {
        if (!this.vault?.token) {
            return
        }

        this.vault.token = ''
        await this.vault.tokenRevokeSelf()
    }

    getVar(name: string, type: 'boolean', defaultValue?: boolean | null): boolean
    getVar(name: string, type: 'number', defaultValue?: number | null): number
    getVar(name: string, type?: 'string', defaultValue?: string | null): string
    getVar<T extends unknown[]>(name: string, type: 'object', defaultValue?: T | null): T
    getVar<T extends Record<string, unknown>>(name: string, type: 'object', defaultValue?: T | null): T
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getVar(name: string, type: 'string' | 'boolean' | 'number' | 'object' = 'string', defaultValue?: unknown): any {
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

    isLocal(): boolean {
        return this.getEnv() === Env.Local
    }

    isTest(): boolean {
        return this.getEnv() === Env.Test
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
        return <Env>process.env.NODE_ENV
    }
}
