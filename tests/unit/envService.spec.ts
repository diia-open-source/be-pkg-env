import fs from 'node:fs/promises'

import Vault from 'node-vault'

import Logger from '@diia-inhouse/diia-logger'
import { DurationMs } from '@diia-inhouse/types'

import { Env, EnvService } from '../../src'

describe('EnvService', () => {
    const logger = new Logger()
    const defaultEnvs = process.env

    beforeAll(() => {
        jest.useFakeTimers()
    })
    beforeEach(() => {
        jest.resetModules()
        process.env = { ...defaultEnvs }
    })
    afterAll(() => {
        process.env = defaultEnvs
    })

    describe('getVar', () => {
        describe('basic usage', () => {
            it('should be return entire object', () => {
                const envService = new EnvService(logger)
                const envObject = {
                    rabbit: {
                        port: 22022,
                        host: 'localhost',
                    },
                }

                process.env.TEST_ENV_SERVICE_ENTIRE_OBJECT = JSON.stringify(envObject)

                const result = envService.getVar('TEST_ENV_SERVICE_ENTIRE_OBJECT', 'object')

                expect(result).toMatchObject(envObject)
            })

            it('should be return single property', () => {
                const envService = new EnvService(logger)
                const envPort = 3000

                process.env.TEST_ENV_SERVICE_PORT = JSON.stringify(envPort)

                const result = envService.getVar('TEST_ENV_SERVICE_PORT', 'number')

                expect(result).toBe(3000)
            })

            it('should be thrown error while parsing undefined value', () => {
                const envService = new EnvService(logger)
                const result = (): void => {
                    envService.getVar('SOME_OBJECT_HERE', 'boolean')
                }

                expect(result).toThrow('Env variable SOME_OBJECT_HERE is not defined')
            })

            it('should be thrown error while parsing invalid JSON', () => {
                const envService = new EnvService(logger)
                const invalidJSON = '{someProp: 2'

                process.env.TEST_ENV_SERVICE_INVALID_JSON = invalidJSON

                const result = (): void => {
                    envService.getVar('TEST_ENV_SERVICE_INVALID_JSON', 'object')
                }

                expect(result).toThrow(/^Error while parsing TEST_ENV_SERVICE_INVALID_JSON variable. Current value: */)
            })

            it('should be thrown error while checking typeof', () => {
                const envService = new EnvService(logger)
                const envProp = 3003

                process.env.TEST_ENV_SERVICE_PORT = JSON.stringify(envProp)

                const result = (): void => {
                    envService.getVar('TEST_ENV_SERVICE_PORT', 'object')
                }

                expect(result).toThrow('Unexpected typeof TEST_ENV_SERVICE_PORT variable; Current typeof number')
            })
        })

        describe('node_env', () => {
            it('should check environment is local', () => {
                const envService = new EnvService(logger)

                process.env.NODE_ENV = Env.Local

                expect(envService.isLocal()).toBeTruthy()
            })

            it('should check environment is test', () => {
                const envService = new EnvService(logger)

                process.env.NODE_ENV = Env.Test

                expect(envService.isTest()).toBeTruthy()
            })

            it('should check environment is stage', () => {
                const envService = new EnvService(logger)

                process.env.NODE_ENV = Env.Stage

                expect(envService.isStage()).toBeTruthy()
            })

            it('should check environment is dev', () => {
                const envService = new EnvService(logger)

                process.env.NODE_ENV = Env.Dev

                expect(envService.isDev()).toBeTruthy()
            })

            it('should check environment is prod', () => {
                const envService = new EnvService(logger)

                process.env.NODE_ENV = Env.Prod

                expect(envService.isProd()).toBeTruthy()
            })

            it('should return value as is when type string', () => {
                const envService = new EnvService(logger)
                const testMessage = 'test_message'

                process.env.DEFAULT_STRING = testMessage
                const result = envService.getVar('DEFAULT_STRING', 'string')

                expect(result).toStrictEqual(testMessage)
            })
        })

        describe('default value', () => {
            it('should set default value when a target env is absent', () => {
                const envService = new EnvService(logger)
                const result = envService.getVar('DEFAULT_NOT_EXIST', 'number', 100)

                expect(result).toBe(100)
            })

            it('should not set default value when a target env is presented', () => {
                const envService = new EnvService(logger)

                process.env.DEFAULT_EXISTS = '200'
                const result = envService.getVar('DEFAULT_EXISTS', 'number', 100)

                expect(result).toBe(200)
            })

            it('should set default value as null when a target env is absent', () => {
                const envService = new EnvService(logger)
                const result = envService.getVar('DEFAULT_NOT_EXIST', 'number', null)

                expect(result).toBeNull()
            })
        })
    })

    describe('init', () => {
        describe('vault disabled', () => {
            it('should skip init', async () => {
                const envService = new EnvService(logger)

                await expect(envService.init()).resolves.toBeUndefined()
            })
        })

        describe('vault enabled', () => {
            beforeEach(() => {
                process.env.VAULT_ENABLED = 'true'
                process.env.VAULT_ADDR = 'https://vault.example'
                process.env.VAULT_ROLE = 'vault-role'
                process.env.VAULT_RENEWAL_LEASE_LIFETIME = '0.6'
            })

            it('should init Vault', async () => {
                // Arrange
                const envService = new EnvService(logger)
                const readFileSpy = jest.spyOn(fs, 'readFile').mockResolvedValueOnce('k8s-token')
                const vault = <Vault.client>Reflect.get(envService, 'vault')
                const kubernetesLoginSpy = jest
                    .spyOn(vault, 'kubernetesLogin')
                    .mockResolvedValue({ auth: { client_token: 'vault-token', lease_duration: 1000 } })

                // Act
                await envService.init()

                // Assert
                expect(vault.token).toBe('vault-token')
                expect(readFileSpy).toHaveBeenCalled()
                expect(kubernetesLoginSpy).toHaveBeenCalled()
            })

            it('should renew token', async () => {
                // Arrange
                const envService = new EnvService(logger)
                const vault = <Vault.client>Reflect.get(envService, 'vault')

                jest.spyOn(fs, 'readFile').mockResolvedValueOnce('k8s-token')
                jest.spyOn(vault, 'kubernetesLogin').mockResolvedValue({ auth: { client_token: 'vault-token', lease_duration: 120 } })
                jest.spyOn(vault, 'tokenRenewSelf').mockResolvedValueOnce({ auth: { lease_duration: 180 } })
                const setTimeoutSpy = jest.spyOn(global, 'setTimeout')

                // Act & Assert
                await envService.init()
                expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), DurationMs.Second * 120 * 0.6)
                await jest.runOnlyPendingTimersAsync()
                expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), DurationMs.Second * 180 * 0.6)
            })

            it('should reschedule renewal if error happened', async () => {
                // Arrange
                const envService = new EnvService(logger)
                const vault = <Vault.client>Reflect.get(envService, 'vault')

                jest.spyOn(fs, 'readFile').mockResolvedValueOnce('k8s-token')
                jest.spyOn(vault, 'kubernetesLogin').mockResolvedValue({ auth: { client_token: 'vault-token', lease_duration: 120 } })
                jest.spyOn(vault, 'tokenRenewSelf').mockRejectedValueOnce(new Error('vault-error'))
                const setTimeoutSpy = jest.spyOn(global, 'setTimeout')
                const loggerSpy = jest.spyOn(logger, 'error')

                // Act & Assert
                await envService.init()
                expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), DurationMs.Second * 120 * 0.6)

                await jest.runOnlyPendingTimersAsync()
                expect(loggerSpy).toHaveBeenCalledWith(`Failed to renew vault token. Retrying in 1000ms`, { err: new Error('vault-error') })
            })
        })
    })

    describe('getScret', () => {
        describe('vault disabled', () => {
            it('should return env value', async () => {
                const envService = new EnvService(logger)

                process.env.SECRET_ENV = 'secret-env'
                const secret = await envService.getSecret('SECRET_ENV', { accessor: 'accessor' })

                expect(secret).toBe('secret-env')
            })

            it('should throw an error if env is not presented', async () => {
                const envService = new EnvService(logger)

                await expect(envService.getSecret('SECRET_ENV_NOT_EXISTED', { accessor: 'accessor' })).rejects.toThrow(
                    'Env variable SECRET_ENV_NOT_EXISTED is not defined',
                )
            })

            it('should return null if env is not presented and nullable option is true', async () => {
                const envService = new EnvService(logger)

                const secret = await envService.getSecret('SECRET_ENV_NOT_EXISTED', { accessor: 'accessor', nullable: true })

                expect(secret).toBeNull()
            })
        })

        describe('vault enabled', () => {
            beforeEach(() => {
                process.env.VAULT_ENABLED = 'true'
                process.env.VAULT_ADDR = 'https://vault.example'
                process.env.VAULT_ROLE = 'vault-role'
                process.env.SECRET_ENV = 'secret/folder/value'
                process.env.VAULT_RENEWAL_LEASE_LIFETIME = '0.6'
            })
            it('should return actual secret', async () => {
                // Arrange
                const envService = new EnvService(logger)
                const vault = <Vault.client>Reflect.get(envService, 'vault')

                jest.spyOn(vault, 'read').mockResolvedValueOnce({
                    data: { password: 'secret-password' },
                    lease_id: 'lease-id',
                    lease_duration: 3000,
                })

                // Act
                const secret = await envService.getSecret('SECRET_ENV', { accessor: 'password' })

                // Assert
                expect(secret).toBe('secret-password')
            })

            it('should renew lease', async () => {
                // Arrange
                const envService = new EnvService(logger)
                const vault = <Vault.client>Reflect.get(envService, 'vault')

                jest.spyOn(vault, 'read').mockResolvedValueOnce({
                    data: { password: 'secret-password' },
                    lease_id: 'lease-id',
                    lease_duration: 120,
                })
                const setTimeoutSpy = jest.spyOn(global, 'setTimeout')
                const writeSpy = jest.spyOn(vault, 'write').mockResolvedValueOnce({ lease_duration: 180 })

                // Act
                await envService.getSecret('SECRET_ENV', { accessor: 'password' })

                // Assert
                expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), DurationMs.Second * 120 * 0.6)
                await jest.runOnlyPendingTimersAsync()
                expect(writeSpy).toHaveBeenCalledWith('sys/leases/renew', { lease_id: 'lease-id' })
                expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), DurationMs.Second * 180 * 0.6)
            })
        })
    })

    describe('hooks', () => {
        beforeEach(() => {
            process.env.VAULT_ENABLED = 'true'
            process.env.VAULT_ADDR = 'https://vault.example'
            process.env.VAULT_ROLE = 'vault-role'
            process.env.VAULT_RENEWAL_LEASE_LIFETIME = '0.6'
        })
        it('should call vault tokenRevokeSelf only once', async () => {
            // Arrange
            const envService = new EnvService(logger)
            const vault = <Vault.client>Reflect.get(envService, 'vault')

            vault.token = 'vault-token'

            const spy = jest.spyOn(vault, 'tokenRevokeSelf').mockResolvedValueOnce({})

            // Act
            await envService.onDestroy()
            await envService.onBeforeApplicationShutdown()

            // Assert
            expect(spy).toHaveBeenCalledTimes(1)
            expect(vault.token).toBe('')
        })
    })
})
